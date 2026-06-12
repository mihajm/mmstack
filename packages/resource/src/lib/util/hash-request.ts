import {
  HttpHeaders,
  HttpParams,
  type HttpRequest,
  type HttpResourceRequest,
} from '@angular/common/http';
import { isDevMode } from '@angular/core';
import { hash } from './hash-unknown';

type HashableRequest = {
  method?: string;
  url: string;
  responseType?: string;
  params?: HttpResourceRequest['params'] | HttpRequest<unknown>['params'];
  body?: unknown;
  headers?: HttpResourceRequest['headers'] | HttpRequest<unknown>['headers'];
};

/**
 * @internal
 * One-way ~64-bit digest from two independent FNV-1a passes. Used for header VALUES in
 * cache keys: keys are persisted (IndexedDB) and broadcast cross-tab, so raw values
 * (auth tokens!) must never appear in them. A single 32-bit digest's 2^-32 collision
 * chance is too thin at a security boundary — two colliding tokens would serve one
 * user's cached data under another user's key; 64 bits puts collisions out of reach.
 * High-entropy secrets are not recoverable from the digest.
 */
function digestHeaderValue(value: string): string {
  let h1 = 0x811c9dc5; // FNV-1a offset basis
  let h2 = 0xcbf29ce4; // independent second pass
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193); // FNV prime
    h2 = Math.imul(h2 ^ c, 0x01000197); // distinct odd multiplier
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  );
}

function readHeader(
  headers: HashableRequest['headers'],
  name: string,
): string | null {
  if (!headers) return null;
  if (headers instanceof HttpHeaders) {
    const all = headers.getAll(name);
    return all && all.length ? all.join(',') : null;
  }
  // record form — header names are case-insensitive
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const value = (headers as Record<string, unknown>)[key];
    if (value == null) return null;
    return Array.isArray(value) ? value.join(',') : String(value);
  }
  return null;
}

/**
 * Content-negotiation headers whose values are low-entropy and non-identifying —
 * embedded (URI-encoded) raw, keeping keys human-readable and skipping the digest.
 * Anything NOT on this list (Authorization, api keys, tenant/x-* headers — we can't
 * know what they carry) is one-way digested instead.
 */
const SAFE_RAW_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-type',
]);

const UNSAFE_HEADER_MESSAGES = new Map<string, string>([
  [
    'cookie',
    "[@mmstack/resource]: varyHeaders includes 'cookie'. Browser-attached cookies never appear on the request object (so this usually partitions nothing), and manually-set cookie values often rotate per-request (shredding the hit rate). The header IS still honored (digested) — but prefer varying on 'Authorization' or a tenant header.",
  ],
  [
    'set-cookie',
    "[@mmstack/resource]: varyHeaders includes 'set-cookie'. Browser-attached cookies never appear on the request object (so this usually partitions nothing), and manually-set cookie values often rotate per-request (shredding the hit rate). The header IS still honored (digested) — but prefer varying on 'Authorization' or a tenant header.",
  ],
  [
    'authorization',
    "[@mmstack/resource]: varyHeaders includes 'Authorization'. If your token rotates frequently (e.g., short-lived JWTs), this will cause 100% cache churn on refresh. Consider adding a namespace prefix with the users sub, not using it as a cache-key or using a custom 'cache.hash' function with a stable session/user ID instead.",
  ],
  [
    'x-request-id',
    "[@mmstack/resource]: varyHeaders includes 'X-Request-ID'. This header is often set to a unique value per-request, which will cause 100% cache churn. Consider removing it from varyHeaders or using a custom 'cache.hash' function that ignores it.",
  ],
  [
    'x-correlation-id',
    "[@mmstack/resource]: varyHeaders includes 'X-Correlation-ID'. This header is often set to a unique value per-request, which will cause 100% cache churn. Consider removing it from varyHeaders or using a custom 'cache.hash' function that ignores it.",
  ],
  [
    'if-none-match',
    "[@mmstack/resource]: varyHeaders includes 'If-None-Match'. This header contains ETags that change whenever the server's resource version changes, which will cause cache misses on every update. Consider removing it from varyHeaders or using a custom 'cache.hash' function that ignores it.",
  ],
  [
    'if-modified-since',
    "[@mmstack/resource]: varyHeaders includes 'If-Modified-Since'. This header contains timestamps that change whenever the server's resource version changes, which will cause cache misses on every update. Consider removing it from varyHeaders or using a custom 'cache.hash' function that ignores it.",
  ],
]);

function normalizeVaryHeaders(
  headers: HashableRequest['headers'],
  names: readonly string[],
): string {
  const isDev = isDevMode();
  return names
    .map((n) => n.toLowerCase())
    .toSorted()
    .map((name) => {
      if (isDev) {
        const warning = UNSAFE_HEADER_MESSAGES.get(name);
        if (warning) console.warn(warning);
      }

      const value = readHeader(headers, name);
      if (value === null) return `${name}=`;

      // known-safe values raw (readable, cheap); everything else digested, NEVER raw —
      // keys are persisted to IndexedDB and broadcast across tabs
      return SAFE_RAW_HEADERS.has(name)
        ? `${name}=${encodeURIComponent(value)}`
        : `${name}=${digestHeaderValue(value)}`;
    })
    .join('&');
}

function normalizeParams(
  params: NonNullable<HashableRequest['params']>,
): string {
  const p =
    params instanceof HttpParams
      ? params
      : new HttpParams({ fromObject: params });

  return p
    .keys()
    .toSorted()
    .map((key) => {
      const encodedKey = encodeURIComponent(key);
      return (p.getAll(key) ?? [])
        .map((v) => `${encodedKey}=${encodeURIComponent(v)}`)
        .join('&');
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
    entries.sort(
      ([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv),
    );
    return `FormData:${entries.map(([k, v]) => `${k}=${v}`).join('&')}`;
  }

  if (
    typeof URLSearchParams !== 'undefined' &&
    body instanceof URLSearchParams
  ) {
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
 * Key composition: `${method}:${url}:${responseType}[:${params}][:${body}][:${vary}]`
 * - `method` defaults to `'GET'`, `responseType` to `'json'` (Angular defaults).
 * - Query params are sorted alphabetically and URL-encoded for stability.
 * - Body hashing handles `File`/`Blob`/`FormData`/`URLSearchParams`/`ArrayBuffer`
 *   and typed arrays explicitly; everything else flows through key-sorted
 *   `JSON.stringify` via `hash()`.
 * - `varyHeaders` (opt-in) mixes the named request headers into the key so responses
 *   that differ per header (e.g. `Authorization` → per-user, `Accept-Language`) get
 *   separate entries. Known-safe content-negotiation headers (`Accept`,
 *   `Accept-Language`, `Content-Language`, `Content-Type`) embed their value raw for
 *   readable keys; all other header VALUES are one-way digested, never embedded raw —
 *   keys are persisted to IndexedDB and broadcast across tabs.
 */
export function hashRequest(
  req: HashableRequest,
  varyHeaders?: readonly string[],
): string {
  const method = req.method ?? 'GET';
  const responseType = req.responseType ?? 'json';
  const base = `${method}:${req.url}:${responseType}`;

  const params = req.params ? `:${normalizeParams(req.params)}` : '';
  const body = req.body != null ? `:${hashBody(req.body)}` : '';
  const vary = varyHeaders?.length
    ? `:vary(${normalizeVaryHeaders(req.headers, varyHeaders)})`
    : '';

  return base + params + body + vary;
}
