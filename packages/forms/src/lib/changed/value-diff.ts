/**
 * Whether change tracking descends into `v` key by key: only plain objects (prototype
 * `Object.prototype` or `null`). Every other object (Date, Map, Set, File, class instances) is one
 * value, compared with `Object.is` or the field's `changedEqual`.
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Pure value diff with an `Object.is` short-circuit: the fallback when a node isn't tracked. */
export function valueDiff(initial: unknown, current: unknown): boolean {
  if (Object.is(initial, current)) return false;
  if (Array.isArray(current) && Array.isArray(initial)) {
    if (current.length !== initial.length) return true;
    return current.some((c, i) => valueDiff(initial[i], c));
  }
  if (isRecord(current) && isRecord(initial)) {
    const keys = Object.keys(current);
    if (keys.length !== Object.keys(initial).length) return true;
    return keys.some((k) => valueDiff(initial[k], current[k]));
  }
  return true;
}
