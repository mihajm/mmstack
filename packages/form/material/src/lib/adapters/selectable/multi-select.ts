import {
  createMultiSelectState as genericCreateMultiSelectState,
  injectCreateMultiSelectState as genericInjectCreateMultiSelectState,
  type InjectedMultiSelectStateOptions as GenericInjectedMultiSelectStateOptions,
  type MultiSelectState as GenericMultiSelectState,
  type MultiSelectStateOptions as GenericMultiSelectStateOptions,
} from '@mmstack/form-adapters';
import { DerivedSignal } from '@mmstack/form-core';
import {
  MaterialSelectStateExtension,
  MaterialSelectStateOptionsExtension,
  toMaterialSelectSpecifics,
} from './select';

export type MultiSelectState<
  T extends any[],
  TParent = undefined,
> = GenericMultiSelectState<T, TParent> & MaterialSelectStateExtension;

export type MultiSelectStateOptions<T extends any[]> =
  GenericMultiSelectStateOptions<T> & MaterialSelectStateOptionsExtension;

export type InjectedMultiSelectStateOptions<T extends any[]> =
  GenericInjectedMultiSelectStateOptions<T> &
    MaterialSelectStateOptionsExtension;

export function createMultiSelectState<T extends any[], TParent = undefined>(
  value: T | DerivedSignal<TParent, T>,
  opt: MultiSelectStateOptions<T>,
): MultiSelectState<T, TParent> {
  return toMaterialSelectSpecifics(
    genericCreateMultiSelectState(value, opt),
    opt,
  );
}

export function injectCreateMultiSelectState() {
  const factory = genericInjectCreateMultiSelectState();

  return <T extends any[], TParent = undefined>(
    value: T | DerivedSignal<TParent, T>,
    opt: InjectedMultiSelectStateOptions<T>,
  ): MultiSelectState<T, TParent> => {
    return toMaterialSelectSpecifics(factory(value, opt), opt);
  };
}
