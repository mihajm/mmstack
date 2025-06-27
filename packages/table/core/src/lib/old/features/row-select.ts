import { computed, Signal, untracked, WritableSignal } from '@angular/core';

export type RowSelectState = Record<string | number, boolean>;

export type RowSelectFeature = {
  state: Signal<RowSelectState>;
  toggle: (rowId: string | number) => void;
  selectVisible: () => void;
  clearVisible: () => void;
  selectAll: () => void;
  clear: () => void;
  disabled: Signal<boolean>;
};

export type RowSelectOptions = {
  enableRowSelection?: boolean;
  enableMultirowSelection?: boolean;
};

export function mergeRowSelectState(
  state: Record<string | number, boolean> = {},
): RowSelectState {
  return state;
}

export function createRowSelect(
  state: WritableSignal<RowSelectState>,
  opt: RowSelectOptions,
): RowSelectFeature {
  return {
    state,
    clear: () => state.set({}),
    toggle: (rowId: string | number) => state.update((cur) => {
      const newState = { ...cur };
      if (newState[rowId]) {
        delete newState[rowId];
      } else {
        newState[rowId] = true;
      }
      return newState;
    }),
    selectVisible: () => untracked(state),
    clearVisible: () => untracked(state),
    selectAll: () => untracked(state),
    disabled: computed(() => !opt.enableRowSelection)
  };
}
