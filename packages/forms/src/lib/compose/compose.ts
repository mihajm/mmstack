import { computed, inject, isSignal, type Signal } from '@angular/core';
import {
  type FieldState,
  FORM_FIELD,
  type FormField,
  MetadataKey,
} from '@angular/forms/signals';

/**
 * A handle to the field bound to the current `[formField]` host, resolved by a single
 * `inject(FORM_FIELD)`. Passed to every {@link FieldProjector} so a composition injects once.
 */
export type FieldRef = {
  /** The live `FieldState` of the bound field (`= FormField.state`). */
  readonly state: Signal<FieldState<unknown>>;
  /** The `FormField` directive instance bound to the host. */
  readonly formField: FormField<unknown>;
};

/**
 * What a {@link FieldProjector} may return: a value, a getter `() => T`, or a `Signal<T>` —
 * {@link compose}/{@link injectField} normalize all three to a `Signal<T>`.
 */
export type FieldProjection<T> = T | (() => T);

/**
 * The composable unit: a pure projection from the (already-injected) {@link FieldRef} to a
 * {@link FieldProjection}. Performs no injection, so many projectors share one injected field.
 *
 * Read field state **lazily** — return a getter/signal, not an eager `f.state()` call.
 * `compose`/`injectField` run in a control's field initializers, before `[formField]` binds:
 * `(f) => () => f.state().invalid()` is safe; `(f) => f.state().invalid` throws.
 */
export type FieldProjector<T> = (field: FieldRef) => FieldProjection<T>;

/**
 * Projector over a field's METADATA — surfaces rule metadata (Angular's native
 * `REQUIRED` / `MIN` / `MAX` / …, or your own keys) into a composition without the
 * hand-rolled `(f) => () => f.state().metadata(KEY)?.() ?? fallback` getter:
 *
 * ```ts
 * import { MIN, REQUIRED } from '@angular/forms/signals';
 *
 * const [numberField, injectNumberField] = composition({
 *   required: fromMetadata(REQUIRED, false), // Signal<boolean>
 *   min: MIN, // a bare key composes directly ≡ fromMetadata(MIN) — Signal<number | undefined>
 * });
 * ```
 *
 * A bare {@link MetadataKey} in a composition is sugar for the no-fallback form; reach for
 * `fromMetadata` explicitly when you want a fallback. Only `undefined` counts as unset (a
 * schema-set `null` is a real value — the same rule `fieldMetadata` follows); with a `fallback`
 * the projected signal never yields `undefined`.
 */
export function fromMetadata<T>(
  key: MetadataKey<Signal<T>, any, any>,
  fallback: T,
): FieldProjector<T>;
export function fromMetadata<T>(
  key: MetadataKey<Signal<T>, any, any>,
): FieldProjector<T | undefined>;
export function fromMetadata<T>(
  key: MetadataKey<Signal<T>, any, any>,
  ...fallback: [T?]
): FieldProjector<T | undefined> {
  return (field) => () => {
    const value = field.state().metadata(key)?.();
    return value === undefined && fallback.length ? fallback[0] : value;
  };
}

/**
 * Marks a value (e.g. a schema rule from `fieldMetadata`) as carrying a default
 * {@link FieldProjector}, so it can be dropped straight into {@link compose}.
 */
export const PROJECTOR: unique symbol = Symbol(
  '@mmstack/forms:field-projector',
);

/**
 * Anything usable as a {@link compose} value: a raw {@link FieldProjector}, a carrier that
 * exposes one under the {@link PROJECTOR} symbol (e.g. a `fieldMetadata` rule), or a
 * {@link MetadataKey} directly — native (`REQUIRED`, `MIN`, …) or a `fieldMetadata` key — which
 * materializes as {@link fromMetadata} without a fallback (`Signal<T | undefined>`; reach for
 * `fromMetadata(key, fallback)` when you need one).
 */
export type Projectable<T = unknown> =
  | FieldProjector<T>
  | { readonly [PROJECTOR]: FieldProjector<T> }
  | MetadataKey<Signal<T>, any, any>;

/**
 * Marks a projected value to bypass signal-normalization. Use it for non-signal members of a
 * composition — e.g. methods like `reset`/`reconcile` — so they are exposed as-is.
 */
export const RAW: unique symbol = Symbol('@mmstack/forms:raw-projection');
export type RawProjection<T> = { readonly [RAW]: T };

/** Wrap a value so `compose`/`injectField` expose it verbatim instead of normalizing to a `Signal`. */
export function raw<T>(value: T): RawProjection<T> {
  return { [RAW]: value };
}

/** Extracts the raw return type of a projectable's projector. */
type ProjectorReturn<P> = P extends {
  readonly [PROJECTOR]: (field: FieldRef) => infer R;
}
  ? R
  : P extends (field: FieldRef) => infer R
    ? R
    : never;

