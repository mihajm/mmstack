import {
  HttpContext,
  HttpContextToken,
  HttpErrorResponse,
  HttpEventType,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { finalize, tap } from 'rxjs';
import { type SpanHandle } from './sink';
import { TELEMETRY } from './telemetry';

/**
 * Attach a parent span to a request so its HTTP span nests under a caller span:
 * `http.get(url, { context: withTelemetryParent(span) })`. Without it, the HTTP
 * span is its own (flat) trace.
 */
export const TELEMETRY_HTTP_PARENT = new HttpContextToken<SpanHandle | undefined>(() => undefined);

export function withTelemetryParent(parent: SpanHandle, context = new HttpContext()): HttpContext {
  return context.set(TELEMETRY_HTTP_PARENT, parent);
}

/** Host + path only — drops query string and any embedded values (privacy-safe default). */
function safeUrl(raw: string): string {
  const noQuery = raw.split('?')[0] ?? raw;
  try {
    const url = new URL(noQuery); // throws for relative URLs
    return url.host + url.pathname;
  } catch {
    return noQuery; // relative path, already query-stripped
  }
}

function now(): number {
  return (globalThis.performance ?? Date).now();
}

/**
 * One span per HTTP request. Works with plain `HttpClient`. Conservative default
 * attributes: method, host+path, status, duration — never the full URL/query or body.
 * Nests under a parent via {@link TELEMETRY_HTTP_PARENT}; flat otherwise.
 */
export const telemetryInterceptor: HttpInterceptorFn = (req, next) => {
  const telemetry = inject(TELEMETRY);
  if (!telemetry.enabled()) return next(req);

  const span = telemetry.startSpan(`HTTP ${req.method}`, {
    parent: req.context.get(TELEMETRY_HTTP_PARENT),
    attrs: { 'http.method': req.method, 'http.target': safeUrl(req.url) },
  });
  const startedAt = now();

  let stream: ReturnType<typeof next>;
  try {
    stream = next(req);
  } catch (err) {
    // a downstream interceptor threw synchronously — don't leak an open span
    span.setError(err);
    span.setAttrs({ 'http.duration_ms': Math.round(now() - startedAt) });
    span.end();
    throw err;
  }

  return stream.pipe(
    tap({
      next: (event) => {
        if (event.type === HttpEventType.Response) {
          span.setAttrs({ 'http.status_code': event.status });
        }
      },
      error: (err: unknown) => {
        if (err instanceof HttpErrorResponse) span.setAttrs({ 'http.status_code': err.status });
        span.setError(err);
      },
    }),
    finalize(() => {
      span.setAttrs({ 'http.duration_ms': Math.round(now() - startedAt) });
      span.end();
    }),
  );
};
