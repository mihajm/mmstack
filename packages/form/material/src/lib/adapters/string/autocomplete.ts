import { computed, type Signal } from '@angular/core';
import {
  type AutocompleteState as GenericAutocompleteState,
  type AutocompleteStateOptions as GenericAutocompleteStateOptions,
  createAutocompleteState as genericCreateAutocompleteState,
  injectCreateAutocompleteState as genericInjectCreateAutocompleteState,
  type InjectedAutocompleteStateOptions as GenericInjectedAutocompleteStateOptions,
} from '@mmstack/form-adapters';
import { type DerivedSignal } from '@mmstack/form-core';

export type AutocompleteState<TParent = undefined> =
  GenericAutocompleteState<TParent> & {
    panelWidth?: Signal<string | number>;
  };

export type AutocompleteStateOptions = GenericAutocompleteStateOptions & {
  panelWidth?: () => string | number;
};

export type InjectedAutocompleteStateOptions =
  GenericInjectedAutocompleteStateOptions & {
    panelWidth?: () => string | number;
  };

function toMaterialSpecifics<TParent = undefined>(
  state: GenericAutocompleteState<TParent>,
  opt?: AutocompleteStateOptions,
): AutocompleteState<TParent> {
  return {
    ...state,
    panelWidth: computed(() => opt?.panelWidth?.() ?? 'auto'),
  };
}

export function createAutocompleteState<TParent>(
  value: string | null | DerivedSignal<TParent, string | null>,
  opt?: AutocompleteStateOptions,
): AutocompleteState<TParent> {
  return toMaterialSpecifics(genericCreateAutocompleteState(value, opt), opt);
}

export function injectCreateAutocompleteState() {
  const factory = genericInjectCreateAutocompleteState();

  return <TParent = undefined>(
    value: string | null | DerivedSignal<TParent, string | null>,
    opt?: InjectedAutocompleteStateOptions,
  ) => {
    return toMaterialSpecifics(factory(value, opt), opt);
  };
}
