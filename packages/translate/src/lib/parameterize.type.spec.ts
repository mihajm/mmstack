/* eslint-disable @typescript-eslint/no-unused-vars */

import type {
  inferTranslationParamMap,
  inferTranslationShape,
  WithParams,
} from './parameterize.type';

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

type Expect<T extends true> = T;

type _map_simple = Expect<
  Equals<
    inferTranslationParamMap<'ns', { key: 'Hello {name}' }>,
    { 'ns.key': { name: string | number } }
  >
>;

type _map_two_top_level = Expect<
  Equals<
    inferTranslationParamMap<'ns', { key: 'Hi {a} and {b}' }>,
    { 'ns.key': { a: string | number; b: string | number } }
  >
>;

type _map_no_params = Expect<
  Equals<
    inferTranslationParamMap<'ns', { key: 'plain text' }>,
    { 'ns.key': void }
  >
>;

type _map_plural = Expect<
  Equals<
    inferTranslationParamMap<
      'ns',
      { key: '{count, plural, one {# quote} other {# quotes}}' }
    >,
    { 'ns.key': { count: number } }
  >
>;

type _map_complex_then_trailing_simple = Expect<
  Equals<
    inferTranslationParamMap<
      'ns',
      { key: '{c, plural, one {x} other {y}} for {z}' }
    >,
    { 'ns.key': { c: number; z: string | number } }
  >
>;

type _map_select_member_male = 'male' extends inferTranslationParamMap<
  'ns',
  { key: '{gender, select, male {he} female {she} other {they}}' }
>['ns.key']['gender']
  ? true
  : false;
type _assert_map_select_male = Expect<_map_select_member_male>;

type _map_select_keys = Expect<
  Equals<
    keyof inferTranslationParamMap<
      'ns',
      { key: '{gender, select, male {he} female {she} other {they}}' }
    >['ns.key'],
    'gender'
  >
>;

type _map_plural_nested_only_outer = Expect<
  Equals<
    inferTranslationParamMap<
      'ns',
      {
        key: '{count, plural, =0 {No new mentions for {name}} other {# new from {name}}}';
      }
    >,
    { 'ns.key': { count: number } }
  >
>;

type _map_selectordinal_nested_only_outer = Expect<
  Equals<
    inferTranslationParamMap<
      'ns',
      { key: '{count, selectordinal, one {1st {prize}} other {#th {prize}}}' }
    >,
    { 'ns.key': { count: number } }
  >
>;

type _map_guard_drops_garbage = Expect<
  Equals<
    inferTranslationParamMap<
      'ns',
      { key: '{c, plural, one {only {a}} other {many {b}}}' }
    >,
    { 'ns.key': { c: number } }
  >
>;

type _map_hash_not_extracted = Expect<
  Equals<
    inferTranslationParamMap<
      'ns',
      { key: '{count, plural, one {# msg} other {# msgs}}' }
    >,
    { 'ns.key': { count: number } }
  >
>;

type _shape_simple = Expect<
  Equals<
    inferTranslationShape<{ key: 'Hello {name}' }>,
    { key: `${string}{name}${string}` }
  >
>;

type _shape_plain_string = Expect<
  Equals<inferTranslationShape<{ key: 'plain text' }>, { key: string }>
>;

type _shape_nested_object = Expect<
  Equals<
    inferTranslationShape<{ outer: { inner: 'Hi {x}' } }>,
    { outer: { inner: `${string}{x}${string}` } }
  >
>;

type _shape_two_params_distributes = Expect<
  Equals<
    inferTranslationShape<{ key: 'Hi {a} and {b}' }>,
    { key: `${string}{a}${string}` | `${string}{b}${string}` }
  >
>;

type _shape_plural = Expect<
  Equals<
    inferTranslationShape<{
      key: '{count, plural, one {# quote} other {# quotes}}';
    }>,
    {
      key:
        | `${string}{count, ${string}}${string}`
        | `${string}{# quotes}${string}`;
    }
  >
>;

type _withparams_merges = Expect<
  Equals<
    inferTranslationParamMap<
      'ns',
      {
        key: WithParams<
          { name: string },
          '{count, plural, one {Hi {name}} other {Hi {name}}}'
        >;
      }
    >,
    { 'ns.key': { count: number; name: string } }
  >
>;

type _withparams_no_auto = Expect<
  Equals<
    inferTranslationParamMap<'ns', { key: WithParams<{ x: number }> }>,
    { 'ns.key': { x: number } }
  >
>;

type _withparams_user_wins = Expect<
  Equals<
    inferTranslationParamMap<
      'ns',
      {
        key: WithParams<
          { count: string },
          '{count, plural, one {x} other {y}}'
        >;
      }
    >,
    { 'ns.key': { count: string } }
  >
>;

type _withparams_sibling_unaffected = Expect<
  Equals<
    inferTranslationParamMap<
      'ns',
      {
        branded: WithParams<{ x: number }>;
        normal: 'Hi {n}';
      }
    >,
    { 'ns.branded': { x: number }; 'ns.normal': { n: string | number } }
  >
>;

type _withparams_shape_widens = Expect<
  Equals<
    inferTranslationShape<{ branded: WithParams<{ x: number }> }>,
    { branded: string }
  >
>;

type _withparams_sibling_shape_unaffected = Expect<
  Equals<
    inferTranslationShape<{
      branded: WithParams<{ x: number }>;
      normal: 'Hi {n}';
    }>,
    { branded: string; normal: `${string}{n}${string}` }
  >
>;

describe('parameterize types', () => {
  it('compiles type-level assertions', () => {
    expect(true).toBe(true);
  });
});
