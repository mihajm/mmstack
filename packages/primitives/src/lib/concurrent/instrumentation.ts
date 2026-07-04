import { InjectionToken, type Provider } from '@angular/core';

/**
 * Optional observability seam for the concurrency layer (idea/concurrency-devtools.md). A
 * listener, provided via {@link provideConcurrencyInstrumentation}, receives events as
 * transition scopes coordinate pending/suspense/transaction windows and register resources.
 * Zero-cost when absent: the taps are `listener?.hook(...)` behind a once-resolved optional
 * inject, so nothing is allocated or measured unless a listener is installed.
 *
 * Span-shaped hooks (`*Start`) return an opaque handle passed back to their `*End`, and carry
 * `at` epoch-ms stamps — deliberately isomorphic to the telemetry `startSpan`/`SpanHandle` SPI,
 * so a telemetry consumer maps one-to-one.
 */
export type ConcurrencyInstrumentation = {
  pendingStart?(e: { scope: string; resources: number; at: number }): unknown;
  pendingEnd?(handle: unknown, e: { at: number }): void;
  transactionStart?(e: { scope: string; at: number }): unknown;
  transactionEnd?(handle: unknown, e: { at: number }): void;
  resourceRegistered?(e: { scope: string; suspends: boolean }): void;
  resourceRemoved?(e: { scope: string }): void;
  abortPending?(e: { scope: string; aborted: number; at: number }): void;
};

export const CONCURRENCY_INSTRUMENTATION =
  new InjectionToken<ConcurrencyInstrumentation>(
    '@mmstack/primitives:concurrency-instrumentation',
  );

export function provideConcurrencyInstrumentation(
  listener: ConcurrencyInstrumentation,
): Provider {
  return { provide: CONCURRENCY_INSTRUMENTATION, useValue: listener };
}

const now = (): number =>
  typeof globalThis.performance !== 'undefined'
    ? globalThis.performance.now()
    : Date.now();

/**
 * Chrome DevTools "Performance" custom-tracks preset (idea/concurrency-devtools.md): writes a
 * `performance.measure` for each pending/transaction window onto an "mmstack" extension track,
 * so reactive coordination shows up on the Performance panel timeline. Dev-only, zero backend,
 * no dependencies. Give each measure the scope name for readability.
 */
export function perfCustomTracks(
  track = 'mmstack concurrency',
): ConcurrencyInstrumentation {
  const canMeasure =
    typeof globalThis.performance !== 'undefined' &&
    typeof globalThis.performance.measure === 'function';

  const span = (name: string, start: number): void => {
    if (!canMeasure) return;
    try {
      globalThis.performance.measure(name, {
        start,
        end: now(),
        detail: {
          devtools: { dataType: 'track-entry', track, color: 'primary' },
        },
      } as PerformanceMeasureOptions);
    } catch {
      // measure options with detail are unsupported on this engine — skip silently
    }
  };

  return {
    pendingStart: (e) => e.at,
    pendingEnd: (handle, e) => span(`pending`, (handle as number) ?? e.at),
    transactionStart: (e) => e.at,
    transactionEnd: (handle, e) =>
      span(`transaction`, (handle as number) ?? e.at),
  };
}
