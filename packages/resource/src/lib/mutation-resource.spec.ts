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
import { hashRequest } from './util/hash-request';

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
    expect(res.current()).toEqual({ id: 1 });

    await promise;

    expect(requests).toBe(1);
    expect(hooks).toEqual(['onMutate', 'onSuccess', 'onSettled']);
    expect(res.current()).toBeNull();
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
    const list = hashRequest({ url: '/api/posts' });
    const listPage2 = hashRequest({ url: '/api/posts', params: { page: '2' } });
    const detail = hashRequest({ url: '/api/posts/1' });
    const search = hashRequest({ method: 'POST', url: '/api/posts', body: { q: 'x' } });
    const users = hashRequest({ url: '/api/users' });
    cache.store(list, resp([1, 2]));
    cache.store(listPage2, resp([3]));
    cache.store(detail, resp(1));
    cache.store(search, resp([1]));
    cache.store(users, resp([]));

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

    expect(cache.getUntracked(list)).toBeNull();
    expect(cache.getUntracked(listPage2)).toBeNull();
    expect(cache.getUntracked(detail)).toBeNull();
    expect(cache.getUntracked(search)).toBeNull();
    expect(cache.getUntracked(users)).not.toBeNull();
  });

  it('invalidates namespace-prefixed keys (custom hash) via invalidateMatcher', async () => {
    const cache = TestBed.runInInjectionContext(() => injectQueryCache());
    const resp = (body: unknown) => new HttpResponse({ body, status: 200 });
    cache.store('tenant-7|url=/api/posts', resp([1, 2]));
    cache.store('tenant-7|url=/api/users', resp([]));

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
          invalidateMatcher: (urlPrefix) => (key) =>
            key.includes(`|url=${urlPrefix}`),
          onSettled: () => resolve(),
        },
      ),
    );

    res.mutate({ title: 'new post' });
    await promise;

    expect(cache.getUntracked('tenant-7|url=/api/posts')).toBeNull();
    expect(cache.getUntracked('tenant-7|url=/api/users')).not.toBeNull();
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
            50,
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

    res.mutate({ id: 1 });
    res.mutate({ id: 2 });

    await promise;

    expect(settled).toEqual([{ forId: 1 }, { forId: 2 }]);
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
    res.mutate(3);

    for (let i = 0; i < 50; i++) {
      if (settledCount === 3) break;
      await new Promise((r) => setTimeout(r, 10));
      TestBed.tick();
    }

    expect(settledCount).toBe(3);
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

    for (let i = 0; i < 20 && executions.length < 1; i++) {
      await new Promise((r) => setTimeout(r));
      TestBed.tick();
    }
    expect(executions).toEqual([1]);

    res.clearQueue();

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

    key.set('b');
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
            100,
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
    expect(requests).toBe(1);

    res.mutate({ id: 1 });
    for (let i = 0; i < 50 && requests < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
      TestBed.tick();
    }
    expect(requests).toBe(2);
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

    await new Promise((r) => setTimeout(r, 20));
    TestBed.tick();

    expect(requests).toBe(0);
    expect(hooks).toEqual(['onMutate']);
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

    networkStatusSignal.set(false);

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

    expect(res.current()).toEqual(1);
    expect(executions.length).toBe(0);

    await new Promise((r) => setTimeout(r, 40));
    expect(executions.length).toBe(0);

    networkStatusSignal.set(true);

    for (let i = 0; i < 50; i++) {
      if (settledCount === 2) break;
      await new Promise((r) => setTimeout(r, 10));
      TestBed.tick();
    }

    expect(settledCount).toBe(2);
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
            50,
          ),
        })),
      );

      const first = res.mutateAsync({ id: 1 });
      const second = res.mutateAsync({ id: 2 });

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

      for (let i = 0; i < 20 && res.current() === null; i++) {
        await new Promise((r) => setTimeout(r));
        TestBed.tick();
      }

      res.clearQueue();

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

      for (let i = 0; i < 20 && res.current() === null; i++) {
        await new Promise((r) => setTimeout(r));
        TestBed.tick();
      }

      key.set('b');
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

  describe('request contract — body transforms & optional body', () => {
    type ApplicationDef = { id: string; name: string };
    type ApplicationSummary = { id: string; version: number; '@type': string };

    it('maps typed params to a transformed (FormData) body and flows onMutate ctx to onError/onSuccess', async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      let bodyWasFormData = false;

      const summaries = signal<ApplicationSummary[]>([]);

      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          ({
            app,
            summary,
          }: {
            app: ApplicationDef;
            summary: ApplicationSummary;
          }) => {
            const fd = new FormData();
            fd.append('app', JSON.stringify(app));
            fd.append(summary['@type'], JSON.stringify(summary));

            return {
              url: 'https://example.com/resources/multipart',
              method: 'POST',
              body: fd,
              context: createTestContext((req) => {
                bodyWasFormData = req.body instanceof FormData;
              }, { ok: true }),
            };
          },
          {
            onMutate: ({ summary }) => {
              const prev = summaries();
              summaries.set([...prev, summary]);
              return prev;
            },
            onError: (_err, prev) => summaries.set(prev),
            onSuccess: (_result, prev) => {
              const typed: ApplicationSummary[] = prev;
              expect(Array.isArray(typed)).toBe(true);
            },
            onSettled: () => resolve(),
          },
        ),
      );

      res.mutate({
        app: { id: 'a', name: 'A' },
        summary: { id: 's', version: 1, '@type': 'Foo' },
      });

      await promise;
      expect(bodyWasFormData).toBe(true);
    });

    it('allows a bodyless POST', async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      let fired = false;

      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          (id: string) => ({
            url: `https://example.com/posts/${id}/publish`,
            method: 'POST',
            context: createTestContext(() => {
              fired = true;
            }, { ok: true }),
          }),
          { onSettled: () => resolve() },
        ),
      );

      res.mutate('123');
      await promise;
      expect(fired).toBe(true);
    });

    it('allows a bodyless DELETE', async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      let fired = false;

      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          (id: string) => ({
            url: `https://example.com/posts/${id}`,
            method: 'DELETE',
            context: createTestContext(() => {
              fired = true;
            }, { ok: true }),
          }),
          { onSettled: () => resolve() },
        ),
      );

      res.mutate('123');
      await promise;
      expect(fired).toBe(true);
    });
  });
});
