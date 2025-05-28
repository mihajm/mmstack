import { computed, type Signal } from '@angular/core';
import {
  createStringState as genericCreateStringState,
  injectCreateStringState as genericInjectCreateStringState,
  type InjectedStringStateOptions as GenericInjectedStringStateOptions,
  type StringState as GenericStringState,
  type StringStateOptions as GenericStringStateOptions,
} from '@mmstack/form-adapters';
import { type DerivedSignal } from '@mmstack/form-core';

export type MaterialStringStateExtension = {
  prefixIcon?: Signal<string>;
};

export type MaterialStringStateOptionsExtension = {
  prefixIcon?: () => string;
};

export type StringState<TParent = undefined> = GenericStringState<TParent> &
  MaterialStringStateExtension;

export type StringStateOptions = GenericStringStateOptions &
  MaterialStringStateOptionsExtension;

export type InjectedStringStateOptions = GenericInjectedStringStateOptions &
  MaterialStringStateOptionsExtension;

export function toMaterialStringSpecifics<T>(
  state: T,
  opt?: MaterialStringStateOptionsExtension,
): T & MaterialStringStateExtension {
  return {
    ...state,
    prefixIcon: computed(() => opt?.prefixIcon?.() ?? ''),
  };
}

export function createStringState<TParent>(
  value: string | null | DerivedSignal<TParent, string | null>,
  opt?: StringStateOptions,
): StringState<TParent> {
  return toMaterialStringSpecifics(genericCreateStringState(value, opt), opt);
}

export function injectCreateStringState() {
  const factory = genericInjectCreateStringState();

  return <TParent = undefined>(
    value: string | null | DerivedSignal<TParent, string | null>,
    opt?: InjectedStringStateOptions,
  ): StringState<TParent> => {
    return toMaterialStringSpecifics(factory(value, opt), opt);
  };
}
