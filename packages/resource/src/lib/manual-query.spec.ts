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
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import {
  injectTransitionScope,
  provideTransitionScope,
} from '@mmstack/primitives';
import { manualQueryResource } from './manual-query';
import {
  createCacheInterceptor,
  createDedupeRequestsInterceptor,
  provideQueryCache,
} from './util';

const TEST_CONTEXT = new HttpContextToken<{
  validate: (req: HttpRequest<any>) => void;
  returnValue: any;
  shouldThrow: boolean;
}>(() => ({
  validate: () => {
    /* noop */
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

const testInterceptor = (req: HttpRequest<any>) => {
  const { validate, shouldThrow, returnValue } = req.context.get(TEST_CONTEXT);
  validate(req);
  if (shouldThrow) {
    return throwError(
      () => new HttpErrorResponse({ error: 'Test error', status: 500 }),
    );
  }
  return of(new HttpResponse({ body: returnValue, status: 200 }));
};

describe('manualQueryResource', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
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

  it('should not fetch initially', () => {
    let requests = 0;
    const validate = () => {
      requests++;
    };

    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource(() => ({
        url: 'https://example.com/initial',
        context: createTestContext(validate, { data: 'test' }),
      })),
    );

    expect(requests).toBe(0);
    expect(res.disabled()).toBe(true);
  });

  it('should fetch data when trigger is called', async () => {
    let requests = 0;
    const url = 'https://example.com/trigger';
    const validate = (req: HttpRequest<any>) => {
      expect(req.url).toBe(url);
      requests++;
    };

    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource(() => ({
        url,
        context: createTestContext(validate, { data: 'test' }),
      })),
    );

    const result = await res.trigger();
    expect(result).toEqual({ data: 'test' });
    expect(requests).toBe(1);
  });

  it('keepPrevious + defaultValue: a re-trigger holds the previous result instead of the default', async () => {
    let n = 0;
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource<number[]>(
        () => ({
          url: 'https://example.com/keep-prev',
          context: createTestContext(() => {
            /* noop */
          }, [++n]),
        }),
        { keepPrevious: true, defaultValue: [] },
      ),
    );
    expect(res.value()).toEqual([]);

    await res.trigger();
    expect(res.value()).toEqual([1]);

    const next = res.trigger();
    expect(res.value()).toEqual([1]);
    await next;
    expect(res.value()).toEqual([2]);
  });

  it('should use override url if provided in trigger', async () => {
    let requests = 0;
    const overrideUrl = 'https://example.com/override';
    const validate = (req: HttpRequest<any>) => {
      expect(req.url).toBe(overrideUrl);
      requests++;
    };

    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource(() => ({
        url: 'https://example.com/original',
      })),
    );

    const result = await res.trigger({
      url: overrideUrl,
      context: createTestContext(validate, { data: 'override-data' }),
    });

    expect(result).toEqual({ data: 'override-data' });
    expect(requests).toBe(1);
  });

  it('should reject the trigger promise if request fails', async () => {
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource(() => ({
        url: 'https://example.com/fail',
        context: createTestContext(
          () => {
            /* noop */
          },
          null,
          true,
        ),
      })),
    );

    await expect(res.trigger()).rejects.toBeInstanceOf(HttpErrorResponse);
  });

  it('a re-trigger resolves with the NEW value, never the previous settled one', async () => {
    let payload = 'first';

    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource(() => ({
        url: 'https://example.com/data',
        context: createTestContext(
          () => {
            /* noop */
          },
          { data: payload },
        ),
      })),
    );

    const first = await res.trigger();
    expect(first).toEqual({ data: 'first' });

    payload = 'second';

    const second = await res.trigger();
    expect(second).toEqual({ data: 'second' });
  });

  it('rejects when the request fn produces no request', async () => {
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource(() => undefined),
    );

    await expect(res.trigger()).rejects.toThrow('produced no request');
  });
});

describe('manualQueryResource — transition scope + pause', () => {
  let inFlight: Array<{ url: string; respond: (body: unknown) => void }>;
  const deferredInterceptor = (req: HttpRequest<unknown>) =>
    new Observable<HttpResponse<unknown>>((sub) => {
      inFlight.push({
        url: req.urlWithParams,
        respond: (body) => {
          sub.next(new HttpResponse({ body, status: 200 }));
          sub.complete();
        },
      });
    });

  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    TestBed.tick();
  };

  beforeEach(() => {
    inFlight = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([deferredInterceptor]),
        ),
        provideTransitionScope(),
      ],
    });
  });

  it("register: 'suspend' — untriggered is READY; only a triggered load suspends", async () => {
    const { scope, res } = TestBed.runInInjectionContext(() => ({
      scope: injectTransitionScope(),
      res: manualQueryResource<{ id: number }>(
        () => 'https://example.test/export',
        { register: 'suspend' },
      ),
    }));
    await settle();
    expect(scope.pending()).toBe(false);
    expect(scope.suspended('value')).toBe(false);

    const p = res.trigger();
    await settle();
    expect(scope.pending()).toBe(true);
    expect(scope.suspended('value')).toBe(true);

    inFlight.shift()?.respond({ id: 1 });
    await settle();
    expect(scope.pending()).toBe(false);
    expect(scope.suspended('value')).toBe(false);
    await expect(p).resolves.toEqual({ id: 1 });
  });

  it('destroy() removes the manual query from its scope', async () => {
    const { scope, res } = TestBed.runInInjectionContext(() => ({
      scope: injectTransitionScope(),
      res: manualQueryResource<{ id: number }>(
        () => 'https://example.test/export',
        { register: 'indicator' },
      ),
    }));
    expect(scope.resources().length).toBe(1);
    res.destroy();
    expect(scope.resources().length).toBe(0);
  });

  it('pause: trigger() while paused holds the request; it fires on resume and settles the promise', async () => {
    const paused = signal(true);
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource<{ id: number }>(() => 'https://example.test/export', {
        pause: paused,
      }),
    );
    const p = res.trigger();
    await settle();
    expect(inFlight.length).toBe(0);
    expect(res.disabledReason()).toBe('no-request');

    paused.set(false);
    await settle();
    expect(inFlight.length).toBe(1);
    inFlight.shift()?.respond({ id: 7 });
    await expect(p).resolves.toEqual({ id: 7 });
  });
});
