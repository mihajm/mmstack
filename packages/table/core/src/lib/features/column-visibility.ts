import { Signal } from '@angular/core';

export type ColumnVisibilityOptions = {
  columnVisibility?: {
    disable: boolean | (() => boolean);
  };
};

export type ColumnVisibilityState = {
  columnVisibility: Partial<Record<string, boolean>>;
};

export type ColumnVisibilityFeature = {
  columnVisibility: {
    toggle: () => void;
    show: () => void;
    hide: () => void;
    disabled: Signal<boolean>;
    visible: Signal<boolean>;
  };
};

export function createColumnVisibilityState(
  initial: Partial<ColumnVisibilityState> = {},
): ColumnVisibilityState {
  return {
    columnVisibility: {
      ...initial.columnVisibility,
    },
  };
}
