import {
  computed,
  isSignal,
  ValueEqualityFn,
  WritableSignal,
} from '@angular/core';
import { mapArray } from '@mmstack/primitives';
import { createColumns, type ColumnDef } from './column';
import {
  ColumnOrderingOptions,
  ColumnOrderingState,
  ColumnVisibilityOptions,
  ColumnVisibilityState,
  createColumnOrderingState,
  createColumnVisibilityState,
  createPagination,
  createPaginationState,
  PaginationFeature,
  PaginationOptions,
  PaginationState,
} from './features';
import { createRow } from './row';
import { DeepPartial } from './util';

export type TableState = PaginationState &
  ColumnOrderingState &
  ColumnVisibilityState;

export type TableOptions<T> = PaginationOptions &
  ColumnOrderingOptions &
  ColumnVisibilityOptions & {
    columns: ColumnDef<T>[];
    equal?: ValueEqualityFn<T>;
  };

export type Table<T> = {
  state: WritableSignal<TableState>;
  features: PaginationFeature;
};

export function createTableState(
  initial: DeepPartial<TableState> = {},
): TableState {
  return {
    pagination: createPaginationState(initial).pagination,
    columnOrdering: createColumnOrderingState(initial).columnOrdering,
    columnVisibility: createColumnVisibilityState(initial).columnVisibility,
  };
}

export function createTable<T>(
  src: () => T[],
  state: WritableSignal<TableState>,
  opt: TableOptions<T>,
): Table<T> {
  const columns = createColumns(opt.columns, state, opt);

  const length = computed(() => src().length);

  const tc = opt.pagination?.totalCount ?? length;

  const features = {
    ...createPagination(state, {
      ...opt,
      resolvedTotalCount:
        typeof tc === 'number' ? computed(() => tc) : computed(tc),
    }),
  };

  const sourceSignal = isSignal(src) ? src : computed(src);

  const rows = mapArray(
    sourceSignal,
    (item) =>
      createRow(item, {
        columns,
      }),
    {
      equal: opt.equal,
    },
  );

  return {
    state,
    features,
  };
}
