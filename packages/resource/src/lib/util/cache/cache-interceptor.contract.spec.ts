import {
  HttpClient,
  HttpContext,
  HttpContextToken,
  HttpErrorResponse,
  type HttpEvent,
  HttpEventType,
  HttpHeaderResponse,
  HttpHeaders,
  type HttpInterceptorFn,
  type HttpRequest,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
} from '@angular/common/http';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, lastValueFrom, of, throwError, toArray } from 'rxjs';
import { type Cache, injectQueryCache, provideQueryCache } from './cache';
import { createCacheInterceptor, setCacheContext } from './cache-interceptor';

type Stub = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  headerEvent?: boolean;
};
const STUB = new HttpContextToken<Stub>(() => ({}));

let seen: HttpRequest<unknown>[];
const stub: HttpInterceptorFn = (req) => {
  seen.push(req);
  const s = req.context.get(STUB);
  const status = s.status ?? 200;
  const headers = new HttpHeaders(s.headers ?? {});
  if (status < 200 || status >= 300)
    return throwError(() => new HttpErrorResponse({ status, headers }));
  const res = new HttpResponse({ status, body: s.body ?? null, headers });
  return s.headerEvent
    ? of<HttpEvent<unknown>[]>(new HttpHeaderResponse({ status, headers }), res)
    : of(res);
};

type Opt = Parameters<typeof setCacheContext>[1];
const ctx = (s: Stub, opt: Opt) =>
  setCacheContext(new HttpContext().set(STUB, s), opt);

const DAY = 24 * 60 * 60 * 1000;
let cache: Cache<HttpResponse<unknown>>;
let client: HttpClient;

const get = (s: Stub, opt: Opt, method = 'GET') =>
  firstValueFrom(
    client.request(method, 'https://x/data', {
      observe: 'response',
      context: ctx(s, opt),
    }),
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  seen = [];
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'browser' },
      provideQueryCache({ persist: false }),
      provideHttpClient(
        withNoXsrfProtection(),
        withInterceptors([createCacheInterceptor(), stub]),
      ),
    ],
  });
  cache = TestBed.runInInjectionContext(() => injectQueryCache());
  client = TestBed.inject(HttpClient);
});
afterEach(() => vi.useRealTimers());

describe('createCacheInterceptor contract: Cache-Control', () => {
  it('no-store is not cached', async () => {
    await get(
      { headers: { 'Cache-Control': 'no-store' } },
      { key: 'k', staleTime: 5000, ttl: 60_000 },
    );
    expect(cache.getUntracked('k')).toBeNull();
    await get({}, { key: 'k', staleTime: 5000, ttl: 60_000 });
    expect(seen.length).toBe(2);
  });

  it.each(['no-cache, max-age=60', 'must-revalidate, max-age=60'])(
    '%s is stored but stale at once',
    async (cc) => {
      await get({ headers: { 'Cache-Control': cc } }, { key: 'k' });
      expect(cache.getUntracked('k')!.isStale).toBe(true);
    },
  );

  it('immutable is stored with infinite timings', async () => {
    const spy = vi.spyOn(cache, 'store');
    await get({ headers: { 'Cache-Control': 'immutable' } }, { key: 'k' });
    expect(spy.mock.calls[0].slice(2, 4)).toEqual([Infinity, Infinity]);
  });

  it('max-age raises a shorter option ttl', async () => {
    await get(
      { headers: { 'Cache-Control': 'max-age=60' } },
      { key: 'k', ttl: 30_000 },
    );
    vi.advanceTimersByTime(45_000);
    expect(cache.getUntracked('k')).not.toBeNull();
  });

  it('stale-while-revalidate without max-age is stale at once and lives that long', async () => {
    await get(
      { headers: { 'Cache-Control': 'stale-while-revalidate=300' } },
      { key: 'k', staleTime: 5000 },
    );
    expect(cache.getUntracked('k')!.isStale).toBe(true);
    vi.advanceTimersByTime(299_000);
    expect(cache.getUntracked('k')).not.toBeNull();
    vi.advanceTimersByTime(2000);
    expect(cache.getUntracked('k')).toBeNull();
  });
});

