import { Signal, WritableSignal } from '@angular/core';

export type ColumnOrderState<TColumnName extends string> = TColumnName[];

export type ColumnOrderFeature<TColumnName extends string> = {
  state: Signal<ColumnOrderState<TColumnName>>;
  set: (name: TColumnName, to: number) => void;
};

export function mergeColumnOrderState<TColumnName extends string>(
  columnDefs: TColumnName[],
  initial: TColumnName[] = [],
) {
  const withoutExtra = initial.filter((name) => columnDefs.includes(name));

  if (withoutExtra.length === 0) return columnDefs;
  if (withoutExtra.length === columnDefs.length) return withoutExtra;

  return [
    ...withoutExtra,
    ...columnDefs.filter((name) => !withoutExtra.includes(name)),
  ];
}

export function createColumnOrderFeature<TColumnName extends string>(
  state: WritableSignal<ColumnOrderState<TColumnName>>,
): ColumnOrderFeature<TColumnName> {
  return {
    state,
    set: (name: TColumnName, to: number) => {
      state.update((cur) => cur.filter((n) => n !== name).toSpliced(to, 0, name));
    },
  };
}
