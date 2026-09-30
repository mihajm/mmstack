/* eslint-disable @typescript-eslint/no-unused-vars */
import { type UnknownStringKeyObject } from './string-key-object.type';

type Simplify<T> = T extends infer U
  ? { [K in keyof U]: Simplify<U[K]> }
  : never;

type Autocomplete<T extends string> = T | Omit<string, T>;

/**
 * Walks `S` one character at a time and returns the text after the `}` that
 * closes an already opened `{`. `S` starts just after that opening brace;
 * `Depth` counts the braces opened since. Never when the braces do not balance.
 */
type SkipBalanced<
  S extends string,
  Depth extends unknown[] = [],
> = S extends `${infer C}${infer Rest}`
  ? C extends '{'
    ? SkipBalanced<Rest, [...Depth, unknown]>
    : C extends '}'
      ? Depth extends [unknown, ...infer Outer]
        ? SkipBalanced<Rest, Outer>
        : Rest
      : SkipBalanced<Rest, Depth>
  : never;

type Whitespace = ' ' | '\n' | '\t' | '\r';

type Trim<T extends string> = T extends `${Whitespace}${infer R}`
  ? Trim<R>
  : T extends `${infer L}${Whitespace}`
    ? Trim<L>
    : T;

/** Option labels of `male {..} female {..} other {..}`, arm bodies may nest braces. */
type extractSelectOptions<
  TArms extends string,
  TAcc extends string = never,
> = TArms extends `${infer Option}{${infer Body}`
  ? extractSelectOptions<SkipBalanced<Body>, TAcc | Trim<Option>>
  : TAcc;

type extractSelectParam<TName extends string, TArms extends string> = [
  TName,
  Autocomplete<Exclude<extractSelectOptions<TArms>, 'other'>>,
];

/**
 * `T` starts at the `{` of a complex argument. Only the argument itself is
 * extracted (params inside its arms are not), then scanning resumes after the
 * brace that closes it.
 */
type extractComplexParam<T extends string> =
  T extends `{${infer VarName}, ${infer Kind}, ${infer Body}`
    ? [SkipBalanced<Body>] extends [infer REST extends string]
      ? [REST] extends [never]
        ? never
        : Kind extends 'plural' | 'selectordinal'
          ? [VarName, number] | extractParams<REST>
          : Kind extends 'select'
            ? Body extends `${infer Arms}}${REST}`
              ? extractSelectParam<VarName, Arms> | extractParams<REST>
              : never
            : never
      : never
    : never;

type IsSimpleIdent<T extends string> = T extends ''
  ? false
  : T extends
        | `${string} ${string}`
        | `${string},${string}`
        | `${string}{${string}`
        | `${string}#${string}`
    ? false
    : true;

export type extractParams<T extends string> =
  T extends `${infer _Start}{${infer Var}}${infer End}`
    ? Var extends `${infer _}, ${infer __}`
      ? extractComplexParam<`{${Var}}${End}`>
      : IsSimpleIdent<Var> extends true
        ? [Var, string | number] | extractParams<End>
        : extractParams<End>
    : never;

type mergeParams<TExtracted extends [string, any]> = {
  [K in TExtracted as K[0]]: K[1];
};

export declare const PARAM_BRAND: unique symbol;

/**
 * Branded string type produced by `withParams<P>(message)`. The brand carries
 * both the declared parameter shape `P` and the original literal message `S` —
 * the literal lives inside the brand (not just on the intersection) so the
 * inference machinery can recover it without going through template-literal
 * pattern matching on a branded intersection (which widens `infer` slots to
 * `string` and breaks auto-extraction). Module-local `unique symbol`, so the
 * brand is not constructible outside this package.
 */
export type WithParams<
  P extends Record<string, unknown>,
  S extends string = string,
> = S & {
  readonly [PARAM_BRAND]: { params: P; literal: S };
};

type flattenParams<TKey extends string, TVal> = TVal extends {
  readonly [PARAM_BRAND]: {
    params: infer P;
    literal: infer S extends string;
  };
}
  ? P extends Record<string, unknown>
    ? extractParams<S> extends never
      ? [TKey, P]
      : [TKey, Omit<mergeParams<extractParams<S>>, keyof P> & P]
    : [TKey]
  : TVal extends UnknownStringKeyObject
    ? inferParamTupples<TVal, `${TKey}.`>
    : TVal extends string
      ? extractParams<TVal> extends never
        ? [TKey]
        : [TKey, mergeParams<extractParams<TVal>>]
      : never;

type inferParamTupples<
  T extends UnknownStringKeyObject,
  TPrefix extends string = '',
> = Simplify<
  {
    [K in keyof T]: K extends string
      ? flattenParams<`${TPrefix}${K}`, T[K]>
      : never;
  }[keyof T]
>;

export type inferTranslationParamMap<
  TNS extends string,
  T extends UnknownStringKeyObject,
> = Simplify<{
  [
    Tuple in inferParamTupples<T> as Tuple[0] extends string
      ? `${TNS}.${Tuple[0]}`
      : never
  ]: Tuple extends [string, infer Vars] ? Vars : void;
}>;

type StringContaining<Placeholder extends string> =
  `${string}${Placeholder}${string}`;

type TypeEnsuringAllPlaceholders<PlaceholdersUnion extends string> =
  StringContaining<PlaceholdersUnion>;

export type extractParamString<T extends string> =
  T extends `${infer _Start}{${infer Var}}${infer End}`
    ? Var extends `${infer VarName},${string}`
      ? | `{${VarName}, ${string}}`
        | extractParamString<SkipBalanced<`${Var}}${End}`>>
      : `{${Var}}` | extractParamString<End>
    : never;

type inferParamsFromValue<V extends string> =
  extractParamString<V> extends never
    ? string
    : TypeEnsuringAllPlaceholders<extractParamString<V>>;

export type inferTranslationShape<T extends UnknownStringKeyObject> = {
  [K in keyof T]: T[K] extends { readonly [PARAM_BRAND]: any }
    ? string
    : T[K] extends UnknownStringKeyObject
      ? inferTranslationShape<T[K]>
      : T[K] extends string
        ? inferParamsFromValue<T[K]>
        : never;
};
