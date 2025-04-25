import { UnknownStringKeyObject } from './string-key-object.type';

type Simplify<T> = T extends infer U
  ? { [K in keyof U]: Simplify<U[K]> }
  : never;

type Autocomplete<T extends string> = T | Omit<string, T>;

type extractSelectOptions<TOpt extends string> =
  TOpt extends `${infer Option}{${infer _}} ${infer Rest}`
    ? Option | extractSelectOptions<Rest>
    : TOpt extends `${infer Option}{${infer _}}`
      ? Option
      : never;

type extractSelectParam<TName extends string, TOpt extends string> = [
  TName,
  Autocomplete<Exclude<extractSelectOptions<TOpt>, 'other'>>,
];

type extractComplexParam<T extends string> = T extends
  | `{${infer VarName}, plural, ${infer _}}}${infer REST}`
  | `{${infer VarName}, selectordinal, ${infer _}}}${infer REST}`
  ? [VarName, number] | extractParams<REST>
  : T extends `{${infer VarName}, select, ${infer SelectOptions}}}${infer REST}`
    ? extractSelectParam<VarName, `${SelectOptions}}`> | extractParams<REST>
    : never;

export type extractParams<T extends string> =
  T extends `${infer _Start}{${infer Var}}${infer End}`
    ? Var extends `${infer _}, ${infer __}`
      ? extractComplexParam<`{${Var}}${End}`>
      : [Var, string] | extractParams<End>
    : never;

type mergeParams<TExtracted extends [string, any]> = {
  [K in TExtracted[0]]: TExtracted[1];
};

type flattenParams<
  TKey extends string,
  TVal,
> = TVal extends UnknownStringKeyObject
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
  [Tuple in inferParamTupples<T> as Tuple[0] extends string
    ? `${TNS}.${Tuple[0]}`
    : never]: Tuple extends [string, infer Vars] ? Vars : void;
}>;

type StringContaining<Placeholder extends string> =
  `${string}${Placeholder}${string}`;

type TypeEnsuringAllPlaceholders<PlaceholdersUnion extends string> =
  StringContaining<PlaceholdersUnion>;

export type extractParamString<T extends string> =
  T extends `${infer _Start}{${infer Var}}${infer End}`
    ? Var extends `${infer VarName},${string}`
      ? `{${VarName}, ${string}}` | extractParamString<End>
      : `{${Var}}` | extractParamString<End>
    : never;

type inferParamsFromValue<V extends string> =
  extractParamString<V> extends never
    ? string
    : TypeEnsuringAllPlaceholders<extractParamString<V>>;

export type inferTranslationShape<T extends UnknownStringKeyObject> = {
  [K in keyof T]: T[K] extends UnknownStringKeyObject
    ? inferTranslationShape<T[K]>
    : T[K] extends string
      ? inferParamsFromValue<T[K]>
      : never;
};
