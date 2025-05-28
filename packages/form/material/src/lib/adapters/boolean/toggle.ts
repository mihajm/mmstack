import {
  createToggleState as genericCreateToggleState,
  injectCreateToggleState as genericInjectCreateToggleState,
  type InjectedToggleStateOptions as GenericInjectedToggleStateOptions,
  type ToggleState as GenericToggleState,
  type ToggleStateOptions as GenericToggleStateOptions,
} from '@mmstack/form-adapters';
import { type DerivedSignal } from '@mmstack/form-core';
import {
  MaterialBooleanStateExtension,
  MaterialBooleanStateOptionsExtension,
  toMaterialBooleanSpecifics,
} from './base-boolean';

export type ToggleState<TParent = undefined> = GenericToggleState<TParent> &
  MaterialBooleanStateExtension;

export type ToggleStateOptions = GenericToggleStateOptions &
  MaterialBooleanStateOptionsExtension;

export type InjectedToggleStateOptions = GenericInjectedToggleStateOptions &
  MaterialBooleanStateOptionsExtension;

export function createToggleState<TParent = undefined>(
  value: boolean | DerivedSignal<TParent, boolean>,
  opt?: ToggleStateOptions,
): ToggleState<TParent> {
  return toMaterialBooleanSpecifics(genericCreateToggleState(value, opt));
}

export function injectCreateToggleState() {
  const factory = genericInjectCreateToggleState();

  return <TParent = undefined>(
    value: boolean | DerivedSignal<TParent, boolean>,
    opt?: InjectedToggleStateOptions,
  ): ToggleState<TParent> => {
    return toMaterialBooleanSpecifics(factory(value, opt), opt);
  };
}
