import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpRequest,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
} from '@angular/common/http';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { mutationResource } from './mutation-resource';
import { provideQueryCache } from './util';

type Call = {
  readonly body: unknown;
  readonly res: Subject<HttpEvent<unknown>>;
};
let calls: Call[] = [];
const server = (req: HttpRequest<unknown>) => {
  const res = new Subject<HttpEvent<unknown>>();
  calls.push({ body: req.body, res });
  return res;
};
const failLast = () => {
  const i = calls.length - 1;
  calls[i].res.error(
    new HttpErrorResponse({ error: `down ${i}`, status: 500 }),
  );
};
const errorText = (e: unknown) => (e as HttpErrorResponse | undefined)?.error;

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r));
  }
};

function setup(threshold: number, queue: boolean, retry = 0) {
  const seen = { errors: [] as unknown[], settled: 0 };
  const res = TestBed.runInInjectionContext(() =>
    mutationResource<unknown, unknown, number>(
      (n) => ({ url: 'https://x.test/m', method: 'POST', body: n }),
      {
        queue,
        retry: { max: retry, backoff: 1 },
        circuitBreaker: { threshold, timeout: 60_000 },
        onError: (e) => seen.errors.push(errorText(e)),
        onSettled: () => (seen.settled += 1),
      },
    ),
  );
  return { res, seen };
}

describe('mutationResource: a failure that trips the circuit breaker', () => {
  beforeEach(() => {
    calls = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        provideHttpClient(withNoXsrfProtection(), withInterceptors([server])),
      ],
    });
  });

  describe.each([
    ['queue off', false],
    ['queue on', true],
  ] as const)('%s', (_label, queue) => {
    it.each([[1], [3]])(
      'mutate(): settles with the tripping error when the threshold (%i) is reached',
      async (threshold) => {
        const { res, seen } = setup(threshold, queue);
        for (let i = 0; i < threshold; i++) {
          res.mutate(i);
          await flush();
          failLast();
          await flush();
        }
        const tripping = `down ${threshold - 1}`;

        expect(seen.errors).toEqual(
          Array.from({ length: threshold }, (_, i) => `down ${i}`),
        );
        expect(seen.settled).toBe(threshold);
        expect(errorText(res.lastFailure()?.error)).toBe(tripping);
        expect(res.current()).toBeNull();
        expect(res.disabledReason()).toBe('circuit-open');
      },
    );

    it('mutateAsync(): rejects with the tripping error', async () => {
      const { res, seen } = setup(1, queue);
      const outcome = res.mutateAsync(1).then(
        () => 'resolved',
        (e: unknown) => errorText(e),
      );
      await flush();
      failLast();
      await flush();
      const timeout = new Promise((r) => setTimeout(() => r('hung'), 50));

      expect(await Promise.race([outcome, timeout])).toBe('down 0');
      expect(seen.settled).toBe(1);
      expect(res.current()).toBeNull();
      expect(res.disabledReason()).toBe('circuit-open');
    });
  });

  it('with the queue on, the next queued mutation waits while the breaker is open', async () => {
    const { res, seen } = setup(1, true);
    res.mutate(1);
    res.mutate(2);
    await flush();
    failLast();
    await flush();
    expect(calls.map((c) => c.body)).toEqual([1]);
    expect([seen.errors, seen.settled]).toEqual([['down 0'], 1]);
    expect([res.current(), res.disabledReason()]).toEqual([2, 'circuit-open']);
  });

  it('with retries, it settles once, on the attempt that trips the breaker', async () => {
    const { res, seen } = setup(2, false, 3);
    res.mutate(1);
    await flush();
    failLast();
    await flush();
    await new Promise((r) => setTimeout(r, 10));
    await flush();
    expect(calls.length).toBe(2);
    failLast();
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    await flush();

    expect(calls.length).toBe(2);
    expect(seen.errors).toEqual(['down 1']);
    expect(seen.settled).toBe(1);
    expect(res.current()).toBeNull();
    expect(res.disabledReason()).toBe('circuit-open');
  });

  it('with retries and a closed breaker, it settles once, on the final attempt', async () => {
    const { res, seen } = setup(10, false, 1);
    res.mutate(1);
    await flush();
    failLast();
    await flush();
    await new Promise((r) => setTimeout(r, 10));
    await flush();
    expect(calls.length).toBe(2);
    expect(seen.settled).toBe(0);
    failLast();
    await flush();

    expect(seen.errors).toEqual(['down 1']);
    expect(seen.settled).toBe(1);
    expect(res.current()).toBeNull();
  });
});
