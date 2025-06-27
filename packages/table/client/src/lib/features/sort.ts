// import { computed, Signal, linkedSignal } from '@angular/core';
// import { SortFeature, Row, SortState, DataModel, TableFeatures } from '@mmstack/table-core';
// import { Wrapped } from '../util';

// function sortBasic(a?: string | number, b?: string | number) {
//   if (a === undefined && b === undefined) return 0;
//   if (a === undefined) return 1;
//   if (b === undefined) return -1;

//   if (typeof a === 'string' && typeof b === 'string') {
//     return a.localeCompare(b);
//   }

//   if (a < b) return -1;
//   if (a > b) return 1;
//   return 0;
// }

// export function createSortModel<T, TColumnName extends string = string>() {

//   return (data: Signal<Wrapped<T, TColumnName>[]>, features: TableFeatures<T, TColumnName>) => {

//     return computed(() => {
//       const sort = features.sort.state();
//       if (!sort) return data();

//       return data().toSorted((a, b) => {

//         const aValue = a.sort[sort.name]();
//         const bValue = b.sort[sort.name]();

//         return sort.direction === 'asc' ? sortBasic(aValue, bValue) : -sortBasic(aValue, bValue);
//       });

//     });
//   };
// }
