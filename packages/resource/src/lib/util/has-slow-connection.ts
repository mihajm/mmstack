/**
 * Whether the browser reports a slow or data-saving connection (`saveData`, or an
 * `effectiveType` ending in `2g`). Always `false` where there is no `window` (SSR) or
 * no Network Information API.
 */
export function hasSlowConnection() {
  if (typeof window === 'undefined') return false;
  const connection = (
    window.navigator as Navigator & {
      connection?: { effectiveType?: unknown; saveData?: unknown };
    }
  )?.connection;
  if (typeof connection !== 'object' || !connection) return false;
  if (connection.saveData === true) return true;
  return (
    typeof connection.effectiveType === 'string' &&
    connection.effectiveType.endsWith('2g')
  );
}
