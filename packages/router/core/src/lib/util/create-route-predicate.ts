type ParsedSegment = {
  pathPart: string;
  matrixParams: Record<string, string>;
};

function parsePathSegment(segmentString: string): ParsedSegment {
  const parts = segmentString.split(';');
  const pathPart = parts[0];
  const matrixParams: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    // split ONCE — matrix values may themselves contain '=' (e.g. base64 payloads)
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    if (key) {
      matrixParams[key] = eq === -1 ? 'true' : part.slice(eq + 1);
    }
  }
  return { pathPart, matrixParams };
}

function singleSegmentMatches(
  configSegment: ParsedSegment,
  linkSegment: ParsedSegment,
): boolean {
  // ':id' style params match any path part — but matrix params (below) still apply
  if (
    !configSegment.pathPart.startsWith(':') &&
    configSegment.pathPart !== linkSegment.pathPart
  ) {
    return false;
  }

  const configMatrix = configSegment.matrixParams;
  const linkMatrix = linkSegment.matrixParams;
  for (const key in configMatrix) {
    if (
      !Object.prototype.hasOwnProperty.call(linkMatrix, key) ||
      linkMatrix[key] !== configMatrix[key]
    ) {
      return false;
    }
  }
  return true;
}

function createBasePredicate(path: string): (path: string) => boolean {
  const configSegments = path
    .split('/')
    .filter((part) => !!part.trim())
    .map((segment) => parsePathSegment(segment));

  return (path: string) => {
    const linkPathOnly = path.split(/[?#]/).at(0) ?? '';
    if (!linkPathOnly && configSegments.length > 0) return false;
    if (!linkPathOnly && configSegments.length === 0) return true;

    const parts = linkPathOnly.split('/').filter((part) => !!part.trim());
    if (parts.length < configSegments.length) return false;

    // prefix match: every config segment must match; extra link segments are fine
    return configSegments.every((configSegment, idx) =>
      singleSegmentMatches(configSegment, parsePathSegment(parts[idx])),
    );
  };
}

function matchSegmentsRecursive(
  configSegments: ParsedSegment[],
  linkSegments: ParsedSegment[],
  configIdx: number,
  linkIdx: number,
  // memo over (configIdx, linkIdx) — without it, paths with several '**' segments
  // backtrack exponentially
  memo: Map<number, boolean>,
): boolean {
  // prefix match: config exhausted → matched, regardless of remaining link segments
  // (same semantics as the non-wildcard predicate)
  if (configIdx === configSegments.length) {
    return true;
  }

  const memoKey = configIdx * (linkSegments.length + 1) + linkIdx;
  const cached = memo.get(memoKey);
  if (cached !== undefined) return cached;

  let result: boolean;

  if (linkIdx === linkSegments.length) {
    // link exhausted — only matches if all remaining config segments are '**'
    result = configSegments
      .slice(configIdx)
      .every((s) => s.pathPart === '**');
  } else if (configSegments[configIdx].pathPart === '**') {
    // '**' matches zero segments (advance config) or one-or-more (advance link)
    result =
      matchSegmentsRecursive(
        configSegments,
        linkSegments,
        configIdx + 1,
        linkIdx,
        memo,
      ) ||
      matchSegmentsRecursive(
        configSegments,
        linkSegments,
        configIdx,
        linkIdx + 1,
        memo,
      );
  } else {
    result =
      singleSegmentMatches(configSegments[configIdx], linkSegments[linkIdx]) &&
      matchSegmentsRecursive(
        configSegments,
        linkSegments,
        configIdx + 1,
        linkIdx + 1,
        memo,
      );
  }

  memo.set(memoKey, result);
  return result;
}

function createWildcardPredicate(path: string): (linkPath: string) => boolean {
  const configSegments = path
    .split('/')
    .filter((p) => !!p.trim())
    .map((segment) => parsePathSegment(segment));

  return (linkPath: string): boolean => {
    const linkPathOnly = linkPath.split(/[?#]/).at(0) ?? '';
    const linkSegments = linkPathOnly
      .split('/')
      .filter((p) => !!p.trim())
      .map((segment) => parsePathSegment(segment));

    return matchSegmentsRecursive(
      configSegments,
      linkSegments,
      0,
      0,
      new Map(),
    );
  };
}

/**
 * @internal
 * Builds a predicate deciding whether a requested link path belongs to a route
 * config path (used by {@link PreloadStrategy} to match preload requests against
 * registered lazy routes).
 *
 * Semantics (intentionally simple, mirrors what link hrefs look like):
 * - **prefix matching** — `users/:id` matches `/users/42/orders`
 * - `:param` segments match any single path part
 * - `**` matches any number of path parts (including zero)
 * - matrix params in the config path must be present with equal values in the
 *   link path (`items;sort=asc` requires `;sort=asc` on that segment)
 * - query strings / fragments on the link are ignored
 *
 * Not supported: auxiliary outlet syntax (`(name:path)`) — such links simply
 * won't match.
 */
export function createRoutePredicate(
  path: string,
): (linkPath: string) => boolean {
  return path.includes('**')
    ? createWildcardPredicate(path)
    : createBasePredicate(path);
}
