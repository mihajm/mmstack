import { HttpContext, HttpContextToken, HttpErrorResponse, HttpResponse, provideHttpClient, withInterceptors, withNoXsrfProtection, type HttpRequest } from '@angular/common/http';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { manualQueryResource } from './manual-query';
import { createCacheInterceptor, createDedupeRequestsInterceptor, provideQueryCache } from './util';

const TEST_CONTEXT = new HttpContextToken<{
  validate: (req: HttpRequest<any>) => void;
  returnValue: any;
  shouldThrow: boolean;
}>(() => ({ validate: () => { /* noop */ }, returnValue: null, shouldThrow: false }));

function createTestContext(validate: (req: HttpRequest<any>) => void, returnValue: any, shouldThrow = false) {
  return new HttpContext().set(TEST_CONTEXT, { validate, returnValue, shouldThrow });
}

const testInterceptor = (req: HttpRequest<any>) => {
  const { validate, shouldThrow, returnValue } = req.context.get(TEST_CONTEXT);
  validate(req);
  if (shouldThrow) {
    return throwError(() => new HttpErrorResponse({ error: 'Test error', status: 500 }));
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
          withInterceptors([createCacheInterceptor(), createDedupeRequestsInterceptor(), testInterceptor]),
        ),
      ],
    });
  });

  it('should not fetch initially', () => {
    let requests = 0;
    const validate = () => { requests++; };
    
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource(() => ({
        url: 'https://example.com/initial',
        context: createTestContext(validate, { data: 'test' }),
      }))
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
      }))
    );

    const result = await res.trigger();
    expect(result).toEqual({ data: 'test' });
    expect(requests).toBe(1);
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
      }))
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
        context: createTestContext(() => { /* noop */ }, null, true),
      }))
    );

    await expect(res.trigger()).rejects.toBeInstanceOf(HttpErrorResponse);
  });
});
