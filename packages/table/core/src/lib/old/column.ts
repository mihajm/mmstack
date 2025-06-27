import { ValueEqualityFn } from '@angular/core';

type FilterDef<T, U, TFilterValue = string> = {
  identify?: (value: U, source: T) => TFilterValue;
  filterFn?: (filterValue: TFilterValue, value: U, source: T) => boolean;
}

export type ColumnDef<T, U, TName extends string = string> =  {
  name: TName;
  accessor: (row: T) => U;
  header?: () => string;
  footer?: () => string;
  equal?: ValueEqualityFn<U>;
  toGlobalFilterValue?: (value: U, source: T) => string | null;
  toSortValue?: (value: U, source: T) => string | number;
  filter?: FilterDef<T, U>;
};


type ColumnHelper<T> = {
  accessor: <U, TName extends string>(fn: (source: T) => U, opt: Omit<ColumnDef<T, U, TName>, "accessor">) => ColumnDef<T, U, TName>;
}

export function createColumnHelper<T>(): ColumnHelper<T> {

  return {
    accessor: (accessor, opt) => {
      return {
        ...opt,
        accessor
      }
    }
  }
}

