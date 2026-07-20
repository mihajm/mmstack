import { computed, type WritableSignal } from '@angular/core';
import { isDerivation } from './derived';
import { isMutable, type MutableSignal } from './mutable';
import { isStored, type StoredSignal } from './stored';

/**
 * A member of the writable-signal family that has been wrapped by {@link traced}.
 * It carries the full surface of the wrapped signal `S` plus a {@link Traced.causedBy}
 * read that reports the cause recorded at the most recent write.
 *
 * @typeParam S - The wrapped writable-signal type (e.g. `WritableSignal`, `MutableSignal`, `DerivedSignal`).
 * @typeParam C - The type of the captured cause.
 */
export type Traced<S extends WritableSignal<unknown>, C> = S & {
  /**
   * The cause captured during the most recent synchronous write, or `undefined`
   * if the last write happened with no ambient cause. This is a plain read, not
   * a signal — it never creates a reactive dependency and adds zero recomputations.
   */
  causedBy(): C | undefined;
};

/**
 * Wraps any member of the writable-signal family so that every synchronous write
 * first records an ambient "cause" (via the caller-provided `capture` function)
 * and then delegates to the original write, preserving the wrapped signal's exact
 * write semantics. The recorded cause is exposed through a plain {@link Traced.causedBy}
 * read, letting a downstream consumer attribute a change to whatever caused it —
 * without any dependency on a particular telemetry system.
 *
 * Capture is **synchronous-only** and last-writer-wins: the cause is whatever
 * `capture()` returns during the `set`/`update`/`mutate`/`inline` call. A write
 * performed after an `await` (once the ambient cause has been cleared) records
 * `undefined`; a write while `capture()` returns `undefined` clears the cause.
 * `causedBy()` is a plain read, not a signal — reading it never subscribes, and
 * a cause-only change (a write with a different cause but no dependent-visible
 * value change) never invalidates a consumer.
 *
 * The traced twin behaves like the original except for `causedBy`: it carries the
 * wrapped signal's surface — `asReadonly`, the `mutate`/`inline` methods of a
 * mutable, and the `from` of a derived — and the underlying write semantics survive
 * (a traced `derived` still writes through to its source; a traced `toWritable` still
 * runs its custom `set`). Reads through the twin stay tracked — consumers subscribe
 * exactly as they would to the source.
 *
 * @typeParam S - The wrapped writable-signal type.
 * @typeParam C - The type of the captured cause.
 *
 * @param sig - The writable signal to trace. Any family member is accepted
 *              (`signal`, `mutable`, `derived`, `toWritable`, `stored`, ...).
 * @param capture - A function invoked synchronously at the start of every write.
 *                  Its return value becomes the current cause; returning `undefined`
 *                  clears it.
 * @param opt - Optional configuration.
 * @param opt.pure - If `true` (the default), the returned twin is a **new** signal
 *                   that reads through to `sig`; `sig` itself is left untouched, so
 *                   tracing a shared signal never makes the original writable or
 *                   alters its behaviour.
 *
 *                   CAUTION: with `pure: false` the write methods are patched
 *                   directly onto the `sig` object you passed in — every other
 *                   holder of that signal now records causes on write. Only use it
 *                   with a signal you created and own exclusively.
 *
 * @returns A {@link Traced} twin of `sig` exposing `causedBy()`.
 *
 * @example
 * // A refetch attributing itself to whatever wrote the query.
 * let activeCause: string | undefined;
 * const query = traced(signal(''), () => activeCause);
 *
 * activeCause = 'user-typed';
 * query.set('hello');
 * query.causedBy(); // 'user-typed'
 *
 * @example
 * // Tracing a shared, read-only-exposed signal without making it writable.
 * const shared = signal(0);
 * const twin = traced(shared, () => currentInteraction());
 * twin === shared; // false — the original is untouched
 */
export function traced<S extends WritableSignal<unknown>, C>(
  sig: S,
  capture: () => C | undefined,
  opt?: { pure?: boolean },
): Traced<S, C> {
  const twin = (opt?.pure === false ? sig : facadeOf(sig)) as Traced<S, C>;

  let cause: C | undefined;

  const setOriginal = sig.set.bind(sig);
  twin.set = (value) => {
    cause = capture();
    setOriginal(value);
  };

  const updateOriginal = sig.update.bind(sig);
  twin.update = (updater) => {
    cause = capture();
    updateOriginal(updater);
  };

  if (isMutable(sig)) {
    const source = sig as MutableSignal<unknown>;
    const mutableTwin = twin as unknown as MutableSignal<unknown>;

    const mutateOriginal = source.mutate.bind(source);
    mutableTwin.mutate = (updater) => {
      cause = capture();
      mutateOriginal(updater);
    };

    const inlineOriginal = source.inline.bind(source);
    mutableTwin.inline = (updater) => {
      cause = capture();
      inlineOriginal(updater);
    };
  }

  if (isStored(sig)) {
    const source = sig as StoredSignal<unknown>;
    const storedTwin = twin as unknown as StoredSignal<unknown>;

    const clearOriginal = source.clear.bind(source);
    storedTwin.clear = () => {
      cause = capture();
      clearOriginal();
    };
  }

  twin.causedBy = () => cause;

  return twin;
}

/**
 * Builds a read-through facade over `sig`: a fresh signal whose reads track `sig`,
 * carrying `sig`'s non-write surface (`asReadonly`, and `from` on a derived signal)
 * by explicit delegation. The write methods are attached by {@link traced}. The
 * facade's `equal` always reports "changed", so it forwards every notification `sig`
 * emits — including the same-reference `mutate`/`inline` force-notifies that a default
 * `computed` would swallow (see `mutable`'s docs). The change decision is thereby
 * delegated entirely to `sig`.
 */
function facadeOf<S extends WritableSignal<unknown>>(sig: S): S {
  const facade = computed(sig, { equal: () => false }) as unknown as S;

  facade.asReadonly = sig.asReadonly.bind(sig);

  if (isDerivation(sig)) {
    (facade as unknown as { from: unknown }).from = sig.from;
  }

  return facade;
}
