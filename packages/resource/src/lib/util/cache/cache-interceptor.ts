import {
  HttpContext,
  HttpContextToken,
  type HttpEvent,
  type HttpHandlerFn,
  type HttpInterceptorFn,
  type HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { inject, PLATFORM_ID } from '@angular/core';
import { map, type Observable, of } from 'rxjs';
import { hashRequest } from '../hash-request';
import { sharePending } from '../share-pending';
import { injectQueryCache } from './cache';

type CacheEntryOptions = {
  key?: string;
  ttl?: number;
  staleTime?: number;
  cache: boolean;
  bustBrowserCache?: boolean;
  ignoreCacheControl?: boolean;
  parse?: (val: unknown) => unknown;
  persist?: boolean;
  skipTabSync?: boolean;
};

const CACHE_CONTEXT = new HttpContextToken<CacheEntryOptions>(() => ({
  cache: false,
}));

export function setCacheContext(
  ctx = new HttpContext(),
  opt: Omit<CacheEntryOptions, 'cache' | 'key'> & {
    key: Required<CacheEntryOptions>['key'];
  },
) {
  return ctx.set(CACHE_CONTEXT, { ...opt, cache: true });
}

function getCacheContext(ctx: HttpContext): CacheEntryOptions {
  return ctx.get(CACHE_CONTEXT);
}

type ResolvedCacheControl = {
  noStore: boolean;
  noCache: boolean;
  mustRevalidate: boolean;
  immutable: boolean;
  /** `Cache-Control: private` — cacheable in memory, but must never be persisted. */
  isPrivate: boolean;
  maxAge: number | null;
  staleWhileRevalidate: number | null;
};

function parseCacheControlHeader(
  req: HttpResponse<unknown>,
): ResolvedCacheControl {
  const header = req.headers.get('Cache-Control');

  let sMaxAge: number | null = null;
  const directives: ResolvedCacheControl = {
    noStore: false,
    noCache: false,
    mustRevalidate: false,
    immutable: false,
    isPrivate: false,
    maxAge: null,
    staleWhileRevalidate: null,
  };

  if (!header) return directives;

  const parts = header.split(',');

  for (const part of parts) {
    const [unparsedKey, value] = part.trim().split('=');
    const key = unparsedKey.trim().toLowerCase();

    switch (key) {
      case 'no-store':
        directives.noStore = true;
        break;
      case 'no-cache':
        directives.noCache = true;
        break;
      case 'must-revalidate':
      case 'proxy-revalidate':
        directives.mustRevalidate = true;
        break;
      case 'immutable':
        directives.immutable = true;
        break;
      case 'private':
        directives.isPrivate = true;
        break;
      case 'max-age': {
        if (!value) break;
        const parsedValue = parseInt(value, 10);
        if (!isNaN(parsedValue)) directives.maxAge = parsedValue;
        break;
      }

      case 's-maxage': {
        if (!value) break;
        const parsedValue = parseInt(value, 10);
        if (!isNaN(parsedValue)) sMaxAge = parsedValue;
        break;
      }
      case 'stale-while-revalidate': {
        if (!value) break;
        const parsedValue = parseInt(value, 10);
        if (!isNaN(parsedValue)) directives.staleWhileRevalidate = parsedValue;
        break;
      }
    }
  }

  // s-maxage takes precedence over max-age
  if (sMaxAge !== null) directives.maxAge = sMaxAge;

  // if no store nothing else is relevant
  if (directives.noStore)
    return {
      noStore: true,
      noCache: false,
      mustRevalidate: false,
      immutable: false,
      isPrivate: directives.isPrivate,
      maxAge: null,
      staleWhileRevalidate: null,
    };

  // max age does not apply to immutable resources
  if (directives.immutable)
    return {
      ...directives,
      maxAge: null,
    };

  return directives;
}

function resolveTimings(
  cacheControl: ResolvedCacheControl,
  optStaleTime?: number,
  optTTL?: number,
): { staleTime?: number; ttl?: number } {
  let staleTime = optStaleTime;
  let ttl = optTTL;

  if (cacheControl.immutable)
    return {
      staleTime: Infinity,
      ttl: Infinity,
    };

  if (cacheControl.maxAge !== null) {
    staleTime = cacheControl.maxAge * 1000;
    if (cacheControl.staleWhileRevalidate !== null) {
      ttl = staleTime + cacheControl.staleWhileRevalidate * 1000;
    } else if (ttl !== undefined) {
      // a configured total lifetime must never undercut the server's fresh window
      ttl = Math.max(ttl, staleTime);
    }
    // no swr + no configured ttl → leave undefined so the cache's default ttl applies
    // (the entry stays resident past max-age for ETag revalidation)
  } else if (cacheControl.staleWhileRevalidate !== null) {
    // swr without max-age: stale immediately, revalidatable for the window
    staleTime = 0;
    ttl = cacheControl.staleWhileRevalidate * 1000;
  }

  // if no-cache is set, we must always revalidate (the entry stays usable for conditional requests until ttl)
  if (cacheControl.noCache || cacheControl.mustRevalidate) staleTime = 0;

  // option-only path (no server freshness): a misconfigured ttl < staleTime clamps the
  // fresh window down, mirroring the cache's own internal clamp
  if (
    cacheControl.maxAge === null &&
    ttl !== undefined &&
    staleTime !== undefined &&
    ttl < staleTime
  ) {
    staleTime = ttl;
  }

  return { staleTime, ttl };
}

/**
 * Creates an `HttpInterceptorFn` that implements caching for HTTP requests. This interceptor
 * checks for a caching configuration in the request's `HttpContext` (internally set by the queryResource).
 * If caching is enabled, it attempts to retrieve responses from the cache. If a cached response
 * is found and is not stale, it's returned directly.  If the cached response is stale, it's returned,
 * and a background revalidation request is made.  If no cached response is found, the request
 * is made to the server, and the response is cached according to the configured TTL and staleness.
 * The interceptor also respects `Cache-Control` headers from the server.
 *
 * Cache-enabled requests are single-flighted per cache key: N concurrent consumers of
 * the same missing/stale entry share ONE network request. Non-cached requests are not
 * touched — pair with `createDedupeRequestsInterceptor` to coalesce those as well.
 *
 * @param allowedMethods - An array of HTTP methods for which caching should be enabled.
 *                        Defaults to `['GET', 'HEAD', 'OPTIONS']`.
 *
 * @returns An `HttpInterceptorFn` that implements the caching logic.
 *
 * @example
 * // In your app.config.ts or module providers:
 *
 * import { provideHttpClient, withInterceptors } from '@angular/common/http';
 * import { createCacheInterceptor } from '@mmstack/resource';
 *
 * export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideHttpClient(withInterceptors([createCacheInterceptor()])),
 *     // ... other providers
 *   ],
 * };
 */
export function createCacheInterceptor(
  allowedMethods = ['GET', 'HEAD', 'OPTIONS'],
): HttpInterceptorFn {
  const CACHE_METHODS = new Set<string>(allowedMethods);

  const inFlight = new Map<string, Observable<HttpEvent<unknown>>>();

  return (
    req: HttpRequest<unknown>,
    next: HttpHandlerFn,
  ): Observable<HttpEvent<unknown>> => {
    if (inject(PLATFORM_ID) === 'server') return next(req);

    const cache = injectQueryCache();

    if (!CACHE_METHODS.has(req.method)) return next(req);
    const opt = getCacheContext(req.context);

    if (!opt.cache) return next(req);

    const key = opt.key ?? hashRequest(req);
    const entry = cache.getUntracked(key); // null if expired or not found

    // If the entry is not stale, return it
    if (entry && !entry.isStale) return of(entry.value);

    // resource itself handles case of showing stale data...the request must process as this will "refresh said data"

    return sharePending(inFlight, key, () => {
      const eTag = entry?.value.headers.get('ETag');
      const lastModified = entry?.value.headers.get('Last-Modified');

      if (eTag) {
        req = req.clone({ setHeaders: { 'If-None-Match': eTag } });
      }

      if (lastModified) {
        req = req.clone({ setHeaders: { 'If-Modified-Since': lastModified } });
      }

      if (opt.bustBrowserCache) {
        req = req.clone({
          setParams: { _cb: Date.now().toString() },
        });
      }

      const broadcast = !opt.skipTabSync;

      return next(req).pipe(
        map((event) => {
          if (!(event instanceof HttpResponse)) return event;

          // 304 → server confirmed our cached entry is still valid. Re-stamp the
          // existing entry so subsequent reads within the new freshness window
          // don't trigger another revalidation round-trip, then serve it.
          if (event.status === 304 && entry) {
            // ...unless the key was invalidated while this conditional request was in
            // flight (e.g. by a mutation) — re-storing would resurrect deleted data
            if (cache.getUntracked(key)) {
              const cacheControl = parseCacheControlHeader(event);
              const { staleTime, ttl } = opt.ignoreCacheControl
                ? opt
                : resolveTimings(cacheControl, opt.staleTime, opt.ttl);
              const persist =
                (opt.persist ?? false) &&
                (opt.ignoreCacheControl || !cacheControl.isPrivate);

              cache.store(key, entry.value, staleTime, ttl, persist, broadcast);
            }
            return entry.value;
          }

          if (!event.ok) return event;

          const parsed = opt.parse
            ? new HttpResponse({
                body: opt.parse(event.body),
                headers: event.headers,
                status: event.status,
                url: event.url ?? undefined,
              })
            : event;

          const cacheControl = parseCacheControlHeader(event);
          if (!cacheControl.noStore || opt.ignoreCacheControl) {
            const { staleTime, ttl } = opt.ignoreCacheControl
              ? opt
              : resolveTimings(cacheControl, opt.staleTime, opt.ttl);

            if (ttl !== 0) {
              const persist =
                (opt.persist ?? false) &&
                (opt.ignoreCacheControl || !cacheControl.isPrivate);

              cache.store(key, parsed, staleTime, ttl, persist, broadcast);
            }
          }

          return parsed;
        }),
      );
    });
  };
}
