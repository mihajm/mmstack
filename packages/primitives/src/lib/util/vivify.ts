import { isIndexProp } from './is-index-prop';

/** @internal Narrows `'array'` so it is only assignable when `T` is an array type. */
type VivifyArray<T> = T extends any[] ? 'array' : never;
/** @internal Narrows `'object'` so it is only assignable when `T` is an object type. */
type VivifyObject<T> = T extends object ? 'object' : never;

/**
 * Controls **autovivification** — whether, and as what shape, a writable `derived` (or `store`)
 * creates a missing container when the source value is `null`/`undefined` at the moment of a
 * write. Without it, writing through a nullish value is a no-op; with it, a deep write such as
 * `derived(user, 'name', { vivify: 'object' }).set('Ada')` materializes the missing object
 * instead of silently dropping the write.
 *
 * A **present** value is always preserved — updated in place for a `MutableSignal` source,
 * copied for an immutable one. Vivification only ever *creates*, it never *replaces*.
 *
 * Variants:
 * - `false` — **default.** Off; a write through a nullish source does nothing.
 * - `true` / `'auto'` — infer the shape from the key: an array (`[]`) for a numeric / index key,
 *   a plain object (`{}`) otherwise.
 * - `'object'` — always create a plain object (`{}`). Only assignable when `T` is an object.
 * - `'array'` — always create an array (`[]`). Only assignable when `T` is an array.
 * - `() => T` — a factory producing the container to create. Called only on a nullish source,
 *   once per vivification (a fresh instance each time), so a present value is never clobbered.
 *   Useful for seeding defaults, e.g. `() => ({ items: [], total: 0 })`.
 *
 * @typeParam T - The type of the container that may be created (the source/parent value).
 *
 * @example
 * ```ts
 * const user = signal<{ name: string } | null>(null);
 *
 * derived(user, 'name').set('Ada');                       // off: dropped, user() === null
 * derived(user, 'name', { vivify: 'object' }).set('Ada'); // user() === { name: 'Ada' }
 * ```
 */
export type Vivify<T = any> =
  | 'auto'
  | boolean
  | (() => T)
  | VivifyArray<T>
  | VivifyObject<T>;

/**
 * Options mix-in that adds an optional {@link Vivify} setting to the `options` argument of the
 * `derived` / `store` key & index overloads.
 *
 * @typeParam T - The type of the container that may be vivified (the source/parent value).
 */
export type WithVivify<T> = {
  /**
   * Whether, and as what shape, to create a missing container when the source value is
   * `null`/`undefined` at write time. Defaults to `false` (no vivification). See {@link Vivify}.
   */
  vivify?: Vivify<T>;
};

/**
 * @internal
 * A resolved vivification function, produced by {@link createVivify}. Given the `current` value
 * and the `key` about to be written, it returns the container to write into: the current value
 * when present, or a freshly created one when `current` is `null`/`undefined`.
 */
export type VivifyFn<T> = (current: T, key: PropertyKey) => T;

// Container resolvers used by createVivify: each returns the current value when present and
// only creates a new container when it is null/undefined.
function identity<T>(x: T): T {
  return x;
}

function createArray<T>(cur: T): T {
  if (cur === null || cur === undefined) return [] as unknown as T;
  return cur;
}

function createObject<T>(cur: T): T {
  if (cur === null || cur === undefined) return {} as unknown as T;
  return cur;
}

function createAuto<T>(cur: T, key: PropertyKey): T {
  if (cur === null || cur === undefined) {
    return typeof key === 'number' || isIndexProp(key)
      ? ([] as unknown as T)
      : ({} as unknown as T);
  }
  return cur;
}

/**
 * @internal
 * Resolves a {@link Vivify} option into a {@link VivifyFn}. The returned function leaves a
 * present value untouched and only creates a new container — object, array, or factory result —
 * when the current value is `null`/`undefined`.
 */
export function createVivify<T>(option: Vivify<T>): VivifyFn<T> {
  switch (option) {
    case false:
      return identity;
    case 'array':
      return createArray;
    case 'object':
      return createObject;
    case 'auto':
    case true:
      return createAuto;
    default:
      return typeof option === 'function'
        ? (cur: T) =>
            cur === null || cur === undefined ? (option as () => T)() : cur
        : identity;
  }
}
