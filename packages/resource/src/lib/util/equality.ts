import {
  HttpHeaders,
  HttpParams,
  type HttpResourceRequest,
} from '@angular/common/http';
import { type ValueEqualityFn } from '@angular/core';
import { hash } from './hash-unknown';

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
  a: readonly (string | number | boolean)[],
  b: readonly (string | number | boolean)[],
): boolean {
  if (a.length !== b.length) return false;
  // order is significant, as in hashRequest
  return a.every((value, i) => value === b[i]);
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
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
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

function equalContext(
  a: HttpResourceRequest['context'],
  b: HttpResourceRequest['context'],
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  // tokens compare by identity: HttpContextToken has no meaningful string form
  const aTokens = Array.from(a.keys());
  if (aTokens.length !== Array.from(b.keys()).length) return false;
  return aTokens.every(
    (token) => b.has(token) && a.get(token) === b.get(token),
  );
}

const COMPARED_FIELDS = new Set<string>([
  'url',
  'method',
  'params',
  'headers',
  'body',
  'context',
  'transferCache',
]);

function equalOtherFields(
  a: Partial<HttpResourceRequest>,
  b: Partial<HttpResourceRequest>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (COMPARED_FIELDS.has(key)) continue;
    if (
      (a as Record<string, unknown>)[key] !==
      (b as Record<string, unknown>)[key]
    )
      return false;
  }
  return true;
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

    if (!equalTransferCache(a.transferCache, b.transferCache)) return false;

    return equalOtherFields(a, b);
  };
}
