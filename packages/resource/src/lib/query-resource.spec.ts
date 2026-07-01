import {
  HttpContext,
  HttpContextToken,
  HttpErrorResponse,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { providePaused, until } from '@mmstack/primitives';
import { of, throwError } from 'rxjs';
import { queryResource } from './query-resource';
import {
  createCacheInterceptor,
  createDedupeRequestsInterceptor,
  provideMockQueryCache,
  provideMockResourceSensors,
  provideQueryCache,
  ResourceSensors,
  injectQueryCache,
} from './util';

const TEST_CONTEXT = new HttpContextToken<{
  validate: (req: HttpRequest<any>) => void;
  returnValue: any;
  shouldThrow: boolean;
}>(() => ({
  validate: () => {
    // noop
  },
  returnValue: null,
  shouldThrow: false,
}));

function createTestContext(
  validate: (req: HttpRequest<any>) => void,
  returnValue: any,
  shouldThrow = false,
) {
  return new HttpContext().set(TEST_CONTEXT, {
    validate,
    returnValue,
    shouldThrow,
  });
}

const testInterceptor: HttpInterceptorFn = (req) => {
  const { validate, shouldThrow, returnValue } = req.context.get(TEST_CONTEXT);
  validate(req);
  if (shouldThrow) {
    return throwError(
      () =>
        new HttpErrorResponse({
          error: 'Test error',
          status: 500,
        }),
    );
  }
  return of(new HttpResponse({ body: returnValue, status: 200 }));
};

describe('queryResource', () => {
  let networkStatusSignal: WritableSignal<boolean>;
  let pageVisibilitySignal: WritableSignal<DocumentVisibilityState>;

  beforeEach(() => {
    networkStatusSignal = signal(true);
    pageVisibilitySignal = signal<DocumentVisibilityState>('visible');

    TestBed.configureTestingModule({
      providers: [
        {
          provide: PLATFORM_ID,
          useValue: 'browser',
        },
        provideQueryCache(),
        {
          provide: ResourceSensors,
          useValue: {
            networkStatus: networkStatusSignal,
            pageVisibility: pageVisibilitySignal,
          },
        },
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([
            createCacheInterceptor(),
            createDedupeRequestsInterceptor(),
            testInterceptor,
          ]),
        ),
      ],
    });
  });

  it('should create a resource', () => {
    const res = TestBed.runInInjectionContext(() => queryResource(() => ''));
    expect(res).toBeTruthy();
  });

  it('should call the provided url with a get request when a string is provided', async () => {
    const url = 'https://example.com';
    const validate = (req: HttpRequest<any>) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe(url);
    };

    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => ({
        url,
        context: createTestContext(validate, { data: 'test' }),
      })),
    );

    const result = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(result).toEqual({ data: 'test' });
  });

  it('should throw an error if the request fails', async () => {
    const url = 'https://example.com';
    const validate = (req: HttpRequest<any>) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe(url);
    };

    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => ({
        url,
        context: createTestContext(validate, null, true),
      })),
    );

    try {
      throw await TestBed.runInInjectionContext(() =>
        until(res.error, (v) => v !== undefined),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(HttpErrorResponse);
      if (error instanceof HttpErrorResponse) {
        expect(error.status).toBe(500);
        expect(error.error).toBe('Test error');
      }
    }
  });

  it('should not throw the value if the request fails', async () => {
    const url = 'https://example.com';
    const validate = (req: HttpRequest<any>) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe(url);
    };

    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => ({
        url,
        context: createTestContext(validate, { data: 'test' }, true),
      })),
    );

    await TestBed.runInInjectionContext(() =>
      until(res.error, (v) => v !== undefined),
    );
    expect(res.value()).toBeUndefined();
  });

  it('should go offline and re-online correctly', async () => {
    let requests = 0;
    const url = 'https://example.com/offline-test';
    const validate = () => {
      requests++;
    };

    // Start offline
    networkStatusSignal.set(false);

    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => ({
        url,
        context: createTestContext(validate, { data: 'offline-test' }),
      })),
    );

    // It should immediately be disabled
    expect(res.disabled()).toBe(true);

    // An explicit reload should be a no-op when disabled
    try {
      await res.reload();
    } catch {
      // Just in case reload throws when disabled
    }
    expect(requests).toBe(0);
    expect(res.value()).toBeUndefined();

    // Re-online
    networkStatusSignal.set(true);
    expect(res.disabled()).toBe(false);

    // It should automatically perform the fetch now
    const result = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(result).toEqual({ data: 'offline-test' });
    expect(requests).toBe(1);
  });

  it('should be disabled unconditionally if the request function returns undefined', () => {
    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => undefined),
    );
    expect(res.disabled()).toBe(true);
    expect(res.disabledReason()).toBe('no-request');
  });

  it('reports disabledReason as offline when network is unavailable', () => {
    networkStatusSignal.set(false);
    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => ({ url: 'https://example.com' })),
    );
    expect(res.disabled()).toBe(true);
    expect(res.disabledReason()).toBe('offline');
  });

  it('reports disabledReason as null when fully enabled', () => {
    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => ({
        url: 'https://example.com',
        context: createTestContext(
          () => {
            // noop
          },
          { data: 'ok' },
        ),
      })),
    );
    expect(res.disabledReason()).toBeNull();
  });

  it('should call onError callback in an effect when request fails', async () => {
    let onErrorCalled = false;
    let errorReceived: any;
    const url = 'https://example.com/onerror';

    const res = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(
            () => {
              /* noop */
            },
            null,
            true,
          ),
        }),
        {
          onError: (err) => {
            onErrorCalled = true;
            errorReceived = err;
          },
        },
      ),
    );

    try {
      await TestBed.runInInjectionContext(() =>
        until(res.error, (v) => v !== undefined),
      );
    } catch {
      // Ignored
    }

    TestBed.tick();
    expect(onErrorCalled).toBe(true);
    expect(errorReceived).toBeDefined();
  });

  it('should preserve previous value when keepPrevious is true and request URL changes', async () => {
    let returnData = { data: 'first' };
    const requestSignal = signal<any>({
      url: 'https://example.com/keep-prev-1',
      context: createTestContext(() => {
        /* noop */
      }, returnData),
    });

    const res = TestBed.runInInjectionContext(() =>
      queryResource(requestSignal, { keepPrevious: true }),
    );

    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(res.value()).toEqual({ data: 'first' });

    // Change request to a new URL
    returnData = { data: 'second' };
    requestSignal.set({
      url: 'https://example.com/keep-prev-2',
      context: createTestContext(() => {
        /* noop */
      }, returnData),
    });

    // We change the request, which triggers a reload, but prior value is synchronously kept
    expect(res.value()).toEqual({ data: 'first' });

    // Wait for the new value to resolve
    await TestBed.runInInjectionContext(() =>
      until(res.value, (v: any) => v?.data === 'second'),
    );
    expect(res.value()).toEqual({ data: 'second' });
  });

  it('should fetch again with new identical request objects if triggerOnSameRequest is true', async () => {
    let requests = 0;
    const url = 'https://example.com/trigger-same';
    const validate = () => {
      requests++;
    };

    // identical contents, distinct references
    const reqObj1 = {
      url,
      context: createTestContext(validate, { data: 'test' }),
    };
    const reqObj2 = {
      url,
      context: createTestContext(validate, { data: 'test' }),
    };

    const reqSignal = signal<any>(reqObj1);

    const res = TestBed.runInInjectionContext(() =>
      queryResource(reqSignal, { triggerOnSameRequest: true }),
    );

    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(requests).toBe(1);

    // Provide new object (identical fields)
    reqSignal.set(reqObj2);

    // allow microtasks to trigger the new request fetch cycle
    await new Promise((r) => setTimeout(r, 10));
    expect(requests).toBe(2);
  });

  it('should open circuit breaker after multiple failures', async () => {
    const url = 'https://example.com/circuit';
    const validate = () => {
      // ignore
    };

    const res = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(validate, null, true),
        }),
        { circuitBreaker: true },
      ),
    );

    // Initial load throws
    try {
      await TestBed.runInInjectionContext(() =>
        until(res.error, (v) => v !== undefined),
      );
    } catch {
      // Ignored
    }

    TestBed.tick();

    // Default circuit breaker threshold is 5, we did 1, so 4 more
    for (let i = 0; i < 4; i++) {
      try {
        await res.reload();
      } catch {
        // Let it fail
      }
      TestBed.tick();
    }

    // Now circuit breaker should be open and the resource should be disabled
    await TestBed.runInInjectionContext(() =>
      until(res.disabled, (v) => v === true),
    );
    expect(res.disabled()).toBe(true);
  });

  it('PAUSED holds the value and defers a dependency-change refetch until resume', async () => {
    let requests = 0;
    const hidden = signal(false);
    const id = signal(1);

    const res = TestBed.runInInjectionContext(() =>
      queryResource<{ id: number }>(
        (ctx) =>
          hidden()
            ? ctx.paused
            : {
                url: `https://example.com/api/${id()}`,
                context: createTestContext(() => requests++, { id: id() }),
              },
        { keepPrevious: true },
      ),
    );

    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(requests).toBe(1);
    expect(res.value()).toEqual({ id: 1 });

    // pause, then change the dependency — must NOT refetch while paused; value held
    hidden.set(true);
    id.set(2);
    TestBed.tick();
    await Promise.resolve();
    expect(requests).toBe(1);
    expect(res.value()).toEqual({ id: 1 });

    // resume → the deferred change now refetches
    hidden.set(false);
    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => (v as { id: number } | undefined)?.id === 2),
    );
    expect(requests).toBe(2);
    expect(res.value()).toEqual({ id: 2 });
  });

  it('does not refetch on resume when the request is unchanged', async () => {
    let requests = 0;
    const hidden = signal(false);
    // stable request object → unchanged across pause/resume
    const reqObj = {
      url: 'https://example.com/api/stable',
      context: createTestContext(() => requests++, { ok: true }),
    };

    const res = TestBed.runInInjectionContext(() =>
      queryResource<{ ok: boolean }>(
        (ctx) => (hidden() ? ctx.paused : reqObj),
        {
          keepPrevious: true,
        },
      ),
    );

    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(requests).toBe(1);

    hidden.set(true);
    TestBed.tick();
    await Promise.resolve();
    hidden.set(false);
    TestBed.tick();
    await Promise.resolve();

    expect(requests).toBe(1); // unchanged request → no refetch on resume
    expect(res.value()).toEqual({ ok: true });
  });

  it('should fetch data when prefetch is called and serve from cache', async () => {
    let requests = 0;
    const url = 'https://example.com/prefetch';
    const validate = () => {
      requests++;
    };

    const reqSignal = signal<any>(undefined);

    const res = TestBed.runInInjectionContext(() =>
      queryResource(reqSignal, { cache: { staleTime: 10000 } }),
    );

    expect(requests).toBe(0);

    // Prefetch triggers the initial caching
    await res.prefetch({
      url,
      context: createTestContext(validate, { data: 'prefetch-data' }),
    });
    expect(requests).toBe(1);

    // Enable resource with the same request signature
    reqSignal.set({
      url,
      context: createTestContext(validate, { data: 'prefetch-data' }),
    });

    const result = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );

    // Gets prefetch value instantly, and request count is not incremented
    expect(result).toEqual({ data: 'prefetch-data' });
    expect(requests).toBe(1);
  });

  it('should cache consecutive identical queries', async () => {
    let requests = 0;
    const url = 'https://example.com/caching';
    const validate = () => {
      requests++;
    };

    const res = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(validate, { data: 'cache-data' }),
        }),
        { cache: { staleTime: 10000 } },
      ),
    );

    const result = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(result).toEqual({ data: 'cache-data' });
    expect(requests).toBe(1);

    // Wait slightly to ensure caching effect processed
    const res2 = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(validate, { data: 'cache-data' }),
        }),
        { cache: { staleTime: 10000 } },
      ),
    );

    const result2 = await TestBed.runInInjectionContext(() =>
      until(res2.value, (v) => v !== undefined),
    );
    expect(result2).toEqual({ data: 'cache-data' });

    // The request was intercepted and deduplicated/served from cache
    expect(requests).toBe(1);
  });

  it('should reflect value.set writes on a cached resource (not return stale cached body)', async () => {
    const url = 'https://example.com/value-set-cached';
    const res = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(
            () => {
              /* noop */
            },
            { data: 'server' },
          ),
        }),
        { cache: { staleTime: 10000 } },
      ),
    );

    const initial = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(initial).toEqual({ data: 'server' });

    res.value.set({ data: 'local' } as any);
    TestBed.tick();
    expect(res.value()).toEqual({ data: 'local' });
  });

  it('should reflect value.update writes on a cached resource', async () => {
    const url = 'https://example.com/value-update-cached';
    const res = TestBed.runInInjectionContext(() =>
      queryResource<{ data: string }>(
        () => ({
          url,
          context: createTestContext(
            () => {
              /* noop */
            },
            { data: 'server' },
          ),
        }),
        { cache: { staleTime: 10000 } },
      ),
    );

    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );

    res.value.update((prev) => ({ data: `${prev?.data}-updated` }));
    TestBed.tick();
    expect(res.value()).toEqual({ data: 'server-updated' });
  });

  it('should propagate top-level set into the cache so another consumer sees it', async () => {
    const url = 'https://example.com/set-propagates-cache';
    const resA = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(
            () => {
              /* noop */
            },
            { data: 'server' },
          ),
        }),
        { cache: { staleTime: 10000 } },
      ),
    );

    await TestBed.runInInjectionContext(() =>
      until(resA.value, (v) => v !== undefined),
    );

    resA.set({ data: 'mutated' } as any);
    TestBed.tick();

    const resB = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(
            () => {
              /* noop */
            },
            { data: 'server' },
          ),
        }),
        { cache: { staleTime: 10000 } },
      ),
    );

    const seen = await TestBed.runInInjectionContext(() =>
      until(resB.value, (v) => v !== undefined),
    );
    expect(seen).toEqual({ data: 'mutated' });
  });

  describe('refresh triggers', () => {
    async function settle() {
      for (let i = 0; i < 4; i++) {
        TestBed.tick();
        await new Promise((r) => setTimeout(r));
      }
      TestBed.tick();
    }

    it('onFocus: refetches on the hidden → visible transition only', async () => {
      let requests = 0;

      const res = TestBed.runInInjectionContext(() =>
        queryResource(
          () => ({
            url: 'https://example.com/focus',
            context: createTestContext(() => {
              requests++;
            }, { ok: true }),
          }),
          { refresh: { onFocus: true } },
        ),
      );

      await TestBed.runInInjectionContext(() =>
        until(res.value, (v) => v !== undefined),
      );
      expect(requests).toBe(1);

      pageVisibilitySignal.set('hidden');
      await settle();
      expect(requests).toBe(1); // hiding must not refetch

      pageVisibilitySignal.set('visible');
      await settle();
      expect(requests).toBe(2); // regaining focus refetches
    });

    it('onReconnect: refetches when the browser comes back online', async () => {
      let requests = 0;

      const res = TestBed.runInInjectionContext(() =>
        queryResource(
          () => ({
            url: 'https://example.com/reconnect',
            context: createTestContext(() => {
              requests++;
            }, { ok: true }),
          }),
          { refresh: { onReconnect: true } },
        ),
      );

      await TestBed.runInInjectionContext(() =>
        until(res.value, (v) => v !== undefined),
      );
      expect(requests).toBe(1);

      networkStatusSignal.set(false);
      await settle();
      expect(requests).toBe(1); // going offline must not refetch

      networkStatusSignal.set(true);
      await settle();
      expect(requests).toBe(2); // back online refetches
    });
  });

  describe('auto-pausing (pause option)', () => {
    async function settle() {
      for (let i = 0; i < 4; i++) {
        TestBed.tick();
        await new Promise((r) => setTimeout(r));
      }
      TestBed.tick();
    }

    it('pause: predicate holds the resource while paused, no refetch on resume', async () => {
      let requests = 0;
      const paused = signal(true);

      const res = TestBed.runInInjectionContext(() =>
        queryResource(
          () => ({
            url: 'https://example.com/paused',
            context: createTestContext(() => {
              requests++;
            }, { ok: true }),
          }),
          { pause: paused },
        ),
      );

      await settle();
      expect(requests).toBe(0); // created paused → nothing fetched
      expect(res.disabledReason()).toBe('no-request');

      paused.set(false);
      await settle();
      expect(requests).toBe(1); // unpaused → fetched
      expect(res.value()).toEqual({ ok: true });

      paused.set(true);
      await settle();
      expect(res.value()).toEqual({ ok: true }); // value held while paused

      paused.set(false);
      await settle();
      // resume with an UNCHANGED request → no refetch (PAUSED semantics)
      expect(requests).toBe(1);
    });

    it('pause: true follows the ambient Activity boundary', async () => {
      let requests = 0;
      const boundaryPaused = signal(true);

      const child = createEnvironmentInjector(
        [providePaused(boundaryPaused)],
        TestBed.inject(EnvironmentInjector),
      );

      const res = runInInjectionContext(child, () =>
        queryResource(
          () => ({
            url: 'https://example.com/activity',
            context: createTestContext(() => {
              requests++;
            }, { ok: true }),
          }),
          { pause: true },
        ),
      );

      await settle();
      expect(requests).toBe(0); // boundary paused → held

      boundaryPaused.set(false);
      await settle();
      expect(requests).toBe(1); // boundary resumed → fetched
      expect(res.value()).toEqual({ ok: true });
    });

    it('pause: true is a no-op outside an Activity boundary', async () => {
      let requests = 0;

      const res = TestBed.runInInjectionContext(() =>
        queryResource(
          () => ({
            url: 'https://example.com/no-boundary',
            context: createTestContext(() => {
              requests++;
            }, { ok: true }),
          }),
          { pause: true },
        ),
      );

      await TestBed.runInInjectionContext(() =>
        until(res.value, (v) => v !== undefined),
      );
      expect(requests).toBe(1); // fetches normally — no PAUSED_CONTEXT in scope
    });
  });
});

