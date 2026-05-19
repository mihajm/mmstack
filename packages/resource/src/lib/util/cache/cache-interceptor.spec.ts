import {
  HttpClient,
  HttpContext,
  HttpContextToken,
  HttpErrorResponse,
  HttpHeaders,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { injectQueryCache, provideQueryCache, type Cache } from './cache';
import { createCacheInterceptor, setCacheContext } from './cache-interceptor';

type StubBehavior = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

const STUB = new HttpContextToken<StubBehavior>(() => ({ status: 200 }));

const stubInterceptor: HttpInterceptorFn = (req) => {
  const stub = req.context.get(STUB);

  if (stub.status >= 400) {
    return throwError(
      () =>
        new HttpErrorResponse({
          status: stub.status,
          error: stub.body ?? 'Error',
        }),
    );
  }

  return of(
    new HttpResponse({
      status: stub.status,
      body: stub.body ?? null,
      headers: new HttpHeaders(stub.headers ?? {}),
    }),
  );
};

function makeContext(
  stub: StubBehavior,
  cacheOpts: Parameters<typeof setCacheContext>[1],
): HttpContext {
  const base = new HttpContext().set(STUB, stub);
  return setCacheContext(base, cacheOpts);
}

describe('createCacheInterceptor', () => {
  let cache: Cache<HttpResponse<unknown>>;
  let client: HttpClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([createCacheInterceptor(), stubInterceptor]),
        ),
      ],
    });

    cache = TestBed.runInInjectionContext(() => injectQueryCache());
    client = TestBed.inject(HttpClient);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores successful 2xx responses in the cache', async () => {
    await firstValueFrom(
      client.get('https://example.com/data', {
        observe: 'response',
        context: makeContext(
          { status: 200, body: { id: 1 } },
          { key: 'k1', staleTime: 5_000, ttl: 60_000 },
        ),
      }),
    );

    const entry = cache.getUntracked('k1');
    expect(entry).not.toBeNull();
    expect(entry!.value.body).toEqual({ id: 1 });
    expect(entry!.isStale).toBe(false);
  });

  it('does not store error responses', async () => {
    try {
      await firstValueFrom(
        client.get('https://example.com/data', {
          observe: 'response',
          context: makeContext(
            { status: 500 },
            { key: 'k-err', staleTime: 5_000, ttl: 60_000 },
          ),
        }),
      );
    } catch {
      // expected
    }

    expect(cache.getUntracked('k-err')).toBeNull();
  });

  it('refreshes cache freshness on 304 so subsequent reads do not revalidate again', async () => {
    // 1. Populate the cache with a 200 response.
    await firstValueFrom(
      client.get('https://example.com/data', {
        observe: 'response',
        context: makeContext(
          { status: 200, body: { id: 1 }, headers: { ETag: 'v1' } },
          { key: 'k1', staleTime: 5_000, ttl: 60_000 },
        ),
      }),
    );

    expect(cache.getUntracked('k1')?.isStale).toBe(false);

    // 2. Advance past staleTime — entry should now be stale.
    vi.advanceTimersByTime(6_000);
    expect(cache.getUntracked('k1')?.isStale).toBe(true);

    // 3. A revalidation request returns 304. The cache should re-stamp the
    //    entry so it is fresh again.
    await firstValueFrom(
      client.get('https://example.com/data', {
        observe: 'response',
        context: makeContext(
          { status: 304 },
          { key: 'k1', staleTime: 5_000, ttl: 60_000 },
        ),
      }),
    );

    const entry = cache.getUntracked('k1');
    expect(entry).not.toBeNull();
    expect(entry!.value.body).toEqual({ id: 1 });
    // The previously-stale entry is now fresh thanks to 304 freshness refresh.
    expect(entry!.isStale).toBe(false);
  });

  it('substitutes the cached entry as the response on 304', async () => {
    // 1. Populate.
    await firstValueFrom(
      client.get('https://example.com/data', {
        observe: 'response',
        context: makeContext(
          { status: 200, body: { id: 1 } },
          { key: 'k1', staleTime: 5_000, ttl: 60_000 },
        ),
      }),
    );

    vi.advanceTimersByTime(6_000);

    // 2. 304 → the response delivered to the consumer should be the cached body, not the 304 itself.
    const response = await firstValueFrom(
      client.get('https://example.com/data', {
        observe: 'response',
        context: makeContext(
          { status: 304 },
          { key: 'k1', staleTime: 5_000, ttl: 60_000 },
        ),
      }),
    );

    expect(response.body).toEqual({ id: 1 });
  });
});
