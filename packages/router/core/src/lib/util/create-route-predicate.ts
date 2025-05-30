function parsePathSegment(segmentString: string): {
  pathPart: string;
  matrixParams: Record<string, string>;
} {
  const parts = segmentString.split(';');
  const pathPart = parts[0];
  const matrixParams: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const [key, value = 'true'] = parts[i].split('=');
    if (key) {
      matrixParams[key] = value;
    }
  }
  return { pathPart, matrixParams };
}

function createBasePredicate(path: string): (path: string) => boolean {
  const partPredicates = path
    .split('/')
    .filter((part) => !!part.trim())
    .map((configSegmentString) => {
      const { pathPart: configPathPart, matrixParams: configMatrixParams } =
        parsePathSegment(configSegmentString);

      let singlePathPartPredicate: (linkSegmentPathPart: string) => boolean;
      if (configPathPart.startsWith(':')) {
        singlePathPartPredicate = () => true;
      } else {
        singlePathPartPredicate = (linkSegmentPathPart: string) =>
          linkSegmentPathPart === configPathPart;
      }

      const configSegmentHasMatrixParams =
        Object.keys(configMatrixParams).length > 0;

      return (linkSegmentString: string) => {
        const { pathPart: linkPathPart, matrixParams: linkMatrixParams } =
          parsePathSegment(linkSegmentString);

        if (!singlePathPartPredicate(linkPathPart)) {
          return false;
        }

        if (!configSegmentHasMatrixParams) {
          return true;
        }

        return Object.entries(configMatrixParams).every(
          ([key, value]) =>
            linkMatrixParams.hasOwnProperty(key) &&
            linkMatrixParams[key] === value,
        );
      };
    });

  return (path: string) => {
    const linkPathOnly = path.split(/[?#]/).at(0) ?? '';
    if (!linkPathOnly && partPredicates.length > 0) return false;
    if (!linkPathOnly && partPredicates.length === 0) return true;

    const parts = linkPathOnly.split('/').filter((part) => !!part.trim());
    if (parts.length < partPredicates.length) return false;

    return parts.every((seg, idx) => {
      const pred = partPredicates.at(idx);
      if (!pred) return true;
      return pred(seg);
    });
  };
}

type ParsedSegment = {
  pathPart: string;
  matrixParams: Record<string, string>;
};

function singleSegmentMatches(
  configSegment: ParsedSegment,
  linkSegment: ParsedSegment,
): boolean {
  if (configSegment.pathPart.startsWith(':')) {
  } else if (configSegment.pathPart !== linkSegment.pathPart) {
    return false;
  }

  const configMatrix = configSegment.matrixParams;
  const linkMatrix = linkSegment.matrixParams;
  for (const key in configMatrix) {
    if (
      !linkMatrix.hasOwnProperty(key) ||
      linkMatrix[key] !== configMatrix[key]
    ) {
      return false;
    }
  }
  return true;
}

function matchSegmentsRecursive(
  configSegments: ParsedSegment[],
  linkSegments: ParsedSegment[],
  configIdx: number,
  linkIdx: number,
): boolean {
  if (configIdx === configSegments.length) {
    return linkIdx === linkSegments.length;
  }

  if (linkIdx === linkSegments.length) {
    for (let i = configIdx; i < configSegments.length; i++) {
      if (configSegments[i].pathPart !== '**') {
        return false;
      }
    }
    return true;
  }

  const currentConfigSegment = configSegments[configIdx];

  if (currentConfigSegment.pathPart === '**') {
    if (
      matchSegmentsRecursive(
        configSegments,
        linkSegments,
        configIdx + 1,
        linkIdx,
      )
    ) {
      return true;
    }

    if (linkIdx < linkSegments.length) {
      if (
        matchSegmentsRecursive(
          configSegments,
          linkSegments,
          configIdx,
          linkIdx + 1,
        )
      ) {
        return true;
      }
    }

    return false;
  } else {
    if (
      linkIdx < linkSegments.length &&
      singleSegmentMatches(currentConfigSegment, linkSegments[linkIdx])
    ) {
      return matchSegmentsRecursive(
        configSegments,
        linkSegments,
        configIdx + 1,
        linkIdx + 1,
      );
    }

    return false;
  }
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

    return matchSegmentsRecursive(configSegments, linkSegments, 0, 0);
  };
}

export function createRoutePredicate(
  path: string,
): (linkPath: string) => boolean {
  return path.includes('**')
    ? createWildcardPredicate(path)
    : createBasePredicate(path);
}
