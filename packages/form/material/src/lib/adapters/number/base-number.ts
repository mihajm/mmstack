import { computed, type Signal } from '@angular/core';
import {
  createNumberState as genericCreateNumberState,
  injectCreateNumberState as genericInjectCreateNumberState,
  type InjectedNumberStateOptions as GenericInjectedNumberStateOptions,
  type NumberState as GenericNumberState,
  type NumberStateOptions as GenericNumberStateOptions,
} from '@mmstack/form-adapters';
import { type DerivedSignal } from '@mmstack/form-core';

export type MaterialNumberStateExtension = {
  prefixIcon?: Signal<string>;
};

export type MaterialNumberStateOptionsExtension = {
  prefixIcon?: () => string;
};

export type NumberState<TParent = undefined> = GenericNumberState<TParent> &
  MaterialNumberStateExtension;

export type NumberStateOptions = GenericNumberStateOptions &
  MaterialNumberStateOptionsExtension;

export type InjectedNumberStateOptions = GenericInjectedNumberStateOptions &
  MaterialNumberStateOptionsExtension;

export function toMaterialNumberSpecifics<T>(
  state: T,
  opt?: MaterialNumberStateOptionsExtension,
): T & MaterialNumberStateExtension {
  return {
    ...state,
    prefixIcon: computed(() => opt?.prefixIcon?.() ?? ''),
  };
}

export function createNumberState<TParent>(
  value: number | null | DerivedSignal<TParent, number | null>,
  opt?: NumberStateOptions,
): NumberState<TParent> {
  return toMaterialNumberSpecifics(genericCreateNumberState(value, opt), opt);
}

export function injectCreateNumberState() {
  const factory = genericInjectCreateNumberState();

  return <TParent = undefined>(
    value: number | null | DerivedSignal<TParent, number | null>,
    opt?: InjectedNumberStateOptions,
  ): NumberState<TParent> => {
    return toMaterialNumberSpecifics(factory(value, opt), opt);
  };
}
