import {
  HttpContext,
  HttpHeaders,
  HttpParams,
  HttpResourceRequest,
} from '@angular/common/http';
import { type ValueEqualityFn } from '@angular/core';

type UnknownObject = Record<PropertyKey, unknown>;

/**
 * Checks if `value` is a plain JavaScript object (e.g., `{}` or `new Object()`).
 * Distinguishes from arrays, null, and class instances. Acts as a type predicate,
 * narrowing `value` to `UnknownObject` if `true`.
 *
 * @param value The value to check.
 * @returns {value is UnknownObject} `true` if `value` is a plain object, otherwise `false`.
 * @example
 * isPlainObject({}) // => true
 * isPlainObject([]) // => false
 * isPlainObject(null) // => false
 * isPlainObject(new Date()) // => false
 */
function isPlainObject(value: unknown): value is UnknownObject {
  if (value === null || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Internal helper to generate a stable JSON string from an array.
 * Sorts keys of plain objects within the array alphabetically before serialization
 * to ensure hash stability regardless of key order.
 *
 * @param queryKey The array of values to serialize.
 * @returns A stable JSON string representation.
 * @internal
 */
function hashKey(queryKey: unknown[]): string {
  return JSON.stringify(queryKey, (_, val) =>
    isPlainObject(val)
      ? Object.keys(val)
          .toSorted()
          .reduce((result, key) => {
            result[key] = val[key];
            return result;
          }, {} as UnknownObject)
      : val,
  );
}

/**
 * Generates a stable, unique string hash from one or more arguments.
 * Useful for creating cache keys or identifiers where object key order shouldn't matter.
 *
 * How it works:
 * - Plain objects within the arguments have their keys sorted alphabetically before hashing.
 * This ensures that `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same hash.
 * - Uses `JSON.stringify` internally with custom sorting for plain objects via `hashKey`.
 * - Non-plain objects (arrays, Dates, etc.) and primitives are serialized naturally.
 *
 * @param {...unknown} args Values to include in the hash.
 * @returns A stable string hash representing the input arguments.
 * @example
 * const userQuery = (id: number) => ['user', { id, timestamp: Date.now() }];
 *
 * const obj1 = { a: 1, b: 2 };
 * const obj2 = { b: 2, a: 1 }; // Same keys/values, different order
 *
 * hash('posts', 10);
 * // => '["posts",10]'
 *
 * hash('config', obj1);
 * // => '["config",{"a":1,"b":2}]'
 *
 * hash('config', obj2);
 * // => '["config",{"a":1,"b":2}]' (Same as above due to key sorting)
 *
 * hash(['todos', { status: 'done', owner: obj1 }]);
 * // => '[["todos",{"owner":{"a":1,"b":2},"status":"done"}]]'
 *
 * // Be mindful of values JSON.stringify cannot handle (functions, undefined, Symbols)
 * // hash('a', undefined, function() {}) => '["a",null,null]'
 */
function hash(...args: unknown[]): string {
  return hashKey(args);
}

function equalTransferCache(
  a: HttpResourceRequest['transferCache'],
  b: HttpResourceRequest['transferCache'],
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  if (typeof a !== typeof b) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;

  if (!a.includeHeaders && !b.includeHeaders) return true;
  if (!a.includeHeaders || !b.includeHeaders) return false;

  if (a.includeHeaders.length !== b.includeHeaders.length) return false;

  if (a.includeHeaders.length === 0) return true;

  const aSet = new Set(a.includeHeaders ?? []);

  return b.includeHeaders.every((header) => aSet.has(header));
}

function equalParamArray(
  a: Array<string | number | boolean>,
  b: Array<string | number | boolean>,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;

  return a.every((value) => b.includes(value));
}

function headersToObject(headerClass: HttpHeaders) {
  const headers: Exclude<
    Required<HttpResourceRequest['headers']>,
    HttpHeaders | undefined
  > = {};

  headerClass.keys().forEach((key) => {
    const value = headerClass.getAll(key);
    if (value === null) return;
    if (value.length === 1) {
      headers[key] = value[0];
    } else {
      headers[key] = value;
    }
  });

  return headers;
}

function paramToObject(paramsClass: HttpParams) {
  const params: Exclude<
    Required<HttpResourceRequest['params']>,
    HttpParams | undefined
  > = {};

  paramsClass.keys().forEach((key) => {
    const value = paramsClass.getAll(key);
    if (value === null) return;
    if (value.length === 1) {
      params[key] = value[0];
    } else {
      params[key] = value;
    }
  });

  return params;
}

function equalParams(
  a: HttpResourceRequest['params'],
  b: HttpResourceRequest['params'],
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  const aObj = a instanceof HttpParams ? paramToObject(a) : a;
  const bObj = b instanceof HttpParams ? paramToObject(b) : b;

  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => {
    if (Array.isArray(aObj[key]) || Array.isArray(bObj[key])) {
      return equalParamArray(
        Array.isArray(aObj[key]) ? aObj[key] : [aObj[key]],
        Array.isArray(bObj[key]) ? bObj[key] : [bObj[key]],
      );
    }

    return aObj[key] === bObj[key];
  });
}

function equalBody(
  a: HttpResourceRequest['body'],
  b: HttpResourceRequest['body'],
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return hash(a) === hash(b);
}

function equalHeaders(
  a: HttpResourceRequest['headers'],
  b: HttpResourceRequest['headers'],
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  const aObj = a instanceof HttpHeaders ? headersToObject(a) : a;
  const bObj = b instanceof HttpHeaders ? headersToObject(b) : b;

  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => {
    if (Array.isArray(aObj[key]) || Array.isArray(bObj[key])) {
      return equalParamArray(
        Array.isArray(aObj[key]) ? aObj[key] : [aObj[key]],
        Array.isArray(bObj[key]) ? bObj[key] : [bObj[key]],
      );
    }

    return aObj[key] === bObj[key];
  });
}

function toHttpContextEntries(ctx: HttpResourceRequest['context']) {
  if (!ctx) return [];

  if (ctx instanceof HttpContext) {
    const tokens = Array.from(ctx.keys());
    return tokens.map((key) => [key.toString(), ctx.get(key)] as const);
  }

  if (typeof ctx === 'object') {
    return Object.entries(ctx) as Array<[string, unknown]>;
  }

  return [];
}

function equalContext(
  a: HttpResourceRequest['context'],
  b: HttpResourceRequest['context'],
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  const aEntries = toHttpContextEntries(a);
  const bEntries = toHttpContextEntries(b);
  if (aEntries.length !== bEntries.length) return false;
  if (aEntries.length === 0) return true;
  const bMap = new Map(bEntries);
  return aEntries.every(([key, value]) => value === bMap.get(key));
}

export function createEqualRequest<TResult>(
  equalResult?: ValueEqualityFn<TResult>,
) {
  const eqb = equalResult ?? equalBody;

  return (
    a: Partial<HttpResourceRequest> | undefined,
    b: Partial<HttpResourceRequest> | undefined,
  ) => {
    if (!a && !b) return true;
    if (!a || !b) return false;

    if (a.url !== b.url) return false;
    if (a.method !== b.method) return false;
    if (!equalParams(a.params, b.params)) return false;
    if (!equalHeaders(a.headers, b.headers)) return false;
    if (!eqb(a.body as TResult, b.body as TResult)) return false;
    if (!equalContext(a.context, b.context)) return false;

    if (a.withCredentials !== b.withCredentials) return false;
    if (a.reportProgress !== b.reportProgress) return false;
    if (!equalTransferCache(a.transferCache, b.transferCache)) return false;

    return true;
  };
}
