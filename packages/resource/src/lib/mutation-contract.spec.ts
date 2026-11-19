import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpRequest,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
} from '@angular/common/http';
import { type HttpResourceRequest } from '@angular/common/http';
import { PLATFORM_ID, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { guessable, provideTransitionScope } from '@mmstack/primitives';
import { Subject } from 'rxjs';
import {
  type MutationCancelledError,
  mutationResource,
  type MutationResourceOptions,
  provideMutationResourceOptions,
} from './mutation-resource';
import {
  createCircuitBreaker,
  injectQueryCache,
  provideQueryCache,
  ResourceSensors,
} from './util';
import { hashRequest } from './util/hash-request';

type Call = {
  readonly url: string;
  readonly body: unknown;
  readonly res: Subject<HttpEvent<unknown>>;
};
let calls: Call[] = [];
const server = (req: HttpRequest<unknown>) => {
  const res = new Subject<HttpEvent<unknown>>();
  calls.push({ url: req.url, body: req.body, res });
  return res;
};
const ok = (i: number, body: unknown = { ok: true }) => {
  calls[i].res.next(new HttpResponse({ body, status: 200 }));
  calls[i].res.complete();
};
const fail = (i: number) =>
  calls[i].res.error(new HttpErrorResponse({ error: 'nope', status: 500 }));
const bodies = () => calls.map((c) => c.body);

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r));
  }
};

const post =
  (url = 'https://x.test/m') =>
  <T>(body: T) => ({ url, method: 'POST', body });

function make<TMutation, TCTX = void>(
  request: (v: TMutation) => HttpResourceRequest | undefined,
  opts: MutationResourceOptions<unknown, unknown, TMutation, TCTX> = {},
) {
  return TestBed.runInInjectionContext(() =>
    mutationResource<unknown, unknown, TMutation, TCTX>(request, opts),
  );
}

