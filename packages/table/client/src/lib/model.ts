// import { createPaginationModel, createSortModel } from './features';
// import { DataModel } from '@mmstack/table-core';
// import { unwrap, wrap, WrapOptions } from './util';

// type ModelOptions<T> = WrapOptions<T>

// export function createClientModel<T, TColumnName extends string = string>(opt?: ModelOptions<T>): DataModel<T, TColumnName> {

//   const pagination = createPaginationModel<T, TColumnName>()
//   const sorting = createSortModel<T, TColumnName>()
//   return (data, features, columns) => {

//     const wrapped = wrap(data, columns, opt);

//     const sorted = sorting(wrapped, features);
//     const paginated = pagination(sorted, features);

//     return unwrap(paginated);
//   }

// }
