import { type Signal } from '@angular/core';
import {
  createMetadataKey,
  type LogicFn,
  metadata,
  type MetadataReducer,
  type PathKind,
  type SchemaPath,
  type SchemaPathRules,
} from '@angular/forms/signals';
import {
  type FieldProjector,
  injectField,
  PROJECTOR,
} from '../compose/compose';

/**
 * Options for {@link fieldMetadata}.
 *
 * @typeParam T The value type stored on the field for this attribute.
 */
export type FieldMetadataOptions<T> = {
  /**
   * Default value used by the reader/projector when neither the schema (via the rule) nor the
   * component (via the reader argument) supplies a value for the field.
   */
  fallback?: T;
  /** Used in the reader's "no host" error message and as the `computed`'s `debugName`. */
  debugName?: string;
  /** How to merge multiple rule contributions to one field. Defaults to last-write-wins. */
  reducer?: MetadataReducer<T | undefined, T>;
};

/**
 * Schema rule that binds a metadata value to a field path. Mirrors the shape & path-kind
 * genericity of the native rules (e.g. `required(path)` / `min(path, value)`), so it works on
 * root, child and array-item paths alike.
 *
 * The rule also carries a default {@link FieldProjector} under the {@link PROJECTOR} symbol, so
 * it can be dropped straight into `compose({ x: withX })`, and exposes {@link project} to build
 * a projector with a component-level fallback.
 *
 * @typeParam T The value type stored on the field.
 * @typeParam TDefault `T` when a base fallback is configured, otherwise `T | undefined`.
 */
export type FieldMetadataRule<T, TDefault> = {
  <TPathKind extends PathKind = PathKind.Root>(
    path: SchemaPath<T, SchemaPathRules.Supported, TPathKind>,
    value: T | LogicFn<T, T, TPathKind>,
  ): void;
  /** Default projector (no component fallback) — makes the rule usable directly in `compose`. */
  readonly [PROJECTOR]: FieldProjector<TDefault>;
  /** Builds a projector with an optional component-level fallback, for use in `compose`. */
  readonly project: (fallback?: T) => FieldProjector<TDefault>;
};

/**
 * Reader that resolves the field's metadata value inside a control bound to that field.
 * Must run in an injection context (like `inject()`/`input()`).
 *
 * @typeParam T The value type stored on the field.
 * @typeParam TDefault `T` when a base fallback is configured, otherwise `T | undefined`.
 */
export type FieldMetadataReader<T, TDefault> = {
  (): Signal<TDefault>;
  (fallback: T): Signal<T>;
};

/**
 * Creates a typed, named field-attribute pair on top of Angular Signal Forms' metadata system.
 *
 * Bundles the layers Angular exposes separately — a metadata key ({@link createMetadataKey}), the
 * schema rule that sets it ({@link metadata}), and the `FieldState.metadata()` read — into a
 * `[rule, reader]` tuple:
 *
 * - the **rule** (`withX`) is used in a schema like the native `required`/`min` rules, and also
 *   carries a {@link FieldProjector} so it composes via `compose({ x: withX })`;
 * - the **reader** (`injectX`) is used inside a control like `input()`, resolving the value via
 *   the `FORM_FIELD` token that the `[formField]` directive provides.
 *
 * Resolution precedence at read time: value set in the schema → component fallback (reader
 * argument / `project(fallback)`) → base fallback ({@link FieldMetadataOptions.fallback}) →
 * `undefined`.
 *
 * @example
 * ```ts
 * export const [withLabel, injectLabel] = fieldMetadata<string>({ debugName: 'label' });
 *
 * form(model, (p) => { withLabel(p.name, 'Full name'); });   // schema
 * readonly label = injectLabel('(unlabeled)');               // standalone read
 * readonly field = compose({ label: withLabel });            // composed read (injects once)
 * ```
 *
 * @typeParam T The value type stored on the field for this attribute.
 */
export function fieldMetadata<T>(
  opts: FieldMetadataOptions<T> & { fallback: T },
): [FieldMetadataRule<T, T>, FieldMetadataReader<T, T>];
export function fieldMetadata<T>(
  opts?: FieldMetadataOptions<T>,
): [FieldMetadataRule<T, T | undefined>, FieldMetadataReader<T, T | undefined>];
export function fieldMetadata<T>(
  opts?: FieldMetadataOptions<T>,
): [
  FieldMetadataRule<T, T | undefined>,
  FieldMetadataReader<T, T | undefined>,
] {
  const KEY = opts?.reducer
    ? createMetadataKey<T, T | undefined>(opts.reducer)
    : createMetadataKey<T>();
  const base = opts?.fallback;
  const name = opts?.debugName ?? 'metadata';

  // Defer the field-state read until the [formField] host has bound.
  // Only `undefined` counts as unset — a schema-provided `null` is a real value.
  const project =
    (componentFallback?: T): FieldProjector<T | undefined> =>
    (field) =>
    () => {
      const value = field.state().metadata(KEY)?.();
      if (value !== undefined) return value;
      return componentFallback !== undefined ? componentFallback : base;
    };

  const ruleFn = <TPathKind extends PathKind = PathKind.Root>(
    path: SchemaPath<T, SchemaPathRules.Supported, TPathKind>,
    value: T | LogicFn<T, T, TPathKind>,
  ): void => {
    metadata(
      path,
      KEY,
      typeof value === 'function'
        ? (value as LogicFn<T, T, PathKind>)
        : () => value,
    );
  };

  const rule = Object.assign(ruleFn, {
    [PROJECTOR]: project(),
    project,
  }) as FieldMetadataRule<T, T | undefined>;

  const read = (componentFallback?: T): Signal<T | undefined> =>
    injectField(project(componentFallback), name) as Signal<T | undefined>;

  return [rule, read as FieldMetadataReader<T, T | undefined>];
}