/** Resolves the value type a {@link FieldProjection} normalizes to. */
type ProjectionValue<R> =
  R extends Signal<infer U> ? U : R extends () => infer U ? U : R;

/** The materialized value a {@link Projectable} produces in {@link compose} (a `Signal`, or a raw value). */
export type Projected<P> =
  P extends MetadataKey<Signal<infer U>, any, any>
    ? Signal<U | undefined>
    : ProjectorReturn<P> extends RawProjection<infer R>
      ? R
      : Signal<ProjectionValue<ProjectorReturn<P>>>;

function resolveProjector(p: Projectable): FieldProjector<unknown> {
  if (p instanceof MetadataKey) return fromMetadata(p);
  return (PROJECTOR in p ? p[PROJECTOR] : p) as FieldProjector<unknown>;
}

function toFieldSignal<T>(projection: FieldProjection<T>): Signal<T> {
  if (typeof projection === 'function') {
    const fn = projection as (() => T) | Signal<T>;
    return isSignal(fn) ? fn : computed(fn);
  }
  return computed(() => projection);
}

/** Normalizes a projection to a `Signal`, unless it's a {@link raw} value (passed through verbatim). */
function materialize(projection: unknown): unknown {
  if (
    projection !== null &&
    typeof projection === 'object' &&
    RAW in projection
  ) {
    return (projection as RawProjection<unknown>)[RAW];
  }
  return toFieldSignal(projection as FieldProjection<unknown>);
}

/**
 * Resolves the {@link FieldRef} for the current `[formField]` host. Must run in an injection
 * context. Throws when there is no bound field.
 *
 * @param debugName Used in the "no host" error message.
 */
export function injectFieldRef(debugName = 'field'): FieldRef {
  const ff = inject(FORM_FIELD, { optional: true });
  if (!ff)
    throw new Error(
      `[mmstack/forms] ${debugName} must be used inside a control bound to a field (a [formField] host).`,
    );
  return { state: ff.state, formField: ff };
}

/**
 * Materializes a single {@link Projectable} against the current field, normalized to a `Signal`.
 * Inject-context only; injects the field once. Sugar for a one-entry {@link compose}.
 */
export function injectField<P extends Projectable>(
  projectable: P,
  debugName = 'field',
): Projected<P> {
  return materialize(
    resolveProjector(projectable)(injectFieldRef(debugName)),
  ) as Projected<P>;
}

/**
 * Injects the current field **once** and materializes a record of {@link Projectable}s into a
 * single object of `Signal`s — the basis for authoring field-type helpers. Inject-context only.
 *
 * @example
 * ```ts
 * const labeled = { label: withLabel, hint: withHint };          // reusable extension
 * function textField() {
 *   return compose({
 *     ...labeled,
 *     required: REQUIRED,                                         // a MetadataKey, directly
 *     error: (f) => () => f.state().errors()[0]?.message ?? '',   // getter — lazy
 *     invalid: (f) => () => f.state().invalid(),
 *   });
 * }
 * // in a control: readonly field = textField();  → field.label(), field.required(), ...
 * ```
 */
export function compose<M extends Record<string, Projectable>>(
  map: M,
): { [K in keyof M]: Projected<M[K]> } {
  const field = injectFieldRef('compose');
  const out = {} as { [K in keyof M]: Projected<M[K]> };
  for (const key in map) {
    out[key] = materialize(resolveProjector(map[key])(field)) as Projected<
      M[typeof key]
    >;
  }
  return out;
}

/** The object produced by injecting a composition: each projectable materialized to a `Signal`. */
export type Composition<M extends Record<string, Projectable>> = {
  [K in keyof M]: Projected<M[K]>;
};

/**
 * Defines a reusable, named composition from a record of {@link Projectable}s. Returns a
 * `[composition, inject]` tuple mirroring `fieldMetadata`'s `[withX, injectX]`:
 *
 * - the first element **is** the projectable record — spread it to extend/combine compositions
 *   (`composition({ ...textField, options })`);
 * - the second element is an inject reader that materializes it via {@link compose} (injecting
 *   the field once), for use inside a control.
 *
 * Lazy: safe to call at module level. The field is only injected when the reader runs.
 *
 * @example
 * ```ts
 * const [textField, injectTextField] = composition({ label: withLabel, hint: withHint });
 * const [select, injectSelect] = composition({
 *   ...textField,
 *   options: (f) => () => f.state().metadata(OPTIONS)?.() ?? [],
 * });
 *
 * // in a control on a [formField] host:
 * readonly field = injectSelect();   // { label, hint, options } — one inject(FORM_FIELD)
 * ```
 */
export function composition<M extends Record<string, Projectable>>(
  map: M,
): [M, () => Composition<M>] {
  return [map, () => compose(map)];
}
