/* eslint-disable @typescript-eslint/no-non-null-assertion */
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
import { delay, firstValueFrom, of, throwError } from 'rxjs';
import { injectQueryCache, provideQueryCache, type Cache } from './cache';
import { createCacheInterceptor, setCacheContext } from './cache-interceptor';

type StubBehavior = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Defer the response by this many (fake-timer) milliseconds. */
  delayMs?: number;
};

const STUB = new HttpContextToken<StubBehavior>(() => ({ status: 200 }));

/** How many requests actually reached the backend (i.e. weren't served/deduped by the cache). */
let backendCalls = 0;

const stubInterceptor: HttpInterceptorFn = (req) => {
  const stub = req.context.get(STUB);
  backendCalls++;

  if (stub.status >= 400) {
    return throwError(
      () =>
        new HttpErrorResponse({
          status: stub.status,
          error: stub.body ?? 'Error',
        }),
    );
  }

  const res$ = of(
    new HttpResponse({
      status: stub.status,
      body: stub.body ?? null,
      headers: new HttpHeaders(stub.headers ?? {}),
    }),
  );

  return stub.delayMs ? res$.pipe(delay(stub.delayMs)) : res$;
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
    backendCalls = 0;

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

  describe('Cache-Control parsing', () => {
    async function fetchWithHeader(key: string, cacheControl: string) {
      await firstValueFrom(
        client.get('https://example.com/data', {
          observe: 'response',
          context: makeContext(
            {
              status: 200,
              body: { id: 1 },
              headers: { 'Cache-Control': cacheControl },
            },
            { key },
          ),
        }),
      );
    }

    it('max-age sets the FRESH window (staleTime), not the total lifetime', async () => {
      await fetchWithHeader('cc-1', 'max-age=60');

      expect(cache.getUntracked('cc-1')!.isStale).toBe(false);
      vi.advanceTimersByTime(61_000);
      // regression: the inverted mapping evicted the entry here instead of
      // marking it revalidatable
      const after = cache.getUntracked('cc-1');
      expect(after).not.toBeNull();
      expect(after!.isStale).toBe(true);
    });

    it('stale-while-revalidate extends lifetime BEYOND max-age (RFC 5861)', async () => {
      await fetchWithHeader('cc-2', 'max-age=60, stale-while-revalidate=300');

      // fresh for max-age
      vi.advanceTimersByTime(59_000);
      expect(cache.getUntracked('cc-2')!.isStale).toBe(false);

      // then stale-but-revalidatable for the swr window
      vi.advanceTimersByTime(2_000);
      expect(cache.getUntracked('cc-2')!.isStale).toBe(true);
      vi.advanceTimersByTime(290_000); // 351s total < 360s
      expect(cache.getUntracked('cc-2')).not.toBeNull();

      // gone after max-age + swr
      vi.advanceTimersByTime(10_000); // 361s total
      expect(cache.getUntracked('cc-2')).toBeNull();
    });

    it('parses the RFC spelling s-maxage (precedence over max-age)', async () => {
      await fetchWithHeader('cc-3', 'max-age=60, s-maxage=120');

      vi.advanceTimersByTime(61_000);
      // s-maxage=120 wins → still fresh past max-age
      expect(cache.getUntracked('cc-3')!.isStale).toBe(false);
    });

    it('immutable entries survive indefinitely (no timer self-destruct)', async () => {
      await fetchWithHeader('cc-4', 'immutable');

      // regression: setTimeout(…, Infinity) used to invalidate on the next tick
      vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 30); // 30 days
      const entry = cache.getUntracked('cc-4');
      expect(entry).not.toBeNull();
      expect(entry!.isStale).toBe(false);
    });

    it('Cache-Control: private blocks persistence but not in-memory caching', async () => {
      const storeSpy = vi.spyOn(cache, 'store');

      await firstValueFrom(
        client.get('https://example.com/data', {
          observe: 'response',
          context: makeContext(
            {
              status: 200,
              body: { id: 1 },
              headers: { 'Cache-Control': 'private, max-age=60' },
            },
            { key: 'cc-5', persist: true },
          ),
        }),
      );

      expect(cache.getUntracked('cc-5')).not.toBeNull(); // cached in memory
      expect(storeSpy).toHaveBeenCalledWith(
        'cc-5',
        expect.anything(),
        60_000, // fresh window from max-age
        undefined, // no swr / no configured ttl → cache default applies
        false, // ...but never persisted
        true, // broadcast (no skipTabSync)
      );
      storeSpy.mockRestore();
    });
  });

  describe('single-flight revalidation', () => {
    it('N concurrent consumers of the same missing key share one network request', async () => {
      const ctx = () =>
        makeContext(
          { status: 200, body: { id: 1 }, delayMs: 50 },
          { key: 'sf-1', staleTime: 5_000, ttl: 60_000 },
        );

      const p1 = firstValueFrom(
        client.get('https://example.com/data', {
          observe: 'response',
          context: ctx(),
        }),
      );
      const p2 = firstValueFrom(
        client.get('https://example.com/data', {
          observe: 'response',
          context: ctx(),
        }),
      );

      await vi.advanceTimersByTimeAsync(50);
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.body).toEqual({ id: 1 });
      expect(r2.body).toEqual({ id: 1 });
      expect(backendCalls).toBe(1); // regression: used to be 2
    });
  });

  describe('invalidation racing a conditional request', () => {
    it('a 304 landing after invalidate() must not resurrect the entry', async () => {
      // 1. populate + go stale
      await firstValueFrom(
        client.get('https://example.com/data', {
          observe: 'response',
          context: makeContext(
            { status: 200, body: { id: 1 }, headers: { ETag: 'v1' } },
            { key: 'race-1', staleTime: 5_000, ttl: 60_000 },
          ),
        }),
      );
      vi.advanceTimersByTime(6_000);

      // 2. start the revalidation (response delayed), then invalidate mid-flight
      const pending = firstValueFrom(
        client.get('https://example.com/data', {
          observe: 'response',
          context: makeContext(
            { status: 304, delayMs: 100 },
            { key: 'race-1', staleTime: 5_000, ttl: 60_000 },
          ),
        }),
      );

      cache.invalidate('race-1'); // e.g. a mutation completed

      await vi.advanceTimersByTimeAsync(100);
      await pending;

      // regression: the 304 re-store used to resurrect the invalidated entry
      expect(cache.getUntracked('race-1')).toBeNull();
    });
  });

  describe('explicit ttl: 0', () => {
    it('skips storage when the resolved ttl is zero', async () => {
      await firstValueFrom(
        client.get('https://example.com/data', {
          observe: 'response',
          context: makeContext(
            { status: 200, body: { id: 1 } },
            { key: 'ttl-0', staleTime: 0, ttl: 0 },
          ),
        }),
      );

      expect(cache.getUntracked('ttl-0')).toBeNull();
    });
  });
});

describe('createCacheInterceptor (server platform)', () => {
  beforeEach(() => {
    backendCalls = 0;
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        provideQueryCache(),
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([createCacheInterceptor(), stubInterceptor]),
        ),
      ],
    });
  });

  it('passes requests through untouched and never caches', async () => {
    const client = TestBed.inject(HttpClient);
    const cache = TestBed.runInInjectionContext(() => injectQueryCache());

    const response = await firstValueFrom(
      client.get('https://example.com/data', {
        observe: 'response',
        context: makeContext(
          { status: 200, body: { id: 1 } },
          { key: 'ssr-1', staleTime: 5_000, ttl: 60_000 },
        ),
      }),
    );

    expect(response.body).toEqual({ id: 1 });
    expect(backendCalls).toBe(1);
    // a server render must never share responses across requests via the cache
    expect(cache.getUntracked('ssr-1')).toBeNull();
  });
});
