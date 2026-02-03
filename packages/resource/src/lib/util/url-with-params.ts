import { HttpParams, type HttpResourceRequest } from '@angular/common/http';

function normalizeParams(
  params: Required<HttpResourceRequest>['params'],
): string {
  if (params instanceof HttpParams) return params.toString();

  const paramMap = new Map<string, string>();

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      paramMap.set(key, value.map(encodeURIComponent).join(','));
    } else {
      paramMap.set(key, encodeURIComponent(value.toString()));
    }
  }

  return Array.from(paramMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export function urlWithParams(req: HttpResourceRequest): string {
  if (!req.params) return req.url;

  return `${req.url}?${normalizeParams(req.params)}`;
}
