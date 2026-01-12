// import {
//     computed,
//     type CreateSignalOptions,
//     isSignal,
//     linkedSignal,
//     type Signal,
//     signal,
//     untracked,
//     type WritableSignal,
// } from '@angular/core';
// import { derived } from './derived';
// import { isMutable, MutableSignal } from './mutable';
// import { toWritable } from './to-writable';

// /**
//  * @internal
//  * Checks if a signal is a WritableSignal.
//  * @param sig The signal to check.
//  */
// function isWritable<T>(sig: Signal<T>): sig is WritableSignal<T> {
//   return 'set' in sig;
// }

// /**
//  * @internal
//  * Creates a setter function for a source signal of type `Signal<T[]>` or a function returning `T[]`.
//  * @param source The source signal of type `Signal<T[]>` or a function returning `T[]`.
//  * @returns
//  */
// function createSetter<T>(
//   source: Signal<T[]>,
// ): (value: T, index: number) => void {
//   if (!isWritable(source))
//     return () => {
//       // noop;
//     };

//   if (isMutable(source))
//     return (value, index) => {
//       source.inline((arr) => {
//         arr[index] = value;
//       });
//     };

//   return (value, index) => {
//     source.update((arr) => arr.map((v, i) => (i === index ? value : v)));
//   };
// }

// /**
//  * Reactively maps items from a source array to a new array using a key function to maintain stability.
//  *
//  * This function preserves the `mapped` signals for items even if they move within the array,
//  * as long as their key remains the same. This is equivalent to SolidJS's `mapArray` or Angular's `@for (item of items; track item.id)`.
//  *
//  * @template T The type of items in the source array.
//  * @template U The type of items in the resulting mapped array.
//  * @template K The type of the key.
//  *
//  * @param source A `Signal<T[]>` or a function returning `T[]`.
//  * @param keyFn A function to extract a unique key for each item.
//  * @param map The mapping function. It receives a stable signal for the item and a signal for its index.
//  * @param options Optional configuration, including `CreateSignalOptions` and an `onDestroy` callback.
//  * @returns A `Signal<U[]>` containing the mapped array.
//  */
// export function keyedArray<T, U, K>(
//   source: MutableSignal<T[]>,
//   keyFn: (item: T, index: number) => K,
//   map: (value: MutableSignal<T>, index: Signal<number>) => U,
//   options?: CreateSignalOptions<T> & {
//     onDestroy?: (value: U) => void;
//   },
// ): Signal<U[]>;

// export function keyedArray<T, U, K>(
//   source: WritableSignal<T[]>,
//   keyFn: (item: T, index: number) => K,
//   map: (value: WritableSignal<T>, index: Signal<number>) => U,
//   options?: CreateSignalOptions<T> & {
//     onDestroy?: (value: U) => void;
//   },
// ): Signal<U[]>;

// export function keyedArray<T, U, K>(
//   source: Signal<T[]> | (() => T[]),
//   keyFn: (item: T, index: number) => K,
//   map: (value: Signal<T>, index: Signal<number>) => U,
//   options?: CreateSignalOptions<T> & {
//     onDestroy?: (value: U) => void;
//   },
// ): Signal<U[]>;

// export function keyedArray<T, U, K>(
//   source: Signal<T[]> | (() => T[]),
//   keyFn: (item: T, index: number) => K,
//   map:
//     | ((value: Signal<T>, index: Signal<number>) => U)
//     | ((value: WritableSignal<T>, index: Signal<number>) => U)
//     | ((value: MutableSignal<T>, index: Signal<number>) => U),
//   options?: CreateSignalOptions<T> & {
//     onDestroy?: (value: U) => void;
//   },
// ): Signal<U[]> {
//   const data = isSignal(source) ? source : computed(source);
//   const setter = createSetter(data);
//   const opt = { ...options };

//   const writableData = isWritable(data)
//     ? data
//     : toWritable(data, () => {
//         // noop
//       });

//   // Default equality check for mutable signals if not provided
//   if (isWritable(data) && isMutable(data) && !opt.equal) {
//     opt.equal = (a: T, b: T) => {
//       if (a !== b) return false;
//       return false; // opt out for same refs
//     };
//   }

//   // Internal cache to track existing items
//   // Key -> { itemSignal, indexSignal, value (U) }
//   const cache = new Map<
//     K,
//     {
//       itemSignal: Signal<T> | WritableSignal<T> | MutableSignal<T>;
//       indexSignal: WritableSignal<number>;
//       value: U;
//     }
//   >();

//   return linkedSignal<T[], U[]>({
//     source: () => data(),
//     computation: (currentItems, prevMapped) => {
//       const newMapped: U[] = [];
//       const newKeys = new Set<K>();

//       // Pass 1: Create or reuse items
//       for (let i = 0; i < currentItems.length; i++) {
//         const item = currentItems[i];
//         const key = keyFn(item, i);
//         newKeys.add(key);

//         let record = cache.get(key);

//         if (record) {
//           // Reuse existing
//           // Update the index signal if it changed
//           if (untracked(record.indexSignal) !== i) {
//             record.indexSignal.set(i);
//           }
//           // The itemSignal is 'derived' from source + indexSignal, so it auto-updates when indexSignal changes
//           // or when source changes. We don't need to manually update it here.

//           newMapped.push(record.value);
//         } else {
//           // Create new
//           const indexSignal = signal(i);

//           // Create the item signal
//           // It derives its value by looking up the current item from the source array using the *current* index
//           const itemSignal = derived(
//             writableData as MutableSignal<T[]>,
//             {
//               from: (arr) => {
//                 const idx = indexSignal();
//                 // Safety check: if the array shrank or index is out of bounds (shouldn't happen in sync flow but good for safety)
//                 if (idx < 0 || idx >= arr.length) return undefined as any;
//                 return arr[idx];
//               },
//               onChange: (newValue) => setter(newValue, indexSignal()),
//             },
//             opt
//           );
// å
//           const mappedValue = map(itemSignal, indexSignal);

//           record = {
//             itemSignal,
//             indexSignal,
//             value: mappedValue,
//           };

//           cache.set(key, record);
//           newMapped.push(mappedValue);
//         }
//       }

//       // Pass 2: cleanup removed items
//       // We iterate the cache to find keys that are NOT in newKeys.
//       for (const [key, record] of cache.entries()) {
//         if (!newKeys.has(key)) {
//            options?.onDestroy?.(record.value);
//            cache.delete(key);
//         }
//       }

//       return newMapped;
//     },
//     equal: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
//   });
// }
