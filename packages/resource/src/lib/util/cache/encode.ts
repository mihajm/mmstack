import { HttpHeaders, HttpResponse } from '@angular/common/http';
import { isDevMode } from '@angular/core';

export type SerializedResponse = {
  body: unknown;
  status: number;
  headers: Record<string, string[]> | undefined;
  url: string | null;
};

export const serialize = (value: HttpResponse<unknown>): SerializedResponse => {
  const headersRecord: Record<string, string[]> = {};

  const headerKeys = value.headers.keys();
  headerKeys.forEach((key) => {
    const values = value.headers.getAll(key);
    if (!values) return;
    headersRecord[key] = values;
  });

  return {
    body: value.body,
    status: value.status,
    headers: headerKeys.length > 0 ? headersRecord : undefined,
    url: value.url,
  };
};

export const deserialize = (parsed: any): HttpResponse<unknown> | null => {
  try {
    if (!parsed || typeof parsed !== 'object' || !('body' in parsed))
      throw new Error('Invalid cache entry format');

    const headers = parsed.headers
      ? new HttpHeaders(parsed.headers)
      : undefined;

    return new HttpResponse({
      body: parsed.body,
      status: parsed.status,
      headers: headers,
      url: parsed.url ?? undefined, // HttpResponse constructor requires string or undefined, url is string | null
    });
  } catch (err) {
    if (isDevMode()) console.error('Failed to deserialize cache entry:', err);
    return null;
  }
};
