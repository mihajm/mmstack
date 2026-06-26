/**
 * Runtime marker + compile-time brand for an opaque value. A `const`-declared `Symbol`
 * has a `unique symbol` type, so the same symbol serves as both the property key written
 * by {@link opaque} and the type-level brand carried by {@link Opaque}.
 */
export const OPAQUE: unique symbol = Symbol(
  '@mmstack/primitives::store/OPAQUE',
);

/**
 * Marks a plain object as opaque so {@link store} treats it as an indivisible leaf
 * (returned whole, never deep-proxied) — the same way it treats a `Date` or `RegExp`.
 * The marker is a non-enumerable symbol, so it never appears in spreads or iteration.
 * Idempotent. Call before freezing (`defineProperty` fails on a frozen object).
 *
 * @example
 * const s = store({ config: opaque({ theme: 'dark', nested: { a: 1 } }) });
 * s.config();        // the whole object, not a child store
 * s.config.set(opaque({ theme: 'light', nested: { a: 2 } }));
 */
export function opaque<T extends object>(value: T): Opaque<T> {
  if ((value as any)[OPAQUE] !== true)
    Object.defineProperty(value, OPAQUE, { value: true, enumerable: false });
  return value as Opaque<T>;
}

/**
 * Type guard companion to {@link opaque}: returns `true` when `value` carries the
 * {@link OPAQUE} brand, narrowing it to {@link Opaque}. This is the same check the
 * store uses to route opaque values to its leaf branch (alongside `Date`/`RegExp`).
 *
 * @internal Exposed for advanced/niche interop only — not part of the supported public
 * surface and may change without a major version bump. Reach for {@link opaque} for
 * normal usage.
 *
 * @example
 * if (isOpaque(value)) {
 *   // value: Opaque<object> — `store` would treat it as an indivisible leaf
 * }
 */
export function isOpaque<T = object>(value: unknown): value is Opaque<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as any)[OPAQUE] === true
  );
}

/**
 * An object marked via {@link opaque} — the store treats it as an indivisible leaf
 * (like a `Date`), returning it whole instead of deep-proxying its keys.
 */
export type Opaque<T> = T & { readonly [OPAQUE]: true };

/** @internal Strips the opaque brand from the value a leaf signal carries. */
export type UnwrapOpaque<T> = T extends { readonly [OPAQUE]: true }
  ? Omit<T, typeof OPAQUE>
  : T;
