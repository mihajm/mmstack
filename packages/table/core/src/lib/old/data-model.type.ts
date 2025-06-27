import { Signal } from '@angular/core';
import { TableFeatures } from './table';
import { ColumnDef } from './column';

export type DataModel<T, TColumnName extends string = string> = (data: Signal<T[]>, features: TableFeatures<T, TColumnName>, columns: ColumnDef<T, any, TColumnName>[]) => Signal<T[]>;

export function createNoopModel<T, TColumnName extends string>(): DataModel<T, TColumnName> {
  return (data) => data
}
