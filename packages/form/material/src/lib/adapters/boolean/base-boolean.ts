import { computed, type Signal } from '@angular/core';
import {
  type BooleanState as GenericBooleanState,
  type BooleanStateOptions as GenericBooleanStateOptions,
  createBooleanState as genericCreateBooleanState,
  injectCreateBooleanState as genericInjectCreateBooleanState,
  type InjectedBooleanStateOptions as GenericInjectedBooleanStateOptions,
} from '@mmstack/form-adapters';
import { type DerivedSignal } from '@mmstack/form-core';

export type MaterialBooleanStateExtension = {
  labelPosition?: Signal<'before' | 'after'>;
};

export type BooleanState<TParent = undefined> = GenericBooleanState<TParent> &
  MaterialBooleanStateExtension;

export type MaterialBooleanStateOptionsExtension = {
  labelPosition?: () => 'before' | 'after';
};

export type BooleanStateOptions = GenericBooleanStateOptions &
  MaterialBooleanStateOptionsExtension;

export type InjectedBooleanStateOptions = GenericInjectedBooleanStateOptions &
  MaterialBooleanStateOptionsExtension;

export function toMaterialBooleanSpecifics<T>(
  state: T,
  opt?: MaterialBooleanStateOptionsExtension,
): T & MaterialBooleanStateExtension {
  return {
    ...state,
    labelPosition: computed(() => opt?.labelPosition?.() ?? 'after'),
  };
}

export function createBooleanState<TParent = undefined>(
  value: boolean | DerivedSignal<TParent, boolean>,
  opt?: BooleanStateOptions,
): BooleanState<TParent> {
  return toMaterialBooleanSpecifics(genericCreateBooleanState(value, opt));
}

export function injectCreateBooleanState() {
  const factory = genericInjectCreateBooleanState();

  return <TParent = undefined>(
    value: boolean | DerivedSignal<TParent, boolean>,
    opt?: InjectedBooleanStateOptions,
  ): BooleanState<TParent> => {
    return toMaterialBooleanSpecifics(factory(value, opt), opt);
  };
}
