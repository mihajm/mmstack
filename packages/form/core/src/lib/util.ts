/**
 * Merges two arrays element by element using the `mergeIfObject` logic.
 *
 * The resulting array will have the same length as the `next` array.
 * For each index `i`, the element in the resulting array is determined by:
 * `mergeIfObject(prev[i], next[i])`.
 * If `prev` is shorter than `next`, `prev[i]` will be `undefined` for the out-of-bounds indices.
 *
 * @template {any[]} T The array type being merged.
 * @param {T} prev The previous array.
 * @param {T} next The next array.
 * @returns {T} A new array containing the merged elements.
 * @example
 * const prev = [1, { id: 1, name: "A" }, [10],        "extraPrev"];
 * const next = [2, { id: 1, status: "B" }, [20, 21],  missing  , { id: 2 }];
 *
 * mergeArray(prev, next);
 * // Result approx:
 * // [
 * //   2,                               // Primitive replaced
 * //   { id: 1, name: "A", status: "B" }, // Objects shallow-merged
 * //   [20, 21],                          // Arrays replaced (via mergeIfObject -> mergeArray)
 * //   undefined,                         // Primitive replaced by missing item in sparse 'next' array
 * //   { id: 2 }                          // Added from 'next' (prev[4] was undefined)
 * // ]
 */
export function mergeArray<T extends any[]>(prev: T, next: T): T {
  return next.map((item, index): T[number] =>
    mergeIfObject<T[number]>(prev[index], item),
  ) as T;
}

/**
 * Merges two values (`prev`, `next`), prioritizing `next` in most cases.
 *
 * Behavior:
 * - If both `prev` and `next` are non-null, non-array objects, it performs a **shallow merge**
 * (`{ ...prev, ...next }`), where properties from `next` overwrite those in `prev`.
 * - If both `prev` and `next` are arrays, it delegates to `mergeArray` for element-wise merging.
 * - In all other scenarios (type mismatch, primitives, null involved, array mixed with object),
 * it simply returns the `next` value.
 *
 * @template T The type of the values being merged.
 * @param {T | undefined} prev The previous value (can be undefined if accessed out of array bounds).
 * @param {T} next The next value.
 * @returns {T} The merged result based on the rules above.
 */
export function mergeIfObject<T>(prev: T, next: T): T {
  if (typeof prev !== typeof next) return next;
  if (typeof prev !== 'object' || typeof next !== 'object') return next;
  if (prev === null || next === null) return next;
  if (Array.isArray(prev) && Array.isArray(next)) return mergeArray(prev, next);
  if (Array.isArray(prev) || Array.isArray(next)) return next;

  return { ...prev, ...next };
}

/**
 * Generates a unique ID using crypto.randomUUID if available,
 * otherwise falls back to a non-secure random string.
 * @returns {string}
 */
export function generateID() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2);
}
