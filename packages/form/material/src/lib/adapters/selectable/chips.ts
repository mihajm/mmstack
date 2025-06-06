import {
  createChipsState as genericCreateChipsState,
  injectCreateChipsState as genericInjectCreateChipsState,
  type ChipsState as GenericChipsState,
  type ChipsStateOptions as GenericChipsStateOptions,
  type InjectedChipsStateOptions as GenericInjectedChipsStateOptions,
} from '@mmstack/form-adapters';
import { DerivedSignal } from '@mmstack/form-core';
import {
  MaterialSelectStateExtension,
  MaterialSelectStateOptionsExtension,
  toMaterialSelectSpecifics,
} from './select';

export type ChipsState<TParent = undefined> = GenericChipsState<TParent> &
  MaterialSelectStateExtension;

export type ChipsStateOptions = GenericChipsStateOptions &
  MaterialSelectStateOptionsExtension;

export type InjectedChipsStateOptions = GenericInjectedChipsStateOptions &
  MaterialSelectStateOptionsExtension;

export function createChipsState<TParent = undefined>(
  value: string[] | DerivedSignal<TParent, string[]>,
  opt: ChipsStateOptions,
): ChipsState<TParent> {
  return toMaterialSelectSpecifics(genericCreateChipsState(value, opt), opt);
}

export function injectCreateChipsState() {
  const factory = genericInjectCreateChipsState();

  return <TParent = undefined>(
    value: string[] | DerivedSignal<TParent, string[]>,
    opt: InjectedChipsStateOptions,
  ): ChipsState<TParent> => {
    return toMaterialSelectSpecifics(factory(value, opt), opt);
  };
}
