import { Signal } from '@angular/core';
import { Column } from './column';

export type Row<T> = {
  id: string;
  source: Signal<T>;
};

type CreateRowOptions<T> = {
  columns: Signal<Signal<Column<T>>[]>;
};

export function createRow<T>(
  source: Signal<T>,
  opt: CreateRowOptions<T>,
): Row<T> {
  return {
    id: crypto.randomUUID(),
    source,
  };
}