describe('mutationResource contract', () => {
  let online: WritableSignal<boolean>;

  beforeEach(() => {
    calls = [];
    online = signal(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        provideTransitionScope(),
        { provide: ResourceSensors, useValue: { networkStatus: online } },
        provideHttpClient(withNoXsrfProtection(), withInterceptors([server])),
      ],
    });
  });

  describe('a request() that returns undefined cancels the mutation', () => {
    it('mutate() leaves nothing in flight, and the value never fires later', async () => {
      const enabled = signal(false);
      const res = make((n: number) => (enabled() ? post()(n) : undefined));

      res.mutate(1);
      expect(res.current()).toBeNull();
      await flush();
      enabled.set(true);
      await flush();

      expect(calls).toEqual([]);
      expect(res.current()).toBeNull();
    });

    it('a cancelled queue head does not stall the mutations behind it', async () => {
      const res = make((n: number) => (n === 1 ? undefined : post()(n)), {
        queue: true,
      });

      res.mutate(1);
      res.mutate(2);
      await flush();

      expect(bodies()).toEqual([2]);
      expect(res.current()).toBe(2);
    });
  });

  describe('disabled()', () => {
    it('is false while idle and never calls request() with a placeholder', () => {
      const res = make((n: number) => ({
        url: `https://x.test/${n.toFixed(0)}`,
        method: 'POST',
      }));
      expect(() => res.disabled()).not.toThrow();
      expect(res.disabled()).toBe(false);
      expect(res.disabledReason()).toBeNull();
    });

    const reading = (res: {
      disabled(): boolean;
      disabledReason(): unknown;
    }) => [res.disabled(), res.disabledReason()];

    it.each([
      ['success', (_res: { destroy(): void }) => ok(0)],
      ['error', (_res: { destroy(): void }) => fail(0)],
      ['abort', (res: { destroy(): void }) => res.destroy()],
    ] as const)(
      "reads 'in-flight' while a mutation runs and clears on %s",
      async (_how, end) => {
        const res = make((n: number) => post()(n));
        res.mutate(1);
        await flush();
        expect(reading(res)).toEqual([true, 'in-flight']);

        end(res);
        await flush();
        expect(reading(res)).toEqual([false, null]);
      },
    );

    it("offline wins over 'in-flight'", async () => {
      const res = make((n: number) => post()(n));
      res.mutate(1);
      await flush();
      online.set(false);
      expect(reading(res)).toEqual([true, 'offline']);
      online.set(true);
      expect(reading(res)).toEqual([true, 'in-flight']);
    });

    it.each([[true], [{ key: () => 'k' }]] as const)(
      'with queue %o an in-flight mutation does not disable, since mutate() still queues',
      async (queue) => {
        const res = make((n: number) => post()(n), { queue });
        res.mutate(1);
        await flush();
        expect(res.current()).toBe(1);
        expect(reading(res)).toEqual([false, null]);
      },
    );

    it("is true offline, with disabledReason 'offline'", () => {
      const res = make((n: number) => post()(n));
      online.set(false);
      expect([res.disabled(), res.disabledReason()]).toEqual([true, 'offline']);
      online.set(true);
      expect([res.disabled(), res.disabledReason()]).toEqual([false, null]);
    });

    function withTrippedBreaker(timeout: number) {
      const threshold = 2;
      const cb = TestBed.runInInjectionContext(() =>
        createCircuitBreaker({ threshold, timeout }),
      );
      const res = make((n: number) => post()(n), { circuitBreaker: cb });
      for (let i = 0; i < threshold; i++) cb.fail(new Error('down'));
      return res;
    }

    it("is true with an open circuit breaker, with disabledReason 'circuit-open'", async () => {
      const res = withTrippedBreaker(60_000);
      expect(reading(res)).toEqual([true, 'circuit-open']);
    });

    it('a half-open breaker does not disable, and the trial mutation is sent', async () => {
      const res = withTrippedBreaker(30);
      expect(reading(res)).toEqual([true, 'circuit-open']);
      await new Promise((r) => setTimeout(r, 60));
      await flush();
      expect(reading(res)).toEqual([false, null]);

      const sent = calls.length;
      res.mutate(99);
      await flush();
      expect(calls.length).toBe(sent + 1);
      expect(calls.at(-1)?.body).toBe(99);
    });
  });

  describe('destroy()', () => {
    it('a mutateAsync after destroy rejects as destroyed and sends nothing', async () => {
      const res = make((n: number) => post()(n));
      res.destroy();

      const settled = res.mutateAsync(1).then(
        () => 'resolved',
        (e: unknown) => (e as MutationCancelledError).type,
      );
      const timeout = new Promise((r) => setTimeout(() => r('hung'), 50));
      res.mutate(2);
      await flush();

      expect(await Promise.race([settled, timeout])).toBe('destroyed');
      expect(calls).toEqual([]);
    });

    it('does not throw with plain mutate() entries still queued', async () => {
      const res = make((n: number) => post()(n), { queue: true });
      res.mutate(1);
      res.mutate(2);
      await flush();
      expect(() => res.destroy()).not.toThrow();
    });

    it('stops the in-flight request', async () => {
      const res = make((n: number) => post()(n));
      res.mutate(1);
      await flush();
      expect(calls[0].res.observed).toBe(true);
      res.destroy();
      expect(calls[0].res.observed).toBe(false);
    });
  });

  it('provideMutationResourceOptions defaults apply to every mutationResource', async () => {
    TestBed.configureTestingModule({
      providers: [provideMutationResourceOptions({ queue: true })],
    });
    const res = make((n: number) => post()(n));
    res.mutate(1);
    res.mutate(2);
    await flush();
    expect(bodies()).toEqual([1]);

    ok(0);
    await flush();
    expect(bodies()).toEqual([1, 2]);
  });

  it('a failure that was not replayed reports { replayed: false } to onError', async () => {
    const metas: unknown[] = [];
    const res = make((n: number) => post()(n), {
      onError: (_e, _c, meta) => metas.push(meta),
    });
    res.mutate(1);
    await flush();
    fail(0);
    await flush();
    expect(metas).toEqual([{ replayed: false }]);
  });
});