describe('createCacheInterceptor contract: persistence flag', () => {
  const persistArg = (spy: ReturnType<typeof vi.spyOn>) =>
    (spy.mock.calls.at(-1) as unknown[])[4];

  it.each([
    [true, true],
    [undefined, false],
  ])(
    'a 200 with persist %s stores with persist %s',
    async (persist, expected) => {
      const spy = vi.spyOn(cache, 'store');
      await get({}, { key: 'k', persist });
      expect(persistArg(spy)).toBe(expected);
    },
  );

  it.each([
    [undefined, {}, false],
    [true, {}, true],
    [true, { 'Cache-Control': 'private' }, false],
  ])(
    'a 304 with persist %s and headers %o re-stores with persist %s',
    async (persist, headers, expected) => {
      await get(
        { headers: { ETag: 'v1' } },
        { key: 'k', staleTime: 0, ttl: DAY, persist },
      );
      const spy = vi.spyOn(cache, 'store');
      await get(
        { status: 304, headers },
        { key: 'k', staleTime: 0, ttl: DAY, persist },
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(persistArg(spy)).toBe(expected);
    },
  );
});

describe('createCacheInterceptor contract: requests', () => {
  it.each(['HEAD', 'OPTIONS'])('caches %s by default', async (method) => {
    await get({}, { key: 'k', staleTime: 60_000 }, method);
    await get({}, { key: 'k', staleTime: 60_000 }, method);
    expect(seen.length).toBe(1);
  });

  it('does not cache POST by default', async () => {
    await get({}, { key: 'k', staleTime: 60_000 }, 'POST');
    await get({}, { key: 'k', staleTime: 60_000 }, 'POST');
    expect(seen.length).toBe(2);
    expect(cache.getUntracked('k')).toBeNull();
  });

  it('a cold request carries no conditional headers', async () => {
    await get({}, { key: 'k' });
    expect(seen[0].headers.has('If-None-Match')).toBe(false);
    expect(seen[0].headers.has('If-Modified-Since')).toBe(false);
  });

  it('revalidating a stale entry sends its ETag and Last-Modified', async () => {
    const lm = 'Wed, 21 Oct 2025 07:28:00 GMT';
    await get(
      { headers: { ETag: 'v1', 'Last-Modified': lm } },
      { key: 'k', staleTime: 0, ttl: DAY },
    );
    await get({ status: 304 }, { key: 'k', staleTime: 0, ttl: DAY });
    expect(seen[1].headers.get('If-None-Match')).toBe('v1');
    expect(seen[1].headers.get('If-Modified-Since')).toBe(lm);
  });

  it('bustBrowserCache adds a _cb param and keeps the cache key', async () => {
    await get({}, { key: 'k', bustBrowserCache: true });
    expect(seen[0].params.has('_cb')).toBe(true);
    expect(cache.getUntracked('k')).not.toBeNull();
    await get({}, { key: 'j' });
    expect(seen[1].params.has('_cb')).toBe(false);
  });

  it('a 200 refresh of a stale entry returns and stores the new body', async () => {
    await get({ body: { v: 1 } }, { key: 'k', staleTime: 0, ttl: DAY });
    const res = await get(
      { body: { v: 2 } },
      { key: 'k', staleTime: 0, ttl: DAY },
    );
    expect(res.body).toEqual({ v: 2 });
    expect(cache.getUntracked('k')!.value.body).toEqual({ v: 2 });
  });

  it.each([true, false])(
    'a 500 rejects with the HttpErrorResponse (stale entry: %s)',
    async (warm) => {
      if (warm) await get({}, { key: 'k', staleTime: 0, ttl: DAY });
      const err = await get(
        { status: 500 },
        { key: 'k', staleTime: 0, ttl: DAY },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(HttpErrorResponse);
      expect(err.status).toBe(500);
    },
  );

  it('passes progress header events through and parses only the final response', async () => {
    const parse = vi.fn((b: unknown) => ({ parsed: b }));
    const events = await lastValueFrom(
      client
        .request('GET', 'https://x/data', {
          observe: 'events',
          context: ctx({ body: 1, headerEvent: true }, { key: 'k', parse }),
        })
        .pipe(toArray()),
    );
    expect(events.some((e) => e.type === HttpEventType.ResponseHeader)).toBe(
      true,
    );
    expect(parse).toHaveBeenCalledTimes(1);
    expect(cache.getUntracked('k')!.value.body).toEqual({ parsed: 1 });
  });
});
