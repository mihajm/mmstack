// import { computed, Signal } from '@angular/core';
// import { mapArray } from '@mmstack/primitives';
// import { ColumnDef } from '@mmstack/table-core';
// import { defaultToSortValue } from './to-sort-value';

// function defaultToString(value: unknown): string | null {
//   if (
//     typeof value === 'object' ||
//     typeof value === 'undefined' ||
//     typeof value === 'function' ||
//     value === null
//   )
//     return null;

//   return value.toString().toLowerCase().trim() || null;
// }

// export type Wrapped<T, TColumnName extends string> = {
//   source: Signal<T>;
//   mergedFilterValue: Signal<string | null>;
//   filters: Record<TColumnName, Signal<string | null>>
//   sort: Record<TColumnName, Signal<string | number>>;
// };

// export type WrapOptions<T> = {
//   globalFilterAccessor?: (source: T) => string | string[];
// }

// export function wrap<T, TColumnName extends string = string>(
//   data: Signal<T[]>,
//   columns: ColumnDef<T, any, TColumnName>[],
//   opt?: WrapOptions<T>
// ) {
//   return mapArray(data, (source): Wrapped<T, TColumnName> => {
//     const cols = columns.map((c) => {
//       const value = computed(() => c.accessor(source()), {
//         equal: c.equal,
//       });

//       const sortFn = c.toSortValue ?? defaultToSortValue;

//       const globalFilterFn = c.toGlobalFilterValue ?? defaultToString;

//       const columnFilterIdentity = computed(() =>  {
//         const identify = c.filter?.identify;
//         return identify ? identify(value(), source()) : `${value()}`;
//       });

//       const globalFilterValue = computed(() => opt?.globalFilterAccessor ? null : globalFilterFn(value, source()));

//       const columnMatchFn = c.filter?.filterFn ?? ((fv: string, value: string) => value.toLowerCase().includes(fv));

//       return {
//         ...c,
//         sortValue: computed(() => sortFn(value(), source())),
//         globalFilterValue: computed(() => opt?.globalFilterAccessor ? null : globalFilterFn(value, source())),
//       };
//     });

//     return {
//       source,
//       sort: cols.reduce(
//         (acc, c) => {
//           acc[c.name] = c.sortValue;
//           return acc;
//         },
//         {} as Record<TColumnName, Signal<string | number>>,
//       ),
//       filters: cols.reduce((acc, c) => {
//           acc[c.name] = c.globalFilterValue;
//           return acc;
//         }, {} as Record<TColumnName, Signal<string | null>>),
//       mergedFilterValue: computed(() => {
//         const rgf = opt?.globalFilterAccessor;

//         if (rgf) {
//           const result = rgf(source());
//           return typeof result === "string" ? result : result.join('::INTERNAL_MMSTACK_DELIM::').toLowerCase().trim();
//         }

//         const filterValues = cols.map((c) => c.globalFilterValue()).filter((v) => v !== null);
//         if (filterValues.length === 0) return null;

//         return filterValues.join('::INTERNAL_MMSTACK_DELIM::').toLowerCase().trim();
//       }),
//     };
//   });
// }

// export function unwrap<T, TColumnName extends string = string>(
//   wrapped: Signal<Wrapped<T, TColumnName>[]>,
// ): Signal<T[]> {
//   return computed(() => wrapped().map((m) => m.source()));
// }
