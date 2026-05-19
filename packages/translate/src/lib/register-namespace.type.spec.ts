/* eslint-disable @typescript-eslint/no-unused-vars */

/**
 * Type-level coverage for the surface that `parameterize.type.spec.ts` doesn't
 * touch: namespace shape enforcement (createNamespace / createTranslation),
 * the LoadedTranslation union accepted by registerNamespace, the cross-locale
 * namespace constraint, the merged-namespace consumer type, and how
 * `withParams` loosens non-default locales for branded keys.
 *
 * These tests pass as long as the file compiles. Type mismatches surface as
 * build errors with line numbers pointing into this file. `@ts-expect-error`
 * directives must sit on the line immediately above the failing call/property.
 */

import { createNamespace } from './create-namespace';
import type {
  inferCompiledTranslationMap,
  inferCompiledTranslationNamespace,
} from './compile';
import {
  type LoadedTranslation,
  registerNamespace,
} from './register-namespace';
import { withParams } from './with-params';

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

type Expect<T extends true> = T;

// -----------------------------------------------------------------------------
// createNamespace — inferred Namespace and Map
// -----------------------------------------------------------------------------

const ns = createNamespace('quote', {
  pageTitle: 'Famous Quotes',
  greeting: 'Hello {name}',
  detail: { authorLabel: 'Author' },
  stats: '{count, plural, one {# quote} other {# quotes}}',
});

type _ns_namespace = Expect<
  Equals<inferCompiledTranslationNamespace<typeof ns.translation>, 'quote'>
>;

type _ns_map = Expect<
  Equals<
    inferCompiledTranslationMap<typeof ns.translation>,
    {
      'quote.pageTitle': void;
      'quote.greeting': { name: string };
      'quote.detail.authorLabel': void;
      'quote.stats': { count: number };
    }
  >
>;

// Nested objects flatten into dotted keys, not nested record types.
type _ns_map_keys = Expect<
  Equals<
    keyof inferCompiledTranslationMap<typeof ns.translation>,
    | 'quote.pageTitle'
    | 'quote.greeting'
    | 'quote.detail.authorLabel'
    | 'quote.stats'
  >
>;

// -----------------------------------------------------------------------------
// createTranslation — shape enforcement for non-default locales
// -----------------------------------------------------------------------------

// Valid: matches the inferred shape exactly, with the right placeholder.
const _sl_valid = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
  greeting: 'Zdravo {name}',
  detail: { authorLabel: 'Avtor' },
  stats: '{count, plural, =1 {# citat} other {# citatov}}',
});

// Missing top-level keys — error attaches to the call argument.
// @ts-expect-error - missing `greeting`, `detail`, `stats`
const _sl_missing_top_level = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
});

// Missing a nested key — error attaches to the inner literal.
const _sl_missing_nested = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
  greeting: 'Zdravo {name}',
  // @ts-expect-error - `authorLabel` is required inside `detail`
  detail: {},
  stats: '{count, plural, =1 {# citat} other {# citatov}}',
});

// Extra top-level key (object-literal excess property check).
const _sl_extra_key = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
  greeting: 'Zdravo {name}',
  detail: { authorLabel: 'Avtor' },
  stats: '{count, plural, =1 {# citat} other {# citatov}}',
  // @ts-expect-error - `extra` is not part of the namespace shape
  extra: 'not allowed',
});

// Placeholder dropped — value no longer satisfies `${string}{name}${string}`.
const _sl_missing_placeholder = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
  // @ts-expect-error - missing the `{name}` placeholder required by the shape
  greeting: 'Zdravo without placeholder',
  detail: { authorLabel: 'Avtor' },
  stats: '{count, plural, =1 {# citat} other {# citatov}}',
});

// Plain `string` widened — non-literal strings are rejected.
const _sl_arbitrary_string = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
  // @ts-expect-error - widened `string` is not assignable to the placeholder type
  greeting: 'arbitrary' as string,
  detail: { authorLabel: 'Avtor' },
  stats: '{count, plural, =1 {# citat} other {# citatov}}',
});

// -----------------------------------------------------------------------------
// createMergedNamespace — merged compiled translation exposes both namespaces
// -----------------------------------------------------------------------------

const common = createNamespace('common', {
  yes: 'Yes',
  no: 'No',
  cancel: 'Cancel',
});

const quoteWithCommon = common.createMergedNamespace('quote', {
  pageTitle: 'Quotes',
  greeting: 'Hi {name}',
});