describe('mutationResource contract: equality, hooks, invalidation', () => {
  beforeEach(() => {
    calls = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        provideTransitionScope(),
        provideHttpClient(withNoXsrfProtection(), withInterceptors([server])),
      ],
    });
  });

  describe('request identity', () => {
    it('dedupes an equal mutation fired while one is in flight', async () => {
      const res = make((b: { id: number }) => post()(b));
      res.mutate({ id: 1 });
      await flush();
      res.mutate({ id: 1 });
      await flush();
      expect(calls.length).toBe(1);
    });

    it('triggerOnSameRequest re-sends an equal value', async () => {
      const res = make((b: { id: number }) => post()(b), {
        triggerOnSameRequest: true,
      });
      res.mutate({ id: 1 });
      await flush();
      res.mutate({ id: 1 });
      await flush();
      expect(calls.length).toBe(2);
    });

    it('triggerOnSameRequest re-sends the very same object', async () => {
      const body = { id: 1 };
      const res = make((b: { id: number }) => post()(b), {
        triggerOnSameRequest: true,
      });
      res.mutate(body);
      await flush();
      res.mutate(body);
      await flush();
      expect(calls.length).toBe(2);
    });

    it('a custom equal only ever compares two mutation values', async () => {
      const res = make((b: { tags: number[] }) => post()(b), {
        equal: (a, b) => a.tags.length === b.tags.length,
      });
      res.mutate({ tags: [1] });
      await flush();
      ok(0);
      await flush();
      expect(() => res.mutate({ tags: [2] })).not.toThrow();
      await flush();
      expect(calls.length).toBe(2);
    });

    it('a custom equalRequest only ever compares two requests', async () => {
      const res = make((n: number) => post(`https://x.test/${n}`)(n), {
        equalRequest: (a, b) => a.url === b.url,
      });
      expect(() => res.mutate(1)).not.toThrow();
      await flush();
      ok(0);
      await flush();
      expect(() => res.mutate(2)).not.toThrow();
      await flush();
      expect(calls.map((c) => c.url)).toEqual([
        'https://x.test/1',
        'https://x.test/2',
      ]);
    });
  });

  describe('a newer mutation whose hook throws', () => {
    it('onMutate: the superseded run settles once and its response is ignored', async () => {
      const seen: string[] = [];
      const res = make((v: string) => post()(v), {
        onMutate: (v) => {
          if (v === 'B') throw new Error('nope');
        },
        onSuccess: () => seen.push('success'),
        onSettled: () => seen.push('settled'),
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      res.mutate('A');
      await flush();
      res.mutate('B');
      if (calls[0].res.observed) ok(0);
      await flush();

      expect(seen).toEqual(['settled']);
      expect(res.current()).toBeNull();
      vi.restoreAllMocks();
    });

    it('optimistic: the superseded run settles once and its response is ignored', async () => {
      const seen: string[] = [];
      const res = make((v: string) => post()(v), {
        optimistic: (v) => {
          if (v === 'B') throw new Error('nope');
        },
        onSuccess: () => seen.push('success'),
        onSettled: () => seen.push('settled'),
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      res.mutate('A');
      await flush();
      res.mutate('B');
      if (calls[0].res.observed) ok(0);
      await flush();

      expect(seen).toEqual(['settled']);
      expect(res.current()).toBeNull();
      vi.restoreAllMocks();
    });

    it('a throwing optimistic on a plain mutate() does not throw at the caller', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = make((v: string) => post()(v), {
        optimistic: () => {
          throw new Error('nope');
        },
      });
      expect(() => res.mutate('v')).not.toThrow();
      await flush();
      expect(calls).toEqual([]);
      vi.restoreAllMocks();
    });
  });

  it('authoritative writes made inside optimistic stay after a success', async () => {
    const node = TestBed.runInInjectionContext(() => guessable(signal(0)));
    const res = make((v: number) => post()(v), {
      optimistic: (v, tx) => {
        tx.guess(node, v);
        node.set(v * 10);
      },
    });
    res.mutate(5);
    await flush();
    ok(0, 5);
    await flush();
    expect([node(), node.truth()]).toEqual([50, 50]);
  });

  it('the invalidates function receives the value of the mutation that settled', async () => {
    const cache = TestBed.runInInjectionContext(() => injectQueryCache());
    const resp = (body: unknown) => new HttpResponse({ body, status: 200 });
    const one = hashRequest({ url: '/api/posts/1' });
    const two = hashRequest({ url: '/api/posts/2' });
    cache.store(one, resp(1));
    cache.store(two, resp(2));

    const res = make((m: { id: number }) => post('/api/save')(m), {
      invalidates: (_saved, m) => [`/api/posts/${m.id}`],
    });

    res.mutate({ id: 1 });
    await flush();
    ok(0);
    await flush();
    expect(cache.getUntracked(one)).toBeNull();
    expect(cache.getUntracked(two)).not.toBeNull();

    res.mutate({ id: 2 });
    await flush();
    ok(1);
    await flush();
    expect(cache.getUntracked(two)).toBeNull();
  });
});
