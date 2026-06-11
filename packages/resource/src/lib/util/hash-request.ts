import { HttpParams, type HttpRequest, type HttpResourceRequest } from '@angular/common/http';
import { hash } from './hash-unknown';

type HashableRequest = {
  method?: string;
  url: string;
  responseType?: string;
  params?: HttpResourceRequest['params'] | HttpRequest<unknown>['params'];
  body?: unknown;
};

function normalizeParams(params: NonNullable<HashableRequest['params']>): string {
  const p = params instanceof HttpParams ? params : new HttpParams({ fromObject: params });

  return p
    .keys()
    .toSorted()
    .map((key) => {
      const encodedKey = encodeURIComponent(key);
      return (p.getAll(key) ?? []).map((v) => `${encodedKey}=${encodeURIComponent(v)}`).join('&');
    })
    .join('&');
}

function hashBody(body: unknown): string {
  // File extends Blob — must check File first
  if (typeof File !== 'undefined' && body instanceof File) {
    return `File:${body.name}:${body.type}:${body.size}:${body.lastModified}`;
  }

  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return `Blob:${body.type}:${body.size}`;
  }

  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const entries: [string, string][] = [];
    body.forEach((value, key) => {
      entries.push([key, hashBody(value)]);
    });
    entries.sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
    return `FormData:${entries.map(([k, v]) => `${k}=${v}`).join('&')}`;
  }

  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    const sp = new URLSearchParams(body);
    sp.sort();
    return `URLSearchParams:${sp.toString()}`;
  }

  if (body instanceof ArrayBuffer) {
    return `ArrayBuffer:${body.byteLength}`;
  }

  if (ArrayBuffer.isView(body)) {
    return `${body.constructor.name}:${body.byteLength}`;
  }

  return hash(body);
}

/**
 * Builds a stable cache/dedupe key from an HTTP request shape (accepts both
 * `HttpRequest` and `HttpResourceRequest`).
 *
 * Key composition: `${method}:${url}:${responseType}[:${params}][:${body}]`
 * - `method` defaults to `'GET'`, `responseType` to `'json'` (Angular defaults).
 * - Query params are sorted alphabetically and URL-encoded for stability.
 * - Body hashing handles `File`/`Blob`/`FormData`/`URLSearchParams`/`ArrayBuffer`
 *   and typed arrays explicitly; everything else flows through key-sorted
 *   `JSON.stringify` via `hash()`.
 */
export function hashRequest(req: HashableRequest): string {
  const method = req.method ?? 'GET';
  const responseType = req.responseType ?? 'json';
  const base = `${method}:${req.url}:${responseType}`;

  const params = req.params ? `:${normalizeParams(req.params)}` : '';
  const body = req.body != null ? `:${hashBody(req.body)}` : '';

  return base + params + body;
}
