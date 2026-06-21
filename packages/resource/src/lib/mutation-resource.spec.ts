import {
  HttpContext,
  HttpContextToken,
  HttpErrorResponse,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
  type HttpRequest,
} from '@angular/common/http';
import { PLATFORM_ID, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { delay, of, throwError } from 'rxjs';
import { MutationCancelledError, mutationResource } from './mutation-resource';
import { injectQueryCache, provideQueryCache, ResourceSensors } from './util';

const TEST_CONTEXT = new HttpContextToken<{
  validate: (req: HttpRequest<any>) => void;
  returnValue: any;
  shouldThrow: boolean;
  delayMs: number;
}>(() => ({
  validate: () => {
    /* noop */
  },
  returnValue: null,
  shouldThrow: false,
  delayMs: 0,
}));

function createTestContext(
  validate: (req: HttpRequest<any>) => void,
  returnValue: any,
  shouldThrow = false,
  delayMs = 0,
) {
  return new HttpContext().set(TEST_CONTEXT, {
    validate,
    returnValue,
    shouldThrow,
    delayMs,
  });
}

const testInterceptor = (req: HttpRequest<any>) => {
  const { validate, shouldThrow, returnValue, delayMs } =
    req.context.get(TEST_CONTEXT);
  validate(req);

  if (shouldThrow) {
    const err$ = throwError(
      () => new HttpErrorResponse({ error: 'Test error', status: 500 }),
    );
    return delayMs ? err$.pipe(delay(delayMs)) : err$;
  }

  const res$ = of(new HttpResponse({ body: returnValue, status: 200 }));
  return delayMs ? res$.pipe(delay(delayMs)) : res$;
};

describe('mutationResource', () => {
  let networkStatusSignal: WritableSignal<boolean>;

  beforeEach(() => {
    networkStatusSignal = signal(true);

    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        {
          provide: ResourceSensors,
          useValue: { networkStatus: networkStatusSignal },
        },
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([testInterceptor]),
        ),
      ],
    });
  });

  it('should execute mutation and call lifecycle hooks with correct context', async () => {
    const hooks: string[] = [];
    let requests = 0;

    // We will await a promise that resolves in onSettled
    const { promise, resolve } = Promise.withResolvers<void>();

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: { id: number }) => ({
          url: `https://example.com/mutate/${body.id}`,
          method: 'POST',
          body,
          context: createTestContext(
            (req) => {
              expect(req.body).toEqual(body);
              requests++;
            },
            { success: true },
          ),
        }),
        {
          onMutate: (value) => {
            hooks.push('onMutate');
            return { originalId: value.id };
          },
          onSuccess: (result, ctx) => {
            hooks.push('onSuccess');
            expect(result).toEqual({ success: true });
            expect(ctx).toEqual({ originalId: 1 });
          },
          onError: () => {
            hooks.push('onError');
          },
          onSettled: (ctx) => {
            hooks.push('onSettled');
            expect(ctx).toEqual({ originalId: 1 });
            resolve();
          },
        },
      ),
    );

    res.mutate({ id: 1 });
    // while mutating, current should be set
    expect(res.current()).toEqual({ id: 1 });

    await promise;

    expect(requests).toBe(1);
    expect(hooks).toEqual(['onMutate', 'onSuccess', 'onSettled']);
    expect(res.current()).toBeNull(); // should be cleared
  });

  it('should call onError when request fails', async () => {
    const hooks: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: any) => ({
          url: 'https://example.com/fail',
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              /* noop */
            },
            null,
            true,
          ),
        }),
        {
          onMutate: () => hooks.push('onMutate'),
          onSuccess: () => hooks.push('onSuccess'),
          onError: () => hooks.push('onError'),
          onSettled: () => {
            hooks.push('onSettled');
            resolve();
          },
        },
      ),
    );

    res.mutate({ data: 'fail' });
    await promise;

    expect(hooks).toEqual(['onMutate', 'onError', 'onSettled']);
  });

  it('invalidates matching cache entries after a successful mutation', async () => {
    const cache = TestBed.runInInjectionContext(() => injectQueryCache());
    const resp = (body: unknown) => new HttpResponse({ body, status: 200 });
    cache.store('GET:/api/posts:json', resp([1, 2]));
    cache.store('GET:/api/posts:json:page=2', resp([3]));
    cache.store('GET:/api/posts/1:json', resp(1));
    cache.store('GET:/api/users:json', resp([]));

    const { promise, resolve } = Promise.withResolvers<void>();

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: { title: string }) => ({
          url: '/api/posts',
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              /* noop */
            },
            { ok: true },
          ),
        }),
        {
          invalidates: ['/api/posts'],
          onSettled: () => resolve(),
        },
      ),
    );

    res.mutate({ title: 'new post' });
    await promise;

    // everything under /api/posts is gone — any params, subpaths
    expect(cache.getUntracked('GET:/api/posts:json')).toBeNull();
    expect(cache.getUntracked('GET:/api/posts:json:page=2')).toBeNull();
    expect(cache.getUntracked('GET:/api/posts/1:json')).toBeNull();
    // unrelated keys survive
    expect(cache.getUntracked('GET:/api/users:json')).not.toBeNull();
  });

  it('settles a superseded in-flight mutation before applying the next one (non-queued)', async () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const settled: unknown[] = [];
    const succeeded: unknown[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: { id: number }) => ({
          url: `https://example.com/mutate/${body.id}`,
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              /* noop */
            },
            { ok: true },
            false,
            50, // keep the first mutation in flight
          ),
        }),
        {
          onMutate: (value) => ({ forId: value.id }),
          onSuccess: (_, ctx) => succeeded.push(ctx),
          onSettled: (ctx) => {
            settled.push(ctx);
            if (settled.length === 2) resolve();
          },
        },
      ),
    );

    res.mutate({ id: 1 }); // in flight (50ms)
    res.mutate({ id: 2 }); // supersedes — regression: id 1's context used to vanish

    await promise;

    // the superseded mutation's context was settled (so optimistic state can be
    // rolled back), then the winning mutation settled normally
    expect(settled).toEqual([{ forId: 1 }, { forId: 2 }]);
    // only the winner gets a success callback
    expect(succeeded).toEqual([{ forId: 2 }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('superseded'),
    );
    warnSpy.mockRestore();
  });

  it('should queue mutations if queue is true', async () => {
    const executions: number[] = [];
    let settledCount = 0;

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: number) => ({
          url: `https://example.com/queue/${body}`,
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              executions.push(body);
            },
            { queued: body },
            false,
            10,
          ), // provide a non-null return value
        }),
        {
          queue: true,
          onSettled: () => {
            settledCount++;
          },
        },
      ),
    );

    res.mutate(1);
    res.mutate(2);
    res.mutate(3);

    for (let i = 0; i < 50; i++) {
      if (settledCount === 3) break;
      await new Promise((r) => setTimeout(r, 10));
      TestBed.tick();
    }

    expect(settledCount).toBe(3);
    // Ordered executions
    expect(executions).toEqual([1, 2, 3]);
  });

  it('clearQueue() discards pending queued mutations; the in-flight one still settles', async () => {
    const executions: number[] = [];
    let settledCount = 0;
    let successCount = 0;

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: number) => ({
          url: `https://example.com/clear/${body}`,
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              executions.push(body);
            },
            { queued: body },
            false,
            50,
          ),
        }),
        {
          queue: true,
          onSuccess: () => {
            successCount++;
          },
          onSettled: () => {
            settledCount++;
          },
        },
      ),
    );

    res.mutate(1);
    res.mutate(2);
    res.mutate(3);

    // let the queue effect dequeue + fire the head request
    for (let i = 0; i < 20 && executions.length < 1; i++) {
      await new Promise((r) => setTimeout(r));
      TestBed.tick();
    }
    expect(executions).toEqual([1]); // only the head is in flight

    res.clearQueue(); // drop pending 2 & 3

    // wait for the in-flight #1 to settle
    for (let i = 0; i < 50; i++) {
      if (settledCount === 1) break;
      await new Promise((r) => setTimeout(r, 10));
      TestBed.tick();
    }

    // give any erroneously-retained queued mutations a chance to fire
    await new Promise((r) => setTimeout(r, 30));
    TestBed.tick();

    expect(executions).toEqual([1]); // 2 & 3 never ran
    expect(successCount).toBe(1); // in-flight #1 still resolved
    expect(settledCount).toBe(1);
  });

  it('queue.key change discards pending queued mutations; the in-flight one still settles', async () => {
    const executions: number[] = [];
    let settledCount = 0;
    let successCount = 0;
    const key = signal('a');

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: number) => ({
          url: `https://example.com/key/${body}`,
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              executions.push(body);
            },
            { queued: body },
            false,
            50,
          ),
        }),
        {
          queue: { key: () => key() },
          onSuccess: () => {
            successCount++;
          },
          onSettled: () => {
            settledCount++;
          },
        },
      ),
    );

    res.mutate(1);
    res.mutate(2);
    res.mutate(3);

    for (let i = 0; i < 20 && executions.length < 1; i++) {
      await new Promise((r) => setTimeout(r));
      TestBed.tick();
    }
    expect(executions).toEqual([1]);

    key.set('b'); // reset the queue → drop pending 2 & 3
    TestBed.tick();

    for (let i = 0; i < 50; i++) {
      if (settledCount === 1) break;
      await new Promise((r) => setTimeout(r, 10));
      TestBed.tick();
    }

    await new Promise((r) => setTimeout(r, 30));
    TestBed.tick();

    expect(executions).toEqual([1]);
    expect(successCount).toBe(1);
    expect(settledCount).toBe(1);
  });

  it('clearQueue() is a noop when the queue is not enabled', () => {
    const res = TestBed.runInInjectionContext(() =>
      mutationResource((body: number) => ({
        url: `https://example.com/noqueue/${body}`,
        method: 'POST',
        body,
        context: createTestContext(() => {
          /* noop */
        }, { ok: true }),
      })),
    );

    expect(() => res.clearQueue()).not.toThrow();
  });

  it('triggerOnSameRequest: an identical mutation fired while one is in flight still triggers a request', async () => {
    // Regression: without this, the mutation's own request-equality dedup swallowed a repeat
    // mutate() with an identical body while one was in flight — so the optimistic update applied
    // but no HTTP fired (the "every other click" symptom). triggerOnSameRequest must defeat it.
    let requests = 0;

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: { id: number }) => ({
          url: 'https://example.com/same',
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              requests++;
            },
            { ok: true },
            false,
            100, // slow response → the first stays in flight while the second is fired
          ),
        }),
        { triggerOnSameRequest: true },
      ),
    );

    res.mutate({ id: 1 });
    for (let i = 0; i < 20 && requests < 1; i++) {
      await new Promise((r) => setTimeout(r));
      TestBed.tick();
    }
    expect(requests).toBe(1); // first request is in flight

    res.mutate({ id: 1 }); // identical body, while #1 has not resolved
    for (let i = 0; i < 50 && requests < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
      TestBed.tick();
    }
    expect(requests).toBe(2); // the identical in-flight repeat still fired
  });

  it('should abort the mutation when onMutate throws (non-queued)', async () => {
    let requests = 0;
    const hooks: string[] = [];

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* suppress dev-mode log */
    });

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: { id: number }) => ({
          url: `https://example.com/throw/${body.id}`,
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              requests++;
            },
            { ok: true },
          ),
        }),
        {
          onMutate: () => {
            hooks.push('onMutate');
            throw new Error('boom');
          },
          onSuccess: () => hooks.push('onSuccess'),
          onError: () => hooks.push('onError'),
          onSettled: () => hooks.push('onSettled'),
        },
      ),
    );

    res.mutate({ id: 1 });

    // Give effects/microtasks a chance to flush — nothing should settle.
    await new Promise((r) => setTimeout(r, 20));
    TestBed.tick();

    expect(requests).toBe(0); // HTTP never fired
    expect(hooks).toEqual(['onMutate']); // only the throwing hook ran
    expect(res.current()).toBeNull();

    errSpy.mockRestore();
  });

  it('should skip a queued mutation when onMutate throws and continue with the rest', async () => {
    const executions: number[] = [];
    let settledCount = 0;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* suppress dev-mode log */
    });

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: number) => ({
          url: `https://example.com/queue-throw/${body}`,
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              executions.push(body);
            },
            { ok: true },
            false,
            10,
          ),
        }),
        {
          queue: true,
          onMutate: (value) => {
            if (value === 2) throw new Error('boom on 2');
          },
          onSettled: () => {
            settledCount++;
          },
        },
      ),
    );

    res.mutate(1);
    res.mutate(2);
    res.mutate(3);

    for (let i = 0; i < 50; i++) {
      if (settledCount === 2) break;
      await new Promise((r) => setTimeout(r, 10));
      TestBed.tick();
    }

    expect(executions).toEqual([1, 3]);
    expect(settledCount).toBe(2);
    expect(res.current()).toBeNull();

    errSpy.mockRestore();
  });

  it('should drain the queue when onMutate throws on the head item', async () => {
    const executions: number[] = [];
    let settledCount = 0;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* suppress dev-mode log */
    });

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: number) => ({
          url: `https://example.com/queue-head-throw/${body}`,
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              executions.push(body);
            },
            { ok: true },
            false,
            10,
          ),
        }),
        {
          queue: true,
          onMutate: (value) => {
            if (value === 1) throw new Error('boom on 1');
          },
          onSettled: () => {
            settledCount++;
          },
        },
      ),
    );

    res.mutate(1);
    res.mutate(2);

    for (let i = 0; i < 50; i++) {
      if (settledCount === 1) break;
      await new Promise((r) => setTimeout(r, 10));
      TestBed.tick();
    }

    expect(executions).toEqual([2]);
    expect(settledCount).toBe(1);

    errSpy.mockRestore();
  });

  it('should fire the request and run lifecycle hooks when mutate(null) is called', async () => {
    const hooks: string[] = [];
    let requests = 0;
    const { promise, resolve } = Promise.withResolvers<void>();

    const res = TestBed.runInInjectionContext(() =>
      mutationResource<{ ok: true }, { ok: true }, null>(
        (body) => ({
          url: 'https://example.com/null-mutate',
          method: 'POST',
          body,
          context: createTestContext(
            (req) => {
              requests++;
              expect(req.body).toBeNull();
            },
            { ok: true },
          ),
        }),
        {
          onMutate: () => {
            hooks.push('onMutate');
          },
          onSuccess: (result) => {
            hooks.push('onSuccess');
            expect(result).toEqual({ ok: true });
          },
          onSettled: () => {
            hooks.push('onSettled');
            resolve();
          },
        },
      ),
    );

    res.mutate(null);
    await promise;

    expect(requests).toBe(1);
    expect(hooks).toEqual(['onMutate', 'onSuccess', 'onSettled']);
    expect(res.current()).toBeNull();
  });

  it('should drain queued mutate(null) calls sequentially', async () => {
    const executions: unknown[] = [];
    let settledCount = 0;

    const res = TestBed.runInInjectionContext(() =>
      mutationResource<{ ok: true }, { ok: true }, null>(
        (body) => ({
          url: 'https://example.com/queue-null',
          method: 'POST',
          body,
          context: createTestContext(
            (req) => {
              executions.push(req.body);
            },
            { ok: true },
            false,
            10,
          ),
        }),
        {
          queue: true,
          onSettled: () => {
            settledCount++;
          },
        },
      ),
    );

    res.mutate(null);
    res.mutate(null);

    for (let i = 0; i < 50; i++) {
      if (settledCount === 2) break;
      await new Promise((r) => setTimeout(r, 10));
      TestBed.tick();
    }

    expect(executions).toEqual([null, null]);
    expect(settledCount).toBe(2);
    expect(res.current()).toBeNull();
  });

  it('should queue mutations while offline and flush them sequentially when online', async () => {
    const executions: number[] = [];
    let settledCount = 0;

    networkStatusSignal.set(false); // start offline

    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: number) => ({
          url: `https://example.com/queue-offline/${body}`,
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              executions.push(body);
            },
            { queued: body },
            false,
            10,
          ),
        }),
        {
          queue: true,
          onSettled: () => {
            settledCount++;
          },
        },
      ),
    );

    res.mutate(1);
    res.mutate(2);

    TestBed.tick();

    // It should have dequeued the first item but pending at network layer
    expect(res.current()).toEqual(1);
    expect(executions.length).toBe(0); // network didn't fire

    // Wait a bit to ensure it really doesn't fire
    await new Promise((r) => setTimeout(r, 40));
    expect(executions.length).toBe(0);

    // Go online!
    networkStatusSignal.set(true);

    // Repeatedly flush effects until settledCount === 2
    for (let i = 0; i < 50; i++) {
      if (settledCount === 2) break;
      await new Promise((r) => setTimeout(r, 10));
      TestBed.tick();
    }

    expect(settledCount).toBe(2);
    // Ordered executions happened after coming online
    expect(executions).toEqual([1, 2]);
  });

  describe('mutateAsync', () => {
    it('resolves with the parsed result on success', async () => {
      const res = TestBed.runInInjectionContext(() =>
        mutationResource((body: { id: number }) => ({
          url: `https://example.com/async/${body.id}`,
          method: 'POST',
          body,
          context: createTestContext(() => {
            /* noop */
          }, { saved: true }),
        })),
      );

      await expect(res.mutateAsync({ id: 1 })).resolves.toEqual({
        saved: true,
      });
      expect(res.current()).toBeNull();
    });

    it('rejects with the error on failure', async () => {
      const res = TestBed.runInInjectionContext(() =>
        mutationResource((body: any) => ({
          url: 'https://example.com/async-fail',
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              /* noop */
            },
            null,
            true,
          ),
        })),
      );

      await expect(res.mutateAsync({ data: 'x' })).rejects.toBeInstanceOf(
        HttpErrorResponse,
      );
    });

    it('still runs lifecycle hooks alongside the promise', async () => {
      const hooks: string[] = [];

      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { id: number }) => ({
            url: `https://example.com/async-hooks/${body.id}`,
            method: 'POST',
            body,
            context: createTestContext(() => {
              /* noop */
            }, { ok: true }),
          }),
          {
            onMutate: () => hooks.push('onMutate'),
            onSuccess: () => hooks.push('onSuccess'),
            onSettled: () => hooks.push('onSettled'),
          },
        ),
      );

      await res.mutateAsync({ id: 1 });
      expect(hooks).toEqual(['onMutate', 'onSuccess', 'onSettled']);
    });

    it('rejects the superseded promise with MutationCancelledError; the winner resolves', async () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      const res = TestBed.runInInjectionContext(() =>
        mutationResource((body: { id: number }) => ({
          url: `https://example.com/async-supersede/${body.id}`,
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              /* noop */
            },
            { id: body.id },
            false,
            50, // keep #1 in flight
          ),
        })),
      );

      const first = res.mutateAsync({ id: 1 });
      const second = res.mutateAsync({ id: 2 }); // supersedes #1

      const err = (await first.catch((e) => e)) as MutationCancelledError;
      expect(err).toBeInstanceOf(MutationCancelledError);
      expect(err.type).toBe('superseded');
      await expect(second).resolves.toEqual({ id: 2 });

      warnSpy.mockRestore();
    });

    it('rejects with the thrown error when onMutate throws', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const boom = new Error('boom');

      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { id: number }) => ({
            url: `https://example.com/async-throw/${body.id}`,
            method: 'POST',
            body,
            context: createTestContext(() => {
              /* noop */
            }, { ok: true }),
          }),
          {
            onMutate: () => {
              throw boom;
            },
          },
        ),
      );

      await expect(res.mutateAsync({ id: 1 })).rejects.toBe(boom);
      expect(res.current()).toBeNull();

      errSpy.mockRestore();
    });

    it('rejects with MutationCancelledError when request() returns undefined', async () => {
      const res = TestBed.runInInjectionContext(() =>
        mutationResource<{ ok: true }, { ok: true }, number>((body) =>
          body > 0
            ? {
                url: `https://example.com/async-undef/${body}`,
                method: 'POST',
                body,
                context: createTestContext(() => {
                  /* noop */
                }, { ok: true }),
              }
            : undefined,
        ),
      );

      const err = (await res
        .mutateAsync(0)
        .catch((e) => e)) as MutationCancelledError;
      expect(err).toBeInstanceOf(MutationCancelledError);
      expect(err.type).toBe('no-request');
      expect(res.current()).toBeNull();
    });

    it('resolves each queued mutation in order', async () => {
      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: number) => ({
            url: `https://example.com/async-queue/${body}`,
            method: 'POST',
            body,
            context: createTestContext(
              () => {
                /* noop */
              },
              { n: body },
              false,
              10,
            ),
          }),
          { queue: true },
        ),
      );

      const results: unknown[] = [];
      const p1 = res.mutateAsync(1).then((r) => results.push(r));
      const p2 = res.mutateAsync(2).then((r) => results.push(r));

      for (let i = 0; i < 50; i++) {
        if (results.length === 2) break;
        await new Promise((r) => setTimeout(r, 10));
        TestBed.tick();
      }

      await Promise.all([p1, p2]);
      expect(results).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('rejects queued promises dropped by clearQueue; the in-flight one resolves', async () => {
      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: number) => ({
            url: `https://example.com/async-clear/${body}`,
            method: 'POST',
            body,
            context: createTestContext(
              () => {
                /* noop */
              },
              { n: body },
              false,
              50,
            ),
          }),
          { queue: true },
        ),
      );

      const p1 = res.mutateAsync(1);
      const p2 = res.mutateAsync(2);
      const p3 = res.mutateAsync(3);

      // let the head dequeue + fire
      for (let i = 0; i < 20 && res.current() === null; i++) {
        await new Promise((r) => setTimeout(r));
        TestBed.tick();
      }

      res.clearQueue(); // drop pending 2 & 3

      await expect(p2).rejects.toMatchObject({ type: 'queue-cleared' });
      await expect(p3).rejects.toMatchObject({ type: 'queue-cleared' });
      await expect(p1).resolves.toEqual({ n: 1 });
    });

    it('rejects pending promises with type "queue-key-changed" on a key change', async () => {
      const key = signal('a');
      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: number) => ({
            url: `https://example.com/async-key/${body}`,
            method: 'POST',
            body,
            context: createTestContext(
              () => {
                /* noop */
              },
              { n: body },
              false,
              50,
            ),
          }),
          { queue: { key: () => key() } },
        ),
      );

      const p1 = res.mutateAsync(1);
      const p2 = res.mutateAsync(2);

      // let the head dequeue + fire
      for (let i = 0; i < 20 && res.current() === null; i++) {
        await new Promise((r) => setTimeout(r));
        TestBed.tick();
      }

      key.set('b'); // reset the queue → drop pending 2
      TestBed.tick();

      await expect(p2).rejects.toMatchObject({ type: 'queue-key-changed' });
      await expect(p1).resolves.toEqual({ n: 1 });
    });

    it('rejects an outstanding promise when the resource is destroyed', async () => {
      const res = TestBed.runInInjectionContext(() =>
        mutationResource((body: { id: number }) => ({
          url: `https://example.com/async-destroy/${body.id}`,
          method: 'POST',
          body,
          context: createTestContext(
            () => {
              /* noop */
            },
            { ok: true },
            false,
            50,
          ),
        })),
      );

      const pending = res.mutateAsync({ id: 1 });
      res.destroy();

      const err = (await pending.catch((e) => e)) as MutationCancelledError;
      expect(err).toBeInstanceOf(MutationCancelledError);
      expect(err.type).toBe('destroyed');
    });
  });
});
