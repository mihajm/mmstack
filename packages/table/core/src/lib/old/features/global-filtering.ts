import { createStringState, StringState } from '@mmstack/form-adapters';
import { TableState } from '../table';
import { WritableSignal } from '@angular/core';
import { derived } from '@mmstack/primitives';

export type GlobalFilteringFeature = StringState<TableState> & {
  clear: () => void;
}

export type GlobalFilteringState = string;

export type GlobalFilteringOptions<T> = {
  label?: () => string;
  toString?: (value: T) => string;
}


export function createGlobalFilter<T>(state: WritableSignal<TableState>, opt?: GlobalFilteringOptions<T>): GlobalFilteringFeature {
  const filter = createStringState(derived(state, 'globalFilter'), {
    label: () => opt?.label?.() ?? 'Search',
  })
  return {
    ...filter,
    clear: () => filter.value.set('')
  };
}
