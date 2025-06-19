import {
  createStringState as genericCreateStringState,
  injectCreateStringState as genericInjectCreateStringState,
  type InjectedStringStateOptions as GenericInjectedStringStateOptions,
  type StringState as GenericStringState,
  type StringStateOptions as GenericStringStateOptions,
} from '@mmstack/form-adapters';
import { type DerivedSignal } from '@mmstack/form-core';

export type StringState<TParent = undefined> = GenericStringState<TParent>;

export type StringStateOptions = GenericStringStateOptions;
export type InjectedStringStateOptions = GenericInjectedStringStateOptions;

export function createStringState<TParent>(
  value: string | null | DerivedSignal<TParent, string | null>,
  opt?: StringStateOptions,
): StringState<TParent> {
  return genericCreateStringState(value, opt);
}

export function injectCreateStringState() {
  const factory = genericInjectCreateStringState();

  return <TParent = undefined>(
    value: string | null | DerivedSignal<TParent, string | null>,
    opt?: InjectedStringStateOptions,
  ): StringState<TParent> => {
    return factory(value, opt);
  };
}
