// // import { computed, Signal } from '@angular/core';
// // import { GlobalFilteringFeature, Row } from '@mmstack/table-core';
// //
// // const GLOBAL_FILTER_SYMBOL = Symbol.for('TABLE_GLOBAL_FILTER_SYMBOL');
// //
// // export function createGlobalFiltering<T>(
// //   source: Signal<Row<T>[]>,
// //   feature: GlobalFilteringFeature,
// // ): Signal<Row<T>[]> {
// //   if (!toString) return source;
// //   const query = computed(() => feature.value()?.toLowerCase().trim() ?? '');
// //
// //   const withFilter = computed(() =>
// //     source().map((row) => ({
// //       ...row,
// //       [GLOBAL_FILTER_SYMBOL]: computed(() => {
// //         const q = query();
// //         if (!q) return true;
// //         return row.filterValue().includes(q);
// //       }),
// //     })),
// //   );
// //
// //   return computed(() => withFilter().filter((r) => r[GLOBAL_FILTER_SYMBOL]()));
// // }

// import { computed, Signal } from '@angular/core';
// import { Wrapped } from '../util';
// import { TableFeatures } from '@mmstack/table-core';

// export function createGlobalFilterModel<T, TColumnName extends string = string>() {

//   return (data: Signal<Wrapped<T, TColumnName>[]>, features: TableFeatures<T, TColumnName>) => {

//     return data;
//   }
// }
