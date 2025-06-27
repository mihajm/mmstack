import {
  computed,
  isSignal,
  signal,
  Signal,
  WritableSignal,
} from '@angular/core';
import { derived, mapArray } from '@mmstack/primitives';
import { ColumnDef } from './column';
import {
  createPaginationFeature,
  mergePaginationState,
  PaginationFeature,
  PaginationOptions,
  PaginationState,
  GlobalFilteringState,
  GlobalFilteringOptions,
  GlobalFilteringFeature,
  createGlobalFilter,
  createSortState,
  SortFeature,
  mergeSortState,
  SortState,
  ColumnVisibilityState,
  mergeColumnVisibilityState,
  ColumnVisibilityFeature,
  createColumnVisibilityFeature,
  ColumnOrderState,
  ColumnOrderFeature,
  mergeColumnOrderState,
  createColumnOrderFeature,
} from './features';
import {
  createFooterRow,
  createHeaderRow,
  createRow,
  FooterRow,
  HeaderRow,
  Row,
} from './row';
import { createNoopModel, DataModel } from './data-model.type';
import {
  createRowSelect,
  mergeRowSelectState,
  RowSelectFeature,
  RowSelectOptions,
  RowSelectState,
} from './features/row-select';

export type TableState<TColumnName extends string = string> = {
  pagination: PaginationState;
  globalFilter: GlobalFilteringState;
  sort: SortState<TColumnName>;
  columnVisibility: ColumnVisibilityState;
  columnOrder: ColumnOrderState<TColumnName>;
  rowSelect: RowSelectState;
};

type TableOptions<T, TColumnName extends string> = {
  pagination?: PaginationOptions;
  globalFilter?: GlobalFilteringOptions<T>;
  sort?: SortState<TColumnName>;
  rowSelect?: RowSelectOptions;
};

export type CreateTableOptions<T, TColumnName extends string = string> = {
  data: () => T[];
  columns: ColumnDef<T, any, TColumnName>[];
  state: WritableSignal<TableState<TColumnName>>;
  opt?: TableOptions<T, TColumnName>;
  model?: DataModel<T, TColumnName>;
};

export type TableFeatures<T, TColumnName extends string = string> = {
  pagination: PaginationFeature;
  globalFilter: GlobalFilteringFeature;
  sort: SortFeature<TColumnName>;
  columnVisibility: ColumnVisibilityFeature;
  columnOrder: ColumnOrderFeature<TColumnName>;
  rowSelect: RowSelectFeature;
};

export type Table<T, TColumnName extends string = string> = {
  header: {
    rows: Signal<HeaderRow<TColumnName>[]>;
  };
  body: {
    rows: Signal<Row<T, TColumnName>[]>;
  };
  footer: {
    rows: Signal<FooterRow<TColumnName>[]>;
  };
  features: TableFeatures<T, TColumnName>;
};

type DeepPartial<T> = T extends any[]
  ? T
  : T extends object
    ? T extends null
      ? null
      : {
          [K in keyof T]?: DeepPartial<T[K]>;
        }
    : T;

function mergeState<T, TColumnName extends string = string>(
  defs: ColumnDef<T, any, TColumnName>[],
  state?: DeepPartial<TableState>,
): TableState {
  return {
    pagination: mergePaginationState(state?.pagination),
    globalFilter: state?.globalFilter ?? '',
    sort: mergeSortState(state?.sort),
    columnVisibility: mergeColumnVisibilityState(state?.columnVisibility),
    columnOrder: mergeColumnOrderState(
      defs.map((d) => d.name),
      state?.columnOrder,
    ),
    rowSelect: mergeRowSelectState(state?.rowSelect as RowSelectState),
  };
}

export function createTableState<T, TColumName extends string = string>(
  columns: ColumnDef<T, any, TColumName>[],
  initial?: DeepPartial<TableState>,
): WritableSignal<TableState> {
  return signal(mergeState(columns, initial));
}

export function createTable<T, TColumnName extends string>(opt: CreateTableOptions<T, TColumnName>): Table<T, TColumnName> {
  const fullData = isSignal(opt.data) ? opt.data : computed(opt.data);

  const model = opt.model ?? createNoopModel<T, TColumnName>();

  const features: TableFeatures<T, TColumnName> = {
    pagination: createPaginationFeature(derived(opt.state, 'pagination'), {
      total: () => 0,
      ...opt.opt?.pagination,
    }),
    globalFilter: createGlobalFilter(opt.state, opt.opt?.globalFilter),
    sort: createSortState<TColumnName>(
      derived(opt.state, 'sort', {
        equal: (a, b) => a?.name === b?.name && a?.direction === b?.direction,
      }),
    ),
    columnVisibility: createColumnVisibilityFeature(
      derived(opt.state, 'columnVisibility'),
    ),
    columnOrder: createColumnOrderFeature(derived(opt.state, 'columnOrder')),
    rowSelect: createRowSelect(derived(opt.state, 'rowSelect'), {
      enableRowSelection: opt?.opt?.rowSelect?.enableRowSelection ?? false,
    }),
  };

  const data = model(fullData, features, opt.columns);

  const allRows = mapArray<T, Row<T, TColumnName>>(data, (source) =>
    createRow(source, opt.columns, features),
  );

  const headerRows = computed(() => [createHeaderRow(opt.columns, features)]);
  const footerRows = computed(() => [createFooterRow(opt.columns, features)]);



  return {
    header: {
      rows: headerRows,
    },
    body: {
      rows: allRows,
    },
    footer: {
      rows: footerRows,
    },
    features,
  };
}
