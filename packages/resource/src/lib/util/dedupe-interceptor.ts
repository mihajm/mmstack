// Heavily inspired by: https://dev.to/kasual1/request-deduplication-in-angular-3pd8

import {
  HttpContext,
  HttpContextToken,
  type HttpEvent,
  type HttpHandlerFn,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import { type Observable } from 'rxjs';
import { hashRequest } from './hash-request';
import { sharePending } from './share-pending';

const NO_DEDUPE = new HttpContextToken<boolean>(() => false);

/**
 * Disables request deduplication for a specific HTTP request.
 *
 * @param ctx - The `HttpContext` to modify. If not provided, a new `HttpContext` is created.
 * @returns The modified `HttpContext` with the `NO_DEDUPE` token set to `true`.
 *
 * @example
 * // Disable deduplication for a specific POST request:
 * const context = noDedupe();
 * this.http.post('/api/data', payload, { context }).subscribe(...);
 *
 * // Disable deduplication, modifying an existing context:
 * let context = new HttpContext();
 * context = noDedupe(context);
 * this.http.post('/api/data', payload, { context }).subscribe(...);
 */
export function noDedupe(ctx: HttpContext = new HttpContext()) {
  return ctx.set(NO_DEDUPE, true);
}

/**
 * Creates an `HttpInterceptorFn` that deduplicates identical HTTP requests.
 * If multiple identical requests (same URL and parameters) are made concurrently,
 * only the first request will be sent to the server. Subsequent requests will
 * receive the response from the first request.
 *
 * Relationship to `createCacheInterceptor`: the cache interceptor has built-in
 * single-flight for CACHE-ENABLED requests (keyed by the cache key). This interceptor
 * covers everything the cache doesn't see — non-cached resources, plain HttpClient
 * calls, DELETEs — keyed by the request hash. Installing both is the recommended
 * setup; where they overlap, this one degrades to a no-op passthrough.
 *
 * @param allowed - An array of HTTP methods for which deduplication should be enabled.
 *                  Defaults to `['GET', 'DELETE', 'HEAD', 'OPTIONS']`.
 * @param keyFn - Optional function to compute the dedupe key from a request.
 *                Defaults to `hashRequest`, which includes method, URL,
 *                response type, params, and body.
 *
 * @returns An `HttpInterceptorFn` that implements the request deduplication logic.
 *
 * @example
 * // In your app.config.ts or module providers:
 * import { provideHttpClient, withInterceptors } from '@angular/common/http';
 * import { createDedupeRequestsInterceptor } from './your-dedupe-interceptor';
 *
 * export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideHttpClient(withInterceptors([createDedupeRequestsInterceptor()])),
 *     // ... other providers
 *   ],
 * };
 *
 * // You can also specify which methods should be deduped
 *  export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideHttpClient(withInterceptors([createDedupeRequestsInterceptor(['GET'])])), // only dedupe GET calls
 *     // ... other providers
 *   ],
 * };
 */
export function createDedupeRequestsInterceptor(
  allowed = ['GET', 'DELETE', 'HEAD', 'OPTIONS'],
  keyFn: (req: HttpRequest<unknown>) => string = hashRequest,
): HttpInterceptorFn {
  const inFlight = new Map<string, Observable<HttpEvent<unknown>>>();

  const DEDUPE_METHODS = new Set<string>(allowed);

  return (
    req: HttpRequest<unknown>,
    next: HttpHandlerFn,
  ): Observable<HttpEvent<unknown>> => {
    if (!DEDUPE_METHODS.has(req.method) || req.context.get(NO_DEDUPE))
      return next(req);

    return sharePending(inFlight, keyFn(req), () => next(req));
  };
}
