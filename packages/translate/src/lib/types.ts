import { Signal } from '@angular/core';
import { inferCompiledTranslationContent } from './create-namespace';
import { INTERNAL_SYMBOL } from './internal-symbol';

export type UnknownStringKeyObject = Record<string, unknown>;

type Autocomplete<T extends string> = T | Omit<string, T>;

type ExtractSelectOptions<TOpt extends string> =
  TOpt extends `${infer Option}{${infer _}} ${infer Rest}`
    ? Option | ExtractSelectOptions<Rest>
    : TOpt extends `${infer Option}{${infer _}}`
      ? Option
      : never;

type ExtractSelectVariable<TName extends string, TOpt extends string> = [
  TName,
  Autocomplete<Exclude<ExtractSelectOptions<TOpt>, 'other'>>,
];

type ExtractFullVariable<T extends string> = T extends
  | `{${infer VarName}, plural, ${infer _}}}${infer REST}`
  | `{${infer VarName}, selectordinal, ${infer _}}}${infer REST}`
  ? [VarName, number] | ExtractVariables<REST>
  : T extends `{${infer VarName}, select, ${infer SelectOptions}}}${infer REST}`
    ?
        | ExtractSelectVariable<VarName, `${SelectOptions}}`>
        | ExtractVariables<REST>
    : never;

type ExtractVariables<T extends string> =
  T extends `${infer _Start}{${infer Var}}${infer End}`
    ? Var extends `${infer _}, ${infer __}`
      ? ExtractFullVariable<`{${Var}}${End}`>
      : [Var, string] | ExtractVariables<End>
    : never;

type MergeVariables<TExtracted extends [string, any]> = {
  [K in TExtracted[0]]: TExtracted[1];
};

export type Flatten<
  TKey extends string,
  TVal,
> = TVal extends UnknownStringKeyObject
  ? inferTranslationTupple<TVal, `${TKey}.`>
  : TVal extends string
    ? ExtractVariables<TVal> extends never
      ? [TKey]
      : [TKey, MergeVariables<ExtractVariables<TVal>>]
    : never;

type Simplify<T> = T extends infer U
  ? { [K in keyof U]: Simplify<U[K]> }
  : never;

export type inferTranslationTupple<
  T extends UnknownStringKeyObject,
  TPrefix extends string = '',
> = Simplify<
  {
    [K in keyof T]: K extends string ? Flatten<`${TPrefix}${K}`, T[K]> : never;
  }[keyof T]
>;

export type inferTranslationShape<T extends UnknownStringKeyObject> = {
  [K in keyof T]: T[K] extends UnknownStringKeyObject
    ? inferTranslationShape<T[K]>
    : string;
};

export type CompiledTranslation<
  T extends UnknownStringKeyObject,
  TLocale extends string = string,
> = {
  flat: Record<string, string>;
  locale?: TLocale;
  namespace: keyof T;
  [INTERNAL_SYMBOL]: {
    shape: inferTranslationShape<T>;
    translation: T;
  };
};

export type TranslationMap<T extends UnknownStringKeyObject> = Simplify<{
  [Tuple in inferTranslationTupple<T> as Tuple[0] extends string
    ? Tuple[0]
    : never]: Tuple;
}>;

export type TFunction<T extends UnknownStringKeyObject> = <
  Key extends keyof TranslationMap<T>,
>(
  key: Key,
  ...args: TranslationMap<T>[Key] extends [string, infer Vars]
    ? [variables: Vars]
    : []
) => string;

export type TAllFunction<
  T extends CompiledTranslation<UnknownStringKeyObject>,
> = <Key extends keyof TranslationMap<inferCompiledTranslationContent<T>>>(
  ns: T['namespace'],
  key: Key,
  ...args: TranslationMap<inferCompiledTranslationContent<T>>[Key] extends [
    string,
    infer Vars,
  ]
    ? [variables: Vars]
    : []
) => string;

export type SignalTFunction<T extends UnknownStringKeyObject> = <
  Key extends keyof TranslationMap<T>,
>(
  key: Key,
  ...args: TranslationMap<T>[Key] extends [string, infer Vars]
    ? [variables: () => Vars]
    : []
) => Signal<String>;
