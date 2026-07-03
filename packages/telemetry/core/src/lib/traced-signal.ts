import { inject, signal, type WritableSignal } from '@angular/core';
import { type SpanHandle } from './sink';
import { TELEMETRY } from './telemetry';

export interface CausalSignal<T> extends WritableSignal<T> {
  /** The active span at the time of the most recent write — `interaction → signal → refetch`. */
  causedBy(): SpanHandle | undefined;
}

/**
 * A writable signal that records the **active span at each write**, so a
 * downstream reactive consumer (e.g. a connector refetch) can attribute itself
 * to the interaction that caused it (see RFC §8.2). Call in an injection context.
 *
 * Capture is **synchronous-only** and last-writer-wins: the cause is the span
 * active during the `set`/`update` call. A write after an `await` inside a
 * `span()` body does NOT attribute (the active-span stack pops synchronously);
 * a write outside any span clears the cause. `causedBy()` is a plain read, not
 * a signal — it never creates a reactive dependency, and causality tracking adds
 * zero recomputations. Read it at the point of use (e.g. inside the refetch),
 * don't derive from it.
 *
 * @experimental
 */
export function tracedSignal<T>(initial: T): CausalSignal<T> {
  const telemetry = inject(TELEMETRY);
  const inner = signal(initial) as CausalSignal<T>;
  let cause: SpanHandle | undefined;

  const set = inner.set.bind(inner);
  const update = inner.update.bind(inner);

  inner.set = (value: T) => {
    cause = telemetry.activeSpan();
    set(value);
  };
  inner.update = (updater: (value: T) => T) => {
    cause = telemetry.activeSpan();
    update(updater);
  };
  inner.causedBy = () => cause;

  return inner;
}
