/* eslint-disable @typescript-eslint/no-unused-vars */

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
      'quote.greeting': { name: string | number };
      'quote.detail.authorLabel': void;
      'quote.stats': { count: number };
    }
  >
>;

type _ns_map_keys = Expect<
  Equals<
    keyof inferCompiledTranslationMap<typeof ns.translation>,
    | 'quote.pageTitle'
    | 'quote.greeting'
    | 'quote.detail.authorLabel'
    | 'quote.stats'
  >
>;

const _sl_valid = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
  greeting: 'Zdravo {name}',
  detail: { authorLabel: 'Avtor' },
  stats: '{count, plural, =1 {# citat} other {# citatov}}',
});

// @ts-expect-error - missing `greeting`, `detail`, `stats`
const _sl_missing_top_level = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
});

const _sl_missing_nested = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
  greeting: 'Zdravo {name}',
  // @ts-expect-error - `authorLabel` is required inside `detail`
  detail: {},
  stats: '{count, plural, =1 {# citat} other {# citatov}}',
});

const _sl_extra_key = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
  greeting: 'Zdravo {name}',
  detail: { authorLabel: 'Avtor' },
  stats: '{count, plural, =1 {# citat} other {# citatov}}',
  // @ts-expect-error - `extra` is not part of the namespace shape
  extra: 'not allowed',
});

const _sl_missing_placeholder = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
  // @ts-expect-error - missing the `{name}` placeholder required by the shape
  greeting: 'Zdravo without placeholder',
  detail: { authorLabel: 'Avtor' },
  stats: '{count, plural, =1 {# citat} other {# citatov}}',
});

const _sl_arbitrary_string = ns.createTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
  // @ts-expect-error - widened `string` is not assignable to the placeholder type
  greeting: 'arbitrary' as string,
  detail: { authorLabel: 'Avtor' },
  stats: '{count, plural, =1 {# citat} other {# citatov}}',
});

const common = createNamespace('common', {
  yes: 'Yes',
  no: 'No',
  cancel: 'Cancel',
});

const quoteWithCommon = common.createMergedNamespace('quote', {
  pageTitle: 'Quotes',
  greeting: 'Hi {name}',
});

type _merged_has_quote_key = Expect<
  Equals<
    inferCompiledTranslationMap<
      typeof quoteWithCommon.translation
    >['quote.greeting'],
    { name: string | number }
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

type _merged_namespace_literal = Expect<
  Equals<
    inferCompiledTranslationNamespace<typeof quoteWithCommon.translation>,
    'quote'
  >
>;

type _loaded_union_shape = Expect<
  Equals<
    LoadedTranslation<typeof ns.translation>,
    | typeof ns.translation
    | { default: typeof ns.translation }
    | { translation: typeof ns.translation }
  >
>;

registerNamespace(() => Promise.resolve(ns.translation), {});

registerNamespace(() => Promise.resolve({ default: ns.translation }), {});

registerNamespace(() => Promise.resolve({ translation: ns.translation }), {});

registerNamespace(
  () =>
    Promise.resolve({
      default: ns.translation,
      [Symbol.toStringTag]: 'Module' as const,
      createTranslation: ns.createTranslation,
    }),
  {},
);

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

const nsA = createNamespace('a', { hello: 'Hi' });
const nsB = createNamespace('b', { hello: 'Hello' });

registerNamespace(() => Promise.resolve(nsA.translation), {
  'sl-SI': () =>
    Promise.resolve(nsA.createTranslation('sl-SI', { hello: 'Pozdravljen' })),
});

registerNamespace(() => Promise.resolve(nsA.translation), {
  // @ts-expect-error - 'b' is not assignable to namespace constraint 'a'
  'sl-SI': () => Promise.resolve(nsB.translation),
});

const branded = createNamespace('branded', {
  stats: withParams<{ name: string }>(
    '{count, plural, one {1 quote from {name}} other {# quotes from {name}}}',
  ),
  normal: 'Hi {n}',
});

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

const _branded_sibling_still_enforced = branded.createTranslation('de-DE', {
  stats: 'anything goes for branded keys',
  // @ts-expect-error - `{n}` placeholder still required on a non-branded sibling
  normal: 'Hi without placeholder',
});

describe('register-namespace types', () => {
  it('compiles type-level assertions', () => {
    expect(true).toBe(true);
  });
});
