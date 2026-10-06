import { computed, type WritableSignal } from '@angular/core';
import { isMutable, type MutableSignal } from '../mutable';
import type { RecordOptions } from './transaction';

type Recorder = {
  record(sig: WritableSignal<unknown>, opt?: RecordOptions): void;
};

let active: Recorder | null = null;

/** @internal The recorder in effect right now. */
export function currentRecorder(): Recorder | null {
  return active;
}

/** @internal Swap the active recorder; returns the previous one. */
export function swapRecorder(next: Recorder | null): Recorder | null {
  const prev = active;
  active = next;
  return prev;
}

const declared = new WeakMap<WritableSignal<unknown>, RecordOptions>();
const silent = new WeakSet<object>();
const wrapped = new WeakMap<object, WritableSignal<unknown>>();

/**
 * @internal The signal recorded for writes through `sig`: a `transactional` wrapper's source,
 * else `sig` itself.
 */
export function recordTargetOf(sig: object): object {
  return wrapped.get(sig) ?? sig;
}

/** @internal Writes through `from` are recorded against `to` (see `recordTargetOf`). */
export function mapRecordTarget(
  from: object,
  to: WritableSignal<unknown>,
): void {
  wrapped.set(from, to);
}

/** @internal How `recordWrite` records this signal (a store root declares its merge). */
export function declareRecordOptions(
  sig: WritableSignal<unknown>,
  opt: RecordOptions,
): void {
  declared.set(sig, opt);
}

/**
 * @internal This signal's writes are recorded elsewhere: by itself (a forwarding signal records
 * its source) or upstream (a store node's write reaches the root, which records). `recordWrite`
 * skips it, so a chain of forwarders records exactly one target.
 */
export function recordsElsewhere(sig: object): void {
  silent.add(sig);
}

/** @internal Whether `sig`'s writes are recorded elsewhere (see `recordsElsewhere`). */
export function isRecordedElsewhere(sig: object): boolean {
  return silent.has(sig);
}

/** @internal Record `sig` into the active transaction, if any, before writing it. */
export function recordWrite(sig: WritableSignal<unknown>): void {
  if (!active || silent.has(sig)) return;
  active.record(sig, declared.get(sig));
}

/**
 * Wraps a writable (or mutable) signal so its writes are recorded in the active transaction
 * before they land: an abort inside `startTransaction` then undoes them. Reads, `set`, `update`
 * (and `mutate` / `inline` for a mutable signal) behave as on `sig`; writes made directly on
 * `sig` stay unrecorded.
 */
export function transactional<T>(sig: MutableSignal<T>): MutableSignal<T>;
export function transactional<T>(sig: WritableSignal<T>): WritableSignal<T>;
export function transactional<T>(
  sig: WritableSignal<T> | MutableSignal<T>,
): WritableSignal<T> | MutableSignal<T> {
  const target = sig as WritableSignal<unknown>;
  // an in-place write keeps the reference, so a mutable source must always notify through
  const out = computed(
    () => sig(),
    isMutable(sig) ? { equal: () => false } : undefined,
  ) as unknown as MutableSignal<T>;
  out.asReadonly = () => sig.asReadonly();
  out.set = (v) => {
    recordWrite(target);
    sig.set(v);
  };
  out.update = (fn) => {
    recordWrite(target);
    sig.update(fn);
  };
  if (isMutable(sig)) {
    out.mutate = (fn) => {
      recordWrite(target);
      sig.mutate(fn);
    };
    out.inline = (fn) => {
      recordWrite(target);
      sig.inline(fn);
    };
  }
  recordsElsewhere(out);
  wrapped.set(out, target);
  return out;
}
