import { isDevMode, Signal, WritableSignal } from '@angular/core';

export type SortDirection  = 'asc' | 'desc';

export type SortState<TColumnName extends string> = {
  name: TColumnName;
  direction: SortDirection;
} | null;


export type SortFeature<TColumnName extends string> = {
  state: Signal<SortState<TColumnName>>;
  sort: (name: TColumnName, direction: SortDirection) => void;
  toggleSort: (name: TColumnName) => void;
  clearSort: () => void;
}


function nextSortDirection(current?: SortDirection): SortDirection | null {
  if (!current) return "asc";
  if (current === 'asc') return 'desc';
  return null;
}

export function mergeSortState<TColumnName extends string>(sort?: Partial<SortState<TColumnName>>): SortState<TColumnName> {
  if (!sort) return null;
  if (!sort.name) {
    if (isDevMode()) console.warn("Sort name is required in initial sort state");
    return null;
  }

  return {
    name: sort.name,
    direction: sort.direction ?? 'asc'
  }
}


export function createSortState<TColumnName extends string>(
  state: WritableSignal<SortState<TColumnName>>
): SortFeature<TColumnName> {

  return {
    state,
    clearSort: () => state.set(null),
    sort: (name: TColumnName, direction: SortDirection) => state.set({
      name,
      direction
    }),
    toggleSort: (name: TColumnName) => state.update((cur) => {
      const next = nextSortDirection(cur?.name === name ? cur.direction : undefined);
      if (next === null) return null;

      return {
        name,
        direction: next
      }
    })
  }
}


