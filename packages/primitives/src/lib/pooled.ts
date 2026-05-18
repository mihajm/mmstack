import {
  computed,
  untracked,
  type CreateSignalOptions,
  type Signal,
} from '@angular/core';

/**
 * Derives a value (`U`) from a freshly-reset buffer (`T`). Mutate the buffer
 * and either return it directly or derive a different value from it. Naming
 * matches Angular's `linkedSignal` `computation` convention.
 */
export type Computation<T, U> = (buffer: T) => U;

/**
 * Options for {@link pooled}.
 */
export type CreatePooledOptions<T, U = T> = {
  /** Factory for a buffer slot. Called at most twice in total per pool. */
  create: () => T;
  /**
   * Restores a dirty buffer in-place, or returns a replacement instance. Not
   * called on freshly-created buffers — only on reused ones.
   */
  reset: (dirty: T) => void | T;
  /** Writes into the buffer and returns the derived value. */
  computation: Computation<T, U>;
  /**
   * Pre-allocate both buffer slots at construction. Use when `create()` is
   * expensive and you'd rather pay the cost up front than on the first reads.
   * @default false
   */
  eager?: boolean;
} & CreateSignalOptions<U>;

/**
 * A `Signal<U>` backed by a two-slot object pool: `create` is called at most
 * twice over the pool's lifetime, and the two `T` instances are swapped on
 * every recomputation with `reset` invoked on the dirty one before
 * `computation` writes into it. Consecutive reads return different identities,
 * so the default `Object.is` equality still flags changes.
 *
 * **Retention contract:** the returned value is only valid until the next
 * recomputation of this signal. The container is recycled and `reset`,
 * mutating any reference you still hold — do not store the result, pass it to
 * async code, or hand it to consumers that outlive the current reactive tick.
 *
 * For collection buffers prefer the presets: {@link pooledArray},
 * {@link pooledMap}, {@link pooledSet}.
 *
 * @see [Angular `linkedSignal`](https://angular.dev/api/core/linkedSignal) — carries previous *state* forward; complementary, not a substitute.
 *
 * @example
 * ```ts
 * const source = signal<{ active: boolean }[]>([]);
 *
 * const counters = pooled<{ total: number; active: number }>({
 *   create: () => ({ total: 0, active: 0 }),
 *   reset: (c) => { c.total = 0; c.active = 0; },
 *   computation: (c) => {
 *     for (const item of source()) { c.total++; if (item.active) c.active++; }
 *     return c;
 *   },
 * });
 * ```
 */
export function pooled<T, U = T>({
  create,
  reset,
  computation,
  ...opt
}: CreatePooledOptions<T, U>): Signal<U> {
  let other: T | undefined = opt.eager ? create() : undefined;
  let current: T | undefined = opt.eager ? create() : undefined;
  let otherFresh = opt.eager;
  let currentFresh = opt.eager;

  return computed(() => {
    let next: T;
    let nextFresh: boolean;

    if (other !== undefined) {
      next = other;
      nextFresh = !!otherFresh;
    } else {
      next = untracked(() => create());
      nextFresh = true;
    }

    if (current !== undefined) {
      other = current;
      otherFresh = currentFresh;
    }
    current = next;
    // the buffer is about to be mutated by `computation`, so it's no longer fresh
    currentFresh = false;

    const clean = nextFresh ? next : (untracked(() => reset(next)) ?? next);

    return computation(clean);
  }, opt);
}
