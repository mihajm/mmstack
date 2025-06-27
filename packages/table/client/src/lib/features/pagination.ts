// import { computed, Signal } from '@angular/core';
// import { TableFeatures } from '@mmstack/table-core';
// import { Wrapped } from '../util';

// export function createPaginationModel<T, TColumnName extends string = string>() {
//   return (data: Signal<Wrapped<T, TColumnName>[]>, {pagination}: TableFeatures<T, TColumnName>) => {
//     const from = computed(() => pagination.page() * pagination.pageSize.value());
//     const to = computed(() => (pagination.page() + 1) * pagination.pageSize.value());

//     return computed(() => data().slice(from(), to()));
//   };
// }
