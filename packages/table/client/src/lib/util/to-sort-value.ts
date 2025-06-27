// export function defaultToSortValue<U>(value: U): string | number {
//   if (typeof value === "string" || typeof value === "symbol" || typeof value === "bigint") return value.toString().toLowerCase().trim();

//   if (value === null || value === undefined  || typeof value === "function") {
//     return -Infinity;
//   }

//   if (typeof value === "number") {
//     return isNaN(value) ? -Infinity : value
//   }

//   if (value instanceof Date) {
//     return value.getTime();
//   }

//   if (Array.isArray(value)) return value.length;

//   if (typeof value === "object") {
//     return Object.keys(value).length;
//   }

//   return Number(value);
// }
