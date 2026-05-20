type UnknownObject = Record<PropertyKey, unknown>;

/**
 * Returns `true` for any object-like value whose own enumerable keys should
 * be sorted for stable hashing. Excludes arrays (positional), `Date`
 * (handled by `toJSON`), `Map`/`Set` (handled explicitly), and binary types
 * (`Blob`/`FormData`/`URLSearchParams`/`ArrayBuffer`/typed arrays — these
 * should be branched on before reaching `hash()`, typically by `hashRequest`).
 *
 * Plain objects, class instances, and `Object.create(null)` all qualify.
 */
function isHashableObject(value: unknown): value is UnknownObject {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  if (value instanceof Map) return false;
  if (value instanceof Set) return false;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return false;
  if (typeof FormData !== 'undefined' && value instanceof FormData) return false;
  if (
    typeof URLSearchParams !== 'undefined' &&
    value instanceof URLSearchParams
  )
    return false;
  if (value instanceof ArrayBuffer) return false;
  if (ArrayBuffer.isView(value)) return false;
  return true;
}

function sortKeys(val: UnknownObject): UnknownObject {
  return Object.keys(val)
    .toSorted()
    .reduce((result, key) => {
      result[key] = val[key];
      return result;
    }, {} as UnknownObject);
}

/**
 * Internal helper to generate a stable JSON string from an array.
 * - Object-like values (plain, class instances, null-proto) get their own
 *   enumerable keys sorted alphabetically.
 * - `Map` → marker object with sorted entries (sorted by `JSON.stringify(key)`).
 * - `Set` → marker object with sorted values (sorted by `JSON.stringify(value)`).
 * - Arrays preserve order. `Date` serializes via `toJSON`.
 *
 * @internal
 */
function hashKey(queryKey: unknown[]): string {
  return JSON.stringify(queryKey, (_, val) => {
    if (val instanceof Map) {
      // Schwartzian: compute each entry's sort key (recursive hash of the
      // Map key) once, then sort by the cheap string compare.
      const entries = [...val.entries()]
        .map((e) => [hash(e[0]), e] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([, e]) => e);
      return { __map__: entries };
    }
    if (val instanceof Set) {
      const values = [...val]
        .map((v) => [hash(v), v] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([, v]) => v);
      return { __set__: values };
    }
    if (isHashableObject(val)) return sortKeys(val);
    return val;
  });
}

/**
 * Generates a stable, unique string hash from one or more arguments.
 * Useful for creating cache keys or identifiers where object key order shouldn't matter.
 *
 * How it works:
 * - Object-like values (plain objects, class instances, `Object.create(null)`) have
 *   their own enumerable keys sorted alphabetically before hashing. This ensures
 *   `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same hash.
 * - `Map` and `Set` are serialized via stable, sorted markers (`__map__` / `__set__`).
 * - Arrays preserve positional order; `Date` uses its ISO string via `toJSON`.
 *
 * @param {...unknown} args Values to include in the hash.
 * @returns A stable string hash representing the input arguments.
 * @example
 * hash('posts', 10);
 * // => '["posts",10]'
 *
 * hash({ a: 1, b: 2 }) === hash({ b: 2, a: 1 }); // true
 *
 * hash(new Map([['a', 1]])) === hash(new Map([['a', 1]])); // true
 *
 * // Be mindful of values JSON.stringify cannot handle (functions, undefined, Symbols)
 * // hash('a', undefined, function() {}) => '["a",null,null]'
 */
export function hash(...args: unknown[]): string {
  return hashKey(args);
}
