# @mmstack/object

⚠️ DEPRECATED ⚠️

This library is deprecated and is no longer maintained.

Reason: Some of the primary features of this library (e.g., providing typed wrappers for Object.keys, Object.values) are now handled correctly by modern TypeScript versions out of the box. The rest are simple utility functions, that were only needed internally in 1-2 places. If you we're depending on a function like hash or mergeArray you can find a branch named `deprecate-object-utils` in the mmstack repository.

Action: You should remove this package from your dependencies and use native TypeScript functionality or copy the specific helper from the repo to your internal codebase.

A collection of lightweight, type-safe object and data structure utility functions written in TypeScript.

[![npm version](https://badge.fury.io/js/%40mmstack%2Fobject.svg)](https://badge.fury.io/js/%40mmstack%2Fobject)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/common/object/LICENSE)

Originally extracted from internal utilities used across several `@mmstack` projects, this library is published primarily to avoid code duplication within those projects. However, it might be useful for others seeking specific, focused helpers for common object manipulations, stable hashing, or merging tasks, especially within a TypeScript environment.

## Installation

```bash
npm install @mmstack/object
```

## API Overview

This library provides a small set of focused utilities. Here are the main exports:

```typescript
import {
  // Types
  EmptyObject, // Represents an object that must have no properties: Record<PropertyKey, never>
  UnknownObject, // Represents an object with any props, values are `unknown`: Record<PropertyKey, unknown>

  // Type Guards / Checks
  isPlainObject, // Checks if a value is a plain JS object ({} or new Object())

  // Typed Object Iteration Wrappers
  keys, // Typed `Object.keys()` wrapper -> (keyof T)[]
  values, // Typed `Object.values()` wrapper -> T[keyof T][]
  entries, // Typed `Object.entries()` wrapper -> [keyof T, T[keyof T]][]

  // Hashing
  hash, // Creates a stable JSON string hash (sorts plain object keys)

  // Merging
  mergeArray, // Merges two arrays element-wise using `mergeIfObject` logic
  mergeIfObject, // Merges two items: shallow merge for objects, delegates arrays, else returns 'next'
} from '@mmstack/object';
```

## Usage Examples

```typescript
import { keys, values, entries, hash, isPlainObject, mergeArray } from '@mmstack/object';

// --- Type Guards ---
const data: unknown = { key: 'value' };
if (isPlainObject(data)) {
  // data is narrowed to UnknownObject here
  console.log('Is a plain object');
}
console.log(isPlainObject([])); // => false

// --- Typed Object Iteration ---
// IMPORTANT: See Caveats below regarding string keys!
const obj = { a: 1, b: 'two', [Symbol('id')]: 3 };
const k = keys(obj); // typeof k is ('a' | 'b' | typeof id)[], value is ['a', 'b']
const v = values(obj); // typeof v is (number | string)[], value is [1, 'two']
const e = entries(obj); // typeof e is (['a' | 'b' | typeof id, number | string])[], value is [['a', 1], ['b', 'two']]

// --- Stable Hashing ---
const objA = { name: 'X', value: 1 };
const objB = { value: 1, name: 'X' };
console.log(hash('data', objA)); // => '["data",{"name":"X","value":1}]' (Keys sorted)
console.log(hash('data', objB)); // => '["data",{"name":"X","value":1}]' (Identical hash)

// --- Merging ---
const prev = [1, { id: 1, name: 'A' }, [10]];
const next = [2, { id: 1, status: 'B' }, [20], { extra: true }];
const merged = mergeArray(prev, next);
// => [ 2, { id: 1, name: "A", status: "B" }, [20], { extra: true } ]
// Primitives replaced, objects shallow merged, arrays replaced (delegated), extra element added from `next`.
```

For detailed descriptions, exact type signatures, and more specific examples, please refer to the JSDoc comments within the source code.

## Key Features

- Type-Safe Wrappers: Provides keys<T>, values<T>, entries<T> returning more specific TypeScript types than standard Object.keys/values/entries (with caveats, see below).
- Stable Hashing: Includes a hash function useful for cache keys, which produces consistent JSON strings by sorting the keys of plain objects before serialization.
- Specific Merge Logic: Offers mergeArray and mergeIfObject for a defined strategy of element-wise array merging combined with shallow object merging.
- Lightweight & Focused: Contains a small set of targeted utilities with minimal dependencies, written in TypeScript.

## Caveats & Limitations

- ⚠️ keys, values, entries Limitation: These functions provide stronger TypeScript return types (e.g., (keyof T)[]) but are implemented using the standard Object.keys, Object.values, and Object.entries. Therefore, they only operate on enumerable, string-keyed properties. They will not include symbol keys, number keys (which are stringified by Object.keys), or non-enumerable properties, even if those are part of the TypeScript type T. The generated types are useful, but do not perfectly reflect the runtime behavior in all cases. Please understand this limitation when using these functions.
- Shallow Merging: The mergeIfObject function performs a shallow merge ({...prev, ...next}) for objects. Nested objects within merged objects are not recursively merged.
- Hashing Limitations: The hash function relies on JSON.stringify and thus inherits its limitations (e.g., cannot serialize Functions, Symbols, undefined values, BigInts without a toJSON method, or handle circular references).

## Contributing

This library is deprecated and is no longer accepting contributions or pull requests.
