import { Signal, WritableSignal } from '@angular/core';

export type ColumnVisibilityState = Partial<Record<string, false>>;

export type ColumnVisibilityFeature = {
  state: Signal<ColumnVisibilityState>;
  set: (name: string, visible: boolean) => void;
  toggle: (name: string) => void;
};

export function mergeColumnVisibilityState(
  initialState: ColumnVisibilityState = {},
): ColumnVisibilityState {
  return initialState;
}

export function createColumnVisibilityFeature(
  state: WritableSignal<ColumnVisibilityState>,
): ColumnVisibilityFeature {
  const set = (name: string, visible?: boolean) => {
    state.update((cur) => {
      const setTo = visible ?? !(cur[name] ?? true);

      const next = { ...cur };

      if (setTo) {
        delete next[name];
      } else {
        next[name] = false;
      }

      return next;
    });
  };
  return {
    state,
    set,
    toggle: set,
  };
}