describe('queryResource — cache provider ergonomics', () => {
  it('works with no cache provider at all (in-memory root default)', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        // intentionally NO provideQueryCache() — the providedIn:'root' default applies
        {
          provide: ResourceSensors,
          useValue: {
            networkStatus: signal(true),
            pageVisibility: signal<DocumentVisibilityState>('visible'),
          },
        },
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([testInterceptor]),
        ),
      ],
    });

    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => ({
        url: 'https://example.com/no-provider',
        context: createTestContext(() => {
          // noop
        }, { data: 'ok' }),
      })),
    );

    const result = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(result).toEqual({ data: 'ok' });
  });

  it('provideMockQueryCache serves consecutive identical queries from cache', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideMockQueryCache(),
        {
          provide: ResourceSensors,
          useValue: {
            networkStatus: signal(true),
            pageVisibility: signal<DocumentVisibilityState>('visible'),
          },
        },
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([
            createCacheInterceptor(),
            createDedupeRequestsInterceptor(),
            testInterceptor,
          ]),
        ),
      ],
    });

    let requests = 0;
    const url = 'https://example.com/mock-cache';
    const validate = () => {
      requests++;
    };

    const res = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({ url, context: createTestContext(validate, { data: 'v' }) }),
        { cache: { staleTime: 10000 } },
      ),
    );
    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(requests).toBe(1);

    const res2 = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({ url, context: createTestContext(validate, { data: 'v' }) }),
        { cache: { staleTime: 10000 } },
      ),
    );
    const result2 = await TestBed.runInInjectionContext(() =>
      until(res2.value, (v) => v !== undefined),
    );

    expect(result2).toEqual({ data: 'v' });
    expect(requests).toBe(1); // second consumer served from the in-memory mock cache
  });

  it('provideMockResourceSensors drives offline/online behavior', async () => {
    const online = signal(true);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideMockResourceSensors({ networkStatus: online }),
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([testInterceptor]),
        ),
      ],
    });

    let requests = 0;
    online.set(false); // start offline

    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => ({
        url: 'https://example.com/mock-sensors',
        context: createTestContext(() => requests++, { data: 'ok' }),
      })),
    );

    expect(res.disabled()).toBe(true);
    expect(requests).toBe(0);

    online.set(true); // back online → resource enables and fetches
    expect(res.disabled()).toBe(false);

    const result = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(result).toEqual({ data: 'ok' });
    expect(requests).toBe(1);
  });
});

