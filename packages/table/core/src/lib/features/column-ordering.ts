export type ColumnOrderingOptions = {
  columnOrdering?: {
    enabled: boolean | (() => boolean);
  };
};

export type ColumnOrderingState = {
  columnOrdering: string[];
};

export type ColumnOrderingFeature = {
  columnOrdering: {
    moveTo: (idx: number) => void;
    moveToStart: () => void;
    moveToEnd: () => void;
  };
};

export function createColumnOrderingState(
  initial: Partial<ColumnOrderingState> = {},
): ColumnOrderingState {
  return {
    columnOrdering: initial.columnOrdering ?? [],
  };
}
