import { Signal } from '@angular/core';
import { Column } from './column';

export type ResolvedValue = string | number | boolean | null;

export type Cell<T, C = any> = Column<T, C> & {
  sortValue: Signal<string | number | boolean>;
  filterValue: Signal<ResolvedValue>;
  value: Signal<T>;
  displayValue: Signal<string>;
};