describe('queryResource — parse option', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideMockQueryCache(),
        {
          provide: ResourceSensors,
          useValue: {
            networkStatus: signal(true),
            pageVisibility: signal<DocumentVisibilityState>('visible'),
          },
        },
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([
            createCacheInterceptor(),
            createDedupeRequestsInterceptor(),
            testInterceptor,
          ]),
        ),
      ],
    });
  });

  it('should parse the response body using the provided parse function', async () => {
    const url = 'https://example.com/parse';
    const parse = (val: any) => ({ ...val, parsed: true });

    const res = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(() => {
            /* noop */
          }, { data: 'raw' }),
        }),
        { parse },
      ),
    );

    const result = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(result).toEqual({ data: 'raw', parsed: true });
  });

  it('should parse the response body when retrieving from the cache', async () => {
    let requests = 0;
    const url = 'https://example.com/parse-cache';
    const validate = () => { requests++; };
    const parse = (val: any) => ({ ...val, parsed: true });

    // First request (network hit)
    const resA = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(validate, { data: 'raw' }),
        }),
        { parse, cache: { staleTime: 10000 } },
      ),
    );

    const resultA = await TestBed.runInInjectionContext(() =>
      until(resA.value, (v) => v !== undefined),
    );
    expect(resultA).toEqual({ data: 'raw', parsed: true });
    expect(requests).toBe(1);

    // Second request (cache hit)
    const resB = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(validate, { data: 'raw' }),
        }),
        { parse, cache: { staleTime: 10000 } },
      ),
    );

    const resultB = await TestBed.runInInjectionContext(() =>
      until(resB.value, (v) => v !== undefined),
    );
    
    // Ensure it was parsed correctly
    expect(resultB).toEqual({ data: 'raw', parsed: true });
    // Ensure it was served from cache (no new network request)
    expect(requests).toBe(1); 
  });

  it('returns cached entries as-is without re-parsing (parse-on-write)', async () => {
    const url = 'https://example.com/parse-cached';
    const customKey = 'parse-cached-key';
    // parse would add `parsed: true`; a cached (already-parsed) entry must NOT be re-parsed
    const parse = (val: any) => ({ ...val, parsed: true });

    // seed the cache with an already-parsed value, as hydration/network would store it
    TestBed.runInInjectionContext(() => {
      const cache = injectQueryCache();
      cache.store(
        customKey,
        new HttpResponse({ body: { data: 'from-db', parsed: true }, status: 200 }),
      );
    });

    const res = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(() => {
            throw new Error('Should not hit network');
          }, { data: 'should-not-hit' }),
        }),
        { parse, cache: { staleTime: 10000, hash: () => customKey } },
      ),
    );

    const result = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );

    expect(result).toEqual({ data: 'from-db', parsed: true });
  });

  it('does not re-apply parse to values written via set (no double-parse)', async () => {
    const url = 'https://example.com/parse-set';
    // non-idempotent: a double-parse would show up as count === 2
    const parse = (val: any) => ({ ...val, count: (val.count ?? 0) + 1 });

    const res = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(() => {
            /* noop */
          }, { data: 'raw' }),
        }),
        { parse, cache: { staleTime: 10000 } },
      ),
    );

    const initial = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    // network body parsed exactly once
    expect(initial).toEqual({ data: 'raw', count: 1 });

    // write an already-parsed value through the resource's writable setter
    res.set({ data: 'local', count: 1 });

    // read-back is verbatim — parse must NOT run again (would be count: 2)
    expect(res.value()).toEqual({ data: 'local', count: 1 });
    // ...and stays stable across subsequent reads (no creeping re-parse)
    expect(res.value()).toEqual({ data: 'local', count: 1 });
  });

  it('setLocal writes to this tab only (no persist, no broadcast), unlike set', async () => {
    const url = 'https://example.com/set-local';
    const res = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(() => {
            /* noop */
          }, { data: 'raw' }),
        }),
        { cache: { staleTime: 10000, persist: true } },
      ),
    );
    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );

    const cache = TestBed.runInInjectionContext(() => injectQueryCache());
    const storeSpy = vi.spyOn(cache, 'store');

    res.set({ data: 'a' } as any);
    res.setLocal({ data: 'b' } as any);

    // store(key, value, staleTime, ttl, persist, broadcast)
    const flags = storeSpy.mock.calls.map((c) => [c[4], c[5]]);
    expect(flags).toEqual([
      [true, true], // set → persisted + broadcast
      [false, false], // setLocal → neither
    ]);
    expect(res.value()).toEqual({ data: 'b' });
  });

  it('cache.skipTabSync opts a resource out of broadcast while still persisting', async () => {
    const url = 'https://example.com/skip-tab-sync';
    const res = TestBed.runInInjectionContext(() =>
      queryResource(
        () => ({
          url,
          context: createTestContext(() => {
            /* noop */
          }, { data: 'raw' }),
        }),
        { cache: { staleTime: 10000, persist: true, skipTabSync: true } },
      ),
    );
    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );

    const cache = TestBed.runInInjectionContext(() => injectQueryCache());
    const storeSpy = vi.spyOn(cache, 'store');

    res.set({ data: 'a' } as any);

    // store(key, value, staleTime, ttl, persist, broadcast) — persist on, broadcast off
    const [persistFlag, broadcastFlag] = storeSpy.mock.calls[0].slice(4);
    expect(persistFlag).toBe(true);
    expect(broadcastFlag).toBe(false);
  });
});

