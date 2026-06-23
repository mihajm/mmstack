/**
 * Given a route config path pattern (e.g. `/users/:id`) and a concrete serialized link
 * (e.g. `/users/42/orders?tab=open`), extract the `:param` values by segment position and
 * parse the query string. Returns `null` if the link doesn't match the pattern.
 *
 * Prefix-matches like the preload predicate: extra link segments beyond the pattern are
 * allowed (a child route's link still matches its parent's pattern). Matrix params are
 * stripped from segments. Used by the prefetch path, where there is no `ActivatedRoute` —
 * params must come from the hovered URL.
 */
export function extractRouteParams(
  configPath: string,
  linkPath: string,
): { params: Record<string, string>; query: Record<string, string> } | null {
  const [rawPath, rawQuery] = linkPath.split('#')[0].split('?');

  const configSegs = configPath.split('/').filter((s) => s.trim());
  const linkSegs = rawPath.split('/').filter((s) => s.trim());
  if (linkSegs.length < configSegs.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < configSegs.length; i++) {
    const configSeg = configSegs[i].split(';')[0]; // strip matrix params
    const linkSeg = linkSegs[i].split(';')[0];
    if (configSeg.startsWith(':')) {
      params[configSeg.slice(1)] = safeDecode(linkSeg);
    } else if (configSeg !== '**' && configSeg !== linkSeg) {
      return null;
    } else if (configSeg === '**') {
      break; // wildcard swallows the rest
    }
  }

  const query: Record<string, string> = {};
  if (rawQuery) {
    new URLSearchParams(rawQuery).forEach((value, key) => {
      query[key] = value;
    });
  }

  return { params, query };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
