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
import { PLATFORM_ID, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { until } from '@mmstack/primitives';
import { of, throwError } from 'rxjs';
import { queryResource } from './query-resource';
import {
  createCacheInterceptor,
  createDedupeRequestsInterceptor,
  provideQueryCache,
  ResourceSensors,
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

  beforeEach(() => {
    networkStatusSignal = signal(true);

    TestBed.configureTestingModule({
      providers: [
        {
          provide: PLATFORM_ID,
          useValue: 'browser',
        },
        provideQueryCache(),
        {
          provide: ResourceSensors,
          useValue: { networkStatus: networkStatusSignal },
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
      }))
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
      until(res.value, (v) => v !== undefined)
    );
    expect(result).toEqual({ data: 'offline-test' });
    expect(requests).toBe(1);
  });

  it('should be disabled unconditionally if the request function returns undefined', () => {
    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => undefined)
    );
    expect(res.disabled()).toBe(true);
  });

  it('should call onError callback in an effect when request fails', async () => {
    let onErrorCalled = false;
    let errorReceived: any;
    const url = 'https://example.com/onerror';

    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => ({
        url,
        context: createTestContext(() => { /* noop */ }, null, true),
      }), {
        onError: (err) => {
          onErrorCalled = true;
          errorReceived = err;
        }
      })
    );

    try {
      await TestBed.runInInjectionContext(() =>
        until(res.error, (v) => v !== undefined)
      );
    } catch {
      // Ignored
    }

    TestBed.flushEffects(); 
    expect(onErrorCalled).toBe(true);
    expect(errorReceived).toBeDefined();
  });

  it('should preserve previous value when keepPrevious is true and request URL changes', async () => {
    let returnData = { data: 'first' };
    const requestSignal = signal<any>({
        url: 'https://example.com/keep-prev-1',
        context: createTestContext(() => { /* noop */ }, returnData),
    });

    const res = TestBed.runInInjectionContext(() =>
      queryResource(requestSignal, { keepPrevious: true })
    );

    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined)
    );
    expect(res.value()).toEqual({ data: 'first' });

    // Change request to a new URL
    returnData = { data: 'second' };
    requestSignal.set({
        url: 'https://example.com/keep-prev-2',
        context: createTestContext(() => { /* noop */ }, returnData),
    });

    // We change the request, which triggers a reload, but prior value is synchronously kept
    expect(res.value()).toEqual({ data: 'first' });

    // Wait for the new value to resolve
    await TestBed.runInInjectionContext(() =>
      until(res.value, (v: any) => v?.data === 'second')
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
    const reqObj1 = { url, context: createTestContext(validate, { data: 'test' }) };
    const reqObj2 = { url, context: createTestContext(validate, { data: 'test' }) };

    const reqSignal = signal<any>(reqObj1);

    const res = TestBed.runInInjectionContext(() =>
      queryResource(reqSignal, { triggerOnSameRequest: true })
    );

    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined)
    );
    expect(requests).toBe(1);

    // Provide new object (identical fields)
    reqSignal.set(reqObj2);
    
    // allow microtasks to trigger the new request fetch cycle
    await new Promise(r => setTimeout(r, 10)); 
    expect(requests).toBe(2);
  });

  it('should open circuit breaker after multiple failures', async () => {
    const url = 'https://example.com/circuit';
    const validate = () => {
      // ignore
    };

    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => ({
        url,
        context: createTestContext(validate, null, true),
      }), { circuitBreaker: true })
    );

    // Initial load throws
    try {
      await TestBed.runInInjectionContext(() =>
        until(res.error, (v) => v !== undefined)
      );
    } catch {
      // Ignored
    }

    TestBed.flushEffects();

    // Default circuit breaker threshold is 5, we did 1, so 4 more
    for (let i = 0; i < 4; i++) {
        try {
          await res.reload();
        } catch {
             // Let it fail
        }
        TestBed.flushEffects();
    }

    // Now circuit breaker should be open and the resource should be disabled
    await TestBed.runInInjectionContext(() => until(res.disabled, (v) => v === true));
    expect(res.disabled()).toBe(true);
  });

  it('should fetch data when prefetch is called and serve from cache', async () => {
    let requests = 0;
    const url = 'https://example.com/prefetch';
    const validate = () => {
      requests++;
    };

    const reqSignal = signal<any>(undefined);
    
    const res = TestBed.runInInjectionContext(() =>
      queryResource(reqSignal, { cache: { staleTime: 10000 } })
    );

    expect(requests).toBe(0);

    // Prefetch triggers the initial caching
    await res.prefetch({ url, context: createTestContext(validate, { data: 'prefetch-data' }) });
    expect(requests).toBe(1);

    // Enable resource with the same request signature
    reqSignal.set({ url, context: createTestContext(validate, { data: 'prefetch-data' }) });
    
    const result = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined)
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
      queryResource(() => ({
        url,
        context: createTestContext(validate, { data: 'cache-data' }),
      }), { cache: { staleTime: 10000 } })
    );

    const result = await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined)
    );
    expect(result).toEqual({ data: 'cache-data' });
    expect(requests).toBe(1);

    // Wait slightly to ensure caching effect processed
    const res2 = TestBed.runInInjectionContext(() =>
      queryResource(() => ({
        url,
        context: createTestContext(validate, { data: 'cache-data' }),
      }), { cache: { staleTime: 10000 } })
    );
    
    const result2 = await TestBed.runInInjectionContext(() =>
      until(res2.value, (v) => v !== undefined)
    );
    expect(result2).toEqual({ data: 'cache-data' });
    
    // The request was intercepted and deduplicated/served from cache
    expect(requests).toBe(1);
  });
});