// Spot-check that keys from each namespace exist in the merged map with the
// right param type. A full `keyof` equality is brittle here because the
// merged map is built via an intersection of two `Simplify<>` types — the
// per-key indexing is the stable surface.

type _merged_has_quote_key = Expect<
  Equals<
    inferCompiledTranslationMap<
      typeof quoteWithCommon.translation
    >['quote.greeting'],
    { name: string }
  >
>;

type _merged_has_quote_void_key = Expect<
  Equals<
    inferCompiledTranslationMap<
      typeof quoteWithCommon.translation
    >['quote.pageTitle'],
    void
  >
>;

type _merged_has_common_key = Expect<
  Equals<
    inferCompiledTranslationMap<
      typeof quoteWithCommon.translation
    >['common.yes'],
    void
  >
>;

// The merged namespace's literal is preserved (not widened to `string`).
type _merged_namespace_literal = Expect<
  Equals<
    inferCompiledTranslationNamespace<typeof quoteWithCommon.translation>,
    'quote'
  >
>;

// -----------------------------------------------------------------------------
// LoadedTranslation — the loader-shape union accepted by registerNamespace
// -----------------------------------------------------------------------------

type _loaded_union_shape = Expect<
  Equals<
    LoadedTranslation<typeof ns.translation>,
    | typeof ns.translation
    | { default: typeof ns.translation }
    | { translation: typeof ns.translation }
  >
>;

// All four practical loader shapes typecheck:

// 1. Direct CompiledTranslation
registerNamespace(() => Promise.resolve(ns.translation), {});

// 2. ES default export wrapping
registerNamespace(() => Promise.resolve({ default: ns.translation }), {});

// 3. Named `translation` export wrapping
registerNamespace(() => Promise.resolve({ translation: ns.translation }), {});

// 4. Module Namespace–like (extra named exports allowed via structural typing)
registerNamespace(
  () =>
    Promise.resolve({
      default: ns.translation,
      [Symbol.toStringTag]: 'Module' as const,
      createTranslation: ns.createTranslation,
    }),
  {},
);

// Garbage payloads are rejected at the loader signature.
registerNamespace(
  // @ts-expect-error - string is not a CompiledTranslation or wrapper
  () => Promise.resolve('garbage'),
  {},
);

registerNamespace(
  // @ts-expect-error - `{ wrong: ... }` is not one of the three accepted shapes
  () => Promise.resolve({ wrong: ns.translation }),
  {},
);

// -----------------------------------------------------------------------------
// registerNamespace — `other` locales must share the default's namespace string
// -----------------------------------------------------------------------------

const nsA = createNamespace('a', { hello: 'Hi' });
const nsB = createNamespace('b', { hello: 'Hello' });

// Valid: same namespace literal across the default and the alt locale.
registerNamespace(() => Promise.resolve(nsA.translation), {
  'sl-SI': () =>
    Promise.resolve(nsA.createTranslation('sl-SI', { hello: 'Pozdravljen' })),
});

// Alt locale's namespace literal disagrees with the default's.
registerNamespace(() => Promise.resolve(nsA.translation), {
  // @ts-expect-error - 'b' is not assignable to namespace constraint 'a'
  'sl-SI': () => Promise.resolve(nsB.translation),
});

// -----------------------------------------------------------------------------
// withParams — branded keys widen their shape in non-default locales
// -----------------------------------------------------------------------------

const branded = createNamespace('branded', {
  stats: withParams<{ name: string }>(
    '{count, plural, one {1 quote from {name}} other {# quotes from {name}}}',
  ),
  normal: 'Hi {n}',
});

// Wrapped key's shape widens to `string`, so any literal works in non-defaults.
// Sibling non-branded keys still enforce their placeholder.
const _branded_translation_valid = branded.createTranslation('sl-SI', {
  stats: '{count, plural, =1 {1 citat od {name}} other {# citatov od {name}}}',
  normal: 'Hi {n}',
});

const _branded_translation_freeform_branded_key = branded.createTranslation(
  'de-DE',
  {
    stats: 'completely different shape — branded keys allow this',
    normal: 'Hi {n}',
  },
);

// But sibling non-branded keys still require their placeholder.
const _branded_sibling_still_enforced = branded.createTranslation('de-DE', {
  stats: 'anything goes for branded keys',
  // @ts-expect-error - `{n}` placeholder still required on a non-branded sibling
  normal: 'Hi without placeholder',
});

// -----------------------------------------------------------------------------
// boilerplate runner — passes iff the file compiles
// -----------------------------------------------------------------------------

describe('register-namespace types', () => {
  it('compiles type-level assertions', () => {
    expect(true).toBe(true);
  });
});
