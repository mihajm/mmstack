import {
  HttpErrorResponse,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { EnvironmentInjector, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  DONE,
  type ErrorMintReport,
  isError,
  isLoading,
  setErrorReporter,
  until,
} from '@mmstack/primitives';
import { of, throwError } from 'rxjs';
import { mutationResource } from './mutation-resource';
import { queryResource } from './query-resource';
import { provideQueryCache, ResourceSensors } from './util';

// `/fail/...` answers 500, `/void` answers an empty 204, anything else `{ ok: true }`.
const interceptor: HttpInterceptorFn = (req) => {
  if (req.url.includes('/fail/'))
    return throwError(() => new HttpErrorResponse({ error: 'x', status: 500 }));
  if (req.url.includes('/void')) return of(new HttpResponse({ status: 204 }));
  return of(new HttpResponse({ body: { ok: true }, status: 200 }));
};

describe('outcome on @mmstack/resource refs (M5)', () => {
  let env: EnvironmentInjector;
  let reports: ErrorMintReport[];

  beforeEach(() => {
    reports = [];
    setErrorReporter((r) => reports.push(r));
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        {
          provide: ResourceSensors,
          useValue: {
            networkStatus: signal(true),
            pageVisibility: signal<DocumentVisibilityState>('visible'),
          },
        },
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([interceptor]),
        ),
      ],
    });
    env = TestBed.inject(EnvironmentInjector);
  });

  afterEach(() => setErrorReporter(undefined));

  it('queryResource keepPrevious: a failed reload answers errorEdge while value() keeps the held content and hasContent() stays true', async () => {
    const fail = signal(false);
    const res = queryResource<{ ok: boolean }>(
      () => `https://example.com/${fail() ? 'fail/' : ''}held`,
      { keepPrevious: true, injector: env },
    );
    await until(res.status, (s) => s === 'resolved', { injector: env });
    expect(res.outcome()).toEqual({ ok: true });

    fail.set(true);
    TestBed.tick();
    expect(res.outcome()).toEqual({ ok: true }); // reloading with held content → the value

    await until(res.status, (s) => s === 'error', { injector: env });
    const out = res.outcome();
    expect(isError(out)).toBe(true);
    expect(res.value()).toEqual({ ok: true });
    expect(res.hasContent()).toBe(true);
    expect(res.hasValue()).toBe(false);

    // mint once: re-reads return the same sentinel, one report
    expect(res.outcome()).toBe(out);
    TestBed.tick();
    expect(res.outcome()).toBe(out);
    expect(reports.length).toBe(1);
    expect(reports[0].cause).toBe(res.error());
  });

  it('queryResource: first load with nothing to show answers loading, then errorEdge on failure', async () => {
    const res = queryResource<{ ok: boolean }>(
      () => 'https://example.com/fail/first',
      { injector: env },
    );
    TestBed.tick();
    expect(isLoading(res.outcome())).toBe(true);
    await until(res.status, (s) => s === 'error', { injector: env });
    expect(isError(res.outcome())).toBe(true);
    expect(res.hasContent()).toBe(false);
  });

  it('queryResource: nothing requested answers undefined (absence is a value)', () => {
    const res = queryResource<{ ok: boolean }>(() => undefined, {
      injector: env,
    });
    TestBed.tick();
    expect(res.status()).toBe('idle');
    expect(res.outcome()).toBeUndefined();
  });

  it('mutationResource: idle → loading → result; a result-less success answers DONE; the private marker never leaks', async () => {
    const seen: unknown[] = [];
    const settled = Promise.withResolvers<void>();
    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: number) => ({
          url: 'https://example.com/void',
          method: 'POST',
          body,
        }),
        {
          parse: () => undefined,
          onSuccess: () => seen.push(res.outcome()),
          onSettled: () => settled.resolve(),
        },
      ),
    );
    expect(res.outcome()).toBeUndefined();
    res.mutate(1);
    TestBed.tick();
    expect(isLoading(res.outcome())).toBe(true);
    await settled.promise;
    expect(seen).toEqual([DONE]);
    TestBed.tick();
    expect(res.status()).toBe('idle');
    expect(res.outcome()).toBeUndefined();
  });

  it('mutationResource: a payload answers the payload; a failure answers errorEdge, reported once', async () => {
    const seen: unknown[] = [];
    let settled = Promise.withResolvers<void>();
    const fail = signal(false);
    const res = TestBed.runInInjectionContext(() =>
      mutationResource(
        (body: number) => ({
          url: `https://example.com/${fail() ? 'fail/' : ''}m`,
          method: 'POST',
          body,
        }),
        {
          onSuccess: () => seen.push(res.outcome()),
          onError: () => {
            const out = res.outcome();
            seen.push(isError(out) ? 'error' : out);
            seen.push(res.outcome() === out);
          },
          onSettled: () => settled.resolve(),
        },
      ),
    );
    res.mutate(1);
    await settled.promise;
    expect(seen).toEqual([{ ok: true }]);

    settled = Promise.withResolvers<void>();
    fail.set(true);
    res.mutate(2);
    await settled.promise;
    expect(seen.slice(1)).toEqual(['error', true]);
    expect(reports.length).toBe(1);
  });
});
