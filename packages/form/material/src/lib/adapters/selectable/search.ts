import { computed, Signal } from '@angular/core';
import {
  createSearchState as genericCreateSearchState,
  injectCreateSearchState as genericInjectCreateSearchState,
  type InjectedSearchStateOptions as GenericInjectedSearchStateOptions,
  type SearchState as GenericSearchState,
  type SearchStateOptions as GenericSearchStateOptions,
} from '@mmstack/form-adapters';
import { DerivedSignal } from '@mmstack/form-core';
import {
  type MaterialSelectStateExtension,
  type MaterialSelectStateOptionsExtension,
  toMaterialSelectSpecifics,
} from './select';

export type SearchState<T, TParent = undefined> = GenericSearchState<
  T,
  TParent
> &
  MaterialSelectStateExtension & {
    searchPlaceholder?: Signal<string>;
  };

export type SearchStateOptions<T> = GenericSearchStateOptions<T> &
  MaterialSelectStateOptionsExtension & {
    searchPlaceholder?: () => string;
  };

export type InjectedSearchStateOptions<T> =
  GenericInjectedSearchStateOptions<T> & MaterialSelectStateOptionsExtension;

function toMaterialSpecifics<T, TParent>(
  state: GenericSearchState<T, TParent>,
  opt: SearchStateOptions<T>,
): SearchState<T, TParent> {
  return {
    ...toMaterialSelectSpecifics(state, opt),
    searchPlaceholder: computed(() => opt.searchPlaceholder?.() ?? ''),
  };
}

export function createSearchState<T, TParent = undefined>(
  value: T | DerivedSignal<TParent, T>,
  opt: SearchStateOptions<T>,
): SearchState<T, TParent> {
  return toMaterialSpecifics(genericCreateSearchState(value, opt), opt);
}

export function injectCreateSearchState() {
  const factory = genericInjectCreateSearchState();

  return <T, TParent = undefined>(
    value: T | DerivedSignal<TParent, T>,
    opt: InjectedSearchStateOptions<T>,
  ) => {
    return toMaterialSpecifics(factory(value, opt), opt);
  };
}
