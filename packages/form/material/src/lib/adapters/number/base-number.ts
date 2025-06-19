import {
  createNumberState as genericCreateNumberState,
  injectCreateNumberState as genericInjectCreateNumberState,
  type InjectedNumberStateOptions as GenericInjectedNumberStateOptions,
  type NumberState as GenericNumberState,
  type NumberStateOptions as GenericNumberStateOptions,
} from '@mmstack/form-adapters';
import { type DerivedSignal } from '@mmstack/form-core';

export type NumberState<TParent = undefined> = GenericNumberState<TParent>;

export type NumberStateOptions = GenericNumberStateOptions;

export type InjectedNumberStateOptions = GenericInjectedNumberStateOptions;

export function createNumberState<TParent>(
  value: number | null | DerivedSignal<TParent, number | null>,
  opt?: NumberStateOptions,
): NumberState<TParent> {
  return genericCreateNumberState(value, opt);
}

export function injectCreateNumberState() {
  const factory = genericInjectCreateNumberState();

  return <TParent = undefined>(
    value: number | null | DerivedSignal<TParent, number | null>,
    opt?: InjectedNumberStateOptions,
  ): NumberState<TParent> => {
    return factory(value, opt);
  };
}
