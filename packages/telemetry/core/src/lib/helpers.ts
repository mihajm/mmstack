import { inject } from '@angular/core';
import { type SpanCallOptions, TELEMETRY } from './telemetry';

/**
 * Span around a sync or async `fn` — convenience over `inject(TELEMETRY).span(...)`.
 * Call in an injection context.
 */
export function traced<T>(name: string, fn: () => T, opt?: SpanCallOptions): T {
  return inject(TELEMETRY).span(name, fn, opt);
}

/**
 * Wrap a callback / output handler so **each invocation** runs inside a span.
 * Captures `TELEMETRY` once at creation (call in an injection context); the
 * returned function is usable anywhere (e.g. as an `(click)` handler or
 * `output().subscribe(...)` callback).
 */
export function tracedCallback<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => R,
  opt?: SpanCallOptions,
): (...args: A) => R {
  const telemetry = inject(TELEMETRY);
  return (...args: A) => telemetry.span(name, () => fn(...args), opt);
}
