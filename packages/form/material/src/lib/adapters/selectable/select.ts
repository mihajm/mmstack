import { computed, type Signal } from '@angular/core';
import {
  createSelectState as genericCreateSelectState,
  injectCreateSelectState as genericInjectCreateSelectState,
  type InjectedSelectStateOptions as GenericInjectedSelectStateOptions,
  type SelectState as GenericSelectState,
  type SelectStateOptions as GenericSelectStateOptions,
} from '@mmstack/form-adapters';
import { type DerivedSignal } from '@mmstack/form-core';

export type MaterialSelectStateExtension = {
  disableOptionCentering?: Signal<boolean>;
  hideSingleSelectionIndicator?: Signal<boolean>;
  panelWidth?: Signal<string | number | null>;
  prefixIcon?: Signal<string>;
};

export type SelectState<T, TParent = undefined> = GenericSelectState<
  T,
  TParent
> &
  MaterialSelectStateExtension;

export type MaterialSelectStateOptionsExtension = {
  disableOptionCentering?: () => boolean;
  hideSingleSelectionIndicator?: () => boolean;
  panelWidth?: () => string | number | null;
  prefixIcon?: () => string;
};

export type SelectStateOptions<T> = GenericSelectStateOptions<T> &
  MaterialSelectStateOptionsExtension;

export type InjectedSelectStateOptions<T> =
  GenericInjectedSelectStateOptions<T> & MaterialSelectStateOptionsExtension;

export function toMaterialSelectSpecifics<T>(
  state: T,
  opt: MaterialSelectStateOptionsExtension,
): T & MaterialSelectStateExtension {
  return {
    ...state,
    panelWidth: computed(() => {
      const pw = opt.panelWidth?.();
      if (!pw || pw === 'auto') return null;
      return pw;
    }),
    disableOptionCentering: computed(
      () => opt.disableOptionCentering?.() ?? false,
    ),
    hideSingleSelectionIndicator: computed(
      () => opt.hideSingleSelectionIndicator?.() ?? false,
    ),
    prefixIcon: computed(() => opt.prefixIcon?.() ?? ''),
  };
}

export function createSelectState<T, TParent = undefined>(
  value: T | DerivedSignal<TParent, T>,
  opt: SelectStateOptions<T>,
): SelectState<T, TParent> {
  return toMaterialSelectSpecifics(genericCreateSelectState(value, opt), opt);
}

export function injectCreateSelectState() {
  const factory = genericInjectCreateSelectState();

  return <T, TParent = undefined>(
    value: T | DerivedSignal<TParent, T>,
    opt: Omit<SelectStateOptions<T>, 'required' | 'validator'> & {
      validation?: () => {
        required?: boolean;
      };
    },
  ): SelectState<T, TParent> => {
    return toMaterialSelectSpecifics(factory(value, opt), opt);
  };
}
