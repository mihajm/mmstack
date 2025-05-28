import { computed, Signal } from '@angular/core';
import {
  type ButtonGroupState as GenericButtonGroupState,
  type ButtonGroupStateOptions as GenericButtonGroupStateOptions,
  type InjectedButtonGroupStateOptions as GenericInjectedButtonGroupStateOptions,
  createButtonGroupState as genericCreateButtonGroupState,
  injectCreateButtonGroupState as genericInjectCreateButtonGroupState,
} from '@mmstack/form-adapters';
import { DerivedSignal } from '@mmstack/form-core';

export type ButtonGroupState<T, TParent = undefined> = GenericButtonGroupState<
  T,
  TParent
> & {
  hideSingleSelectionIndicator?: Signal<boolean>;
  vertical?: Signal<boolean>;
};

export type ButtonGroupStateOptions<T> = GenericButtonGroupStateOptions<T> & {
  hideSingleSelectionIndicator?: () => boolean;
  vertical?: () => boolean;
};

export type InjectedButtonGroupStateOptions<T> =
  GenericInjectedButtonGroupStateOptions<T> & {
    hideSingleSelectionIndicator?: () => boolean;
    vertical?: () => boolean;
  };

function toMaterialSpecifics<T, TParent = undefined>(
  state: GenericButtonGroupState<T, TParent>,
  opt: ButtonGroupStateOptions<T>,
): ButtonGroupState<T, TParent> {
  return {
    ...state,
    hideSingleSelectionIndicator: computed(
      () => opt.hideSingleSelectionIndicator?.() ?? false,
    ),
    vertical: computed(() => opt.vertical?.() ?? false),
  };
}

export function createButtonGroupState<T, TParent = undefined>(
  value: T | DerivedSignal<TParent, T>,
  opt: ButtonGroupStateOptions<T>,
): ButtonGroupState<T, TParent> {
  return toMaterialSpecifics(genericCreateButtonGroupState(value, opt), opt);
}

export function injectCreateButtonGroupState() {
  const factory = genericInjectCreateButtonGroupState();

  return <T, TParent = undefined>(
    value: T | DerivedSignal<TParent, T>,
    opt: InjectedButtonGroupStateOptions<T>,
  ): ButtonGroupState<T, TParent> => {
    return toMaterialSpecifics(factory(value, opt), opt);
  };
}
