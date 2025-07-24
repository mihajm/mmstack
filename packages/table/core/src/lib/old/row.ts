import { computed, Signal } from '@angular/core';
import {
  Cell,
  createCell,
  createFooterCell,
  createHeaderCell,
  FooterCell,
  HeaderCell,
} from './cell';
import { ColumnDef } from './column';
import { TableFeatures } from './table';

export type Row<T, TColumnName extends string> = {
  id: string;
  source: Signal<T>;
  cells: Signal<Cell<any, TColumnName>[]>;
  visibleCells: Signal<Cell<any, TColumnName>[]>;
  cellMap: Signal<Map<string, Cell<any, TColumnName>>>;
};

export type FooterRow<TColumnName extends string> = {
  id: string;
  cells: Signal<FooterCell<TColumnName>[]>;
  visibleCells: Signal<FooterCell<TColumnName>[]>;
};

export type HeaderRow<TColumnName extends string> = {
  id: string;
  cells: Signal<HeaderCell<TColumnName>[]>;
  visibleCells: Signal<HeaderCell<TColumnName>[]>;
};

export type CreateRowOptions<T> = {
  toString?: (value: T) => string;
};

export function createRow<T, TColumnName extends string>(
  source: Signal<T>,
  defs: ColumnDef<T, any, TColumnName>[],
  features: TableFeatures<T, TColumnName>,
): Row<T, TColumnName> {
  const allCells = computed(() =>
    defs.map((d) => createCell(source, d, features)),
  );
  const cellMap = computed(() => new Map(allCells().map((c) => [c.name, c])));

  const cells = computed(() =>
    features.columnOrder
      .state()
      .map((name) => cellMap().get(name) ?? null)
      .filter((c) => c !== null),
  );

  const visibleCells = computed(() =>
    cells().filter((c) =>
      computed(() => features.columnVisibility.state()[c.name] !== false)(),
    ),
  );

  return {
    id: crypto.randomUUID(),
    source,
    cells,
    visibleCells,
    cellMap: computed(() => new Map(cells().map((c) => [c.name, c]))),
  };
}

export function createHeaderRow<T, TColumnName extends string>(
  defs: ColumnDef<T, any, TColumnName>[],
  features: Omit<TableFeatures<T, TColumnName>, 'pagination'>,
): HeaderRow<TColumnName> {
  const allCells = computed(() =>
    defs.map((d) => createHeaderCell(d, features)),
  );
  const cellMap = computed(() => new Map(allCells().map((c) => [c.name, c])));

  const cells = computed(() =>
    features.columnOrder.state().map((name) => cellMap().get(name)!),
  );
  return {
    id: crypto.randomUUID(),
    cells,
    visibleCells: computed(() =>
      cells().filter((c) =>
        computed(() => features.columnVisibility.state()[c.name] !== false)(),
      ),
    ),
  };
}

export function createFooterRow<T, TColumnName extends string>(
  defs: ColumnDef<T, any, TColumnName>[],
  features: Omit<TableFeatures<T, TColumnName>, 'pagination'>,
): FooterRow<TColumnName> {
  const allCells = computed(() => defs.map((d) => createFooterCell(d)));
  const cellMap = computed(() => new Map(allCells().map((c) => [c.name, c])));

  const cells = computed(() =>
    features.columnOrder
      .state()
      .map((name) => cellMap().get(name) ?? null)
      .filter((c) => c !== null),
  );
  return {
    id: crypto.randomUUID(),
    cells,
    visibleCells: computed(() =>
      cells().filter((c) =>
        computed(() => features.columnVisibility.state()[c.name] !== false)(),
      ),
    ),
  };
}
