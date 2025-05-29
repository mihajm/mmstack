import {
  computed,
  type CreateSignalOptions,
  type Signal,
  untracked,
  type ValueEqualityFn,
  type WritableSignal,
} from '@angular/core';
import { getSignalEquality } from './get-signal-equality';
import { mutable } from './mutable';
import { toWritable } from './to-writable';

/**
 * A WritableSignal enhanced with undo/redo capabilities and history tracking.
 *
 * @template T The type of value held by the signal.
 */
export type SignalWithHistory<T> = WritableSignal<T> & {
  /** A read-only signal of the undo history stack. The oldest changes are at the start of the array. */
  history: Signal<T[]>;
  /** Reverts the signal to its most recent previous state in the history. */
  undo: () => void;
  /** Re-applies the last state that was undone. */
  redo: () => void;
  /** A signal that is `true` if there are states in the redo stack. */
  canRedo: Signal<boolean>;
  /** A signal that is `true` if there are states in the undo history. */
  canUndo: Signal<boolean>;
  /** Clears both the undo and redo history stacks. */
  clear: () => void;
  /** A signal that is `true` if there is any history that can be cleared. */
  canClear: Signal<boolean>;
};

/**
 * Options for creating a signal with history tracking.
 *
 * @template T The type of value held by the signal.
 */
export type CreateHistoryOptions<T> = Omit<
  CreateSignalOptions<T[]>,
  'equal'
> & {
  /**
   * Optional custom equality function to determine if a value has changed before
   * adding it to history. Defaults to the source signal's equality function or `Object.is`.
   */
  equal?: ValueEqualityFn<T>;
  /**
   * The maximum number of undo states to keep in the history.
   * @default Infinity
   */
  maxSize?: number;
  /**
   * The strategy for trimming the history when `maxSize` is reached.
   * - `shift`: Removes the single oldest entry from the history.
   * - `halve`: Removes the oldest half of the history stack.
   * @default 'halve'
   */
  cleanupStrategy?: 'shift' | 'halve';
};

/**
 * Enhances an existing `WritableSignal` by adding a complete undo/redo history
 * stack and an API to control it.
 *
 * @template T The type of value held by the signal.
 * @param source The source `WritableSignal` to add history tracking to.
 * @param options Optional configuration for the history behavior.
 * @returns A `SignalWithHistory<T>` instance, augmenting the source signal with history APIs.
 *
 * @remarks
 * - Any new `.set()` or `.update()` call on the signal will clear the entire redo stack.
 * - The primitive attempts to automatically use the source signal's own `equal` function,
 * but this relies on an internal Angular API. For maximum stability across Angular
 * versions, it is recommended to provide an explicit `equal` function in the options.
 *
 * @example
 * ```ts
 * import { signal } from '@angular/core';
 * import { withHistory } from '@mmstack/primitives';
 *
 * const name = withHistory(signal('John'), { maxSize: 5 });
 *
 * console.log('Initial value:', name()); // "John"
 *
 * name.set('John Doe');
 * name.set('Jane Doe');
 *
 * console.log('Current value:', name()); // "Jane Doe"
 * console.log('History:', name.history()); // ["John", "John Doe"]
 * console.log('Can undo:', name.canUndo()); // true
 * console.log('Can redo:', name.canRedo()); // false
 *
 * name.undo();
 * console.log('After undo:', name()); // "John Doe"
 * console.log('Can redo:', name.canRedo()); // true
 *
 * name.redo();
 * console.log('After redo:', name()); // "Jane Doe"
 *
 * // A new change will clear the redo history
 * name.set('Janine Doe');
 * console.log('Can redo:', name.canRedo()); // false
 *
 * name.clear();
 * console.log('Can undo:', name.canUndo()); // false
 * ```
 */
export function withHistory<T>(
  source: WritableSignal<T>,
  opt?: CreateHistoryOptions<T>,
): SignalWithHistory<T> {
  const equal = opt?.equal ?? getSignalEquality(source);
  const maxSize = opt?.maxSize ?? Infinity;

  const history = mutable<T[]>([], {
    ...opt,
    equal: undefined,
  });

  const redoArray = mutable<T[]>([]);

  const originalSet = source.set;

  const set = (value: T) => {
    const current = untracked(source);
    if (equal(value, current)) return;

    source.set(value);

    history.mutate((c) => {
      if (c.length >= maxSize) {
        if (opt?.cleanupStrategy === 'shift') {
          c.shift();
        } else {
          c = c.slice(Math.floor(maxSize / 2));
        }
      }
      c.push(current);
      return c;
    });
    redoArray.set([]);
  };

  const update = (updater: (prev: T) => T) => {
    set(updater(untracked(source)));
  };

  const internal = toWritable(
    computed(() => source(), {
      equal,
      debugName: opt?.debugName,
    }),
    set,
    update,
  ) as SignalWithHistory<T>;
  internal.history = history;

  internal.undo = () => {
    const historyStack = untracked(history);
    if (historyStack.length === 0) return;

    const valueForRedo = untracked(source);
    const valueToRestore = historyStack.at(-1)!;

    originalSet.call(source, valueToRestore);

    history.inline((h) => h.pop());
    redoArray.inline((r) => r.push(valueForRedo));
  };

  internal.redo = () => {
    const redoStack = untracked(redoArray);
    if (redoStack.length === 0) return;

    const valueForUndo = untracked(source);
    const valueToRestore = redoStack.at(-1)!;

    originalSet.call(source, valueToRestore);

    redoArray.inline((r) => r.pop());
    history.mutate((h) => {
      if (h.length >= maxSize) {
        if (opt?.cleanupStrategy === 'shift') {
          h.shift();
        } else {
          h = h.slice(Math.floor(maxSize / 2));
        }
      }
      h.push(valueForUndo);
      return h;
    });
  };

  internal.clear = () => {
    history.set([]);
    redoArray.set([]);
  };

  internal.canUndo = computed(() => history().length > 0);
  internal.canRedo = computed(() => redoArray().length > 0);
  internal.canClear = computed(() => internal.canUndo() || internal.canRedo());

  return internal;
}
