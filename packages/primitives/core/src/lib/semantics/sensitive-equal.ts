import { unbox } from './sensitive';
import { hasLabel, SENSITIVE } from './sensitive-registry';
import {
  isPlainArray,
  isPlainRecord,
  openWalk,
  walkSensitive,
} from './sensitive-walk';

/** Boxes unwrapped deep, labeled sentinels as their plain sentinel, edge views as their raw value. */
function canonical(a: unknown, b: unknown): [unknown, unknown] {
  const walk = openWalk((v) => {
    if (SENSITIVE.inner.has(v)) return { into: SENSITIVE.inner.get(v) };
    if (SENSITIVE.canonical.has(v)) return { to: SENSITIVE.canonical.get(v) };
    return SENSITIVE.plain.has(v) ? { to: SENSITIVE.plain.get(v) } : undefined;
  }, true);
  return [walkSensitive(a, walk), walkSensitive(b, walk)];
}

/** Own enumerable data entries of an array or a plain record (accessors are never run). */
function entries(value: unknown): Map<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!isPlainArray(value) && !isPlainRecord(value)) return undefined;
  const out = new Map<string, unknown>();
  for (const key of Object.keys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d && 'value' in d) out.set(key, d.value);
  }
  return out;
}

/** Whether a label sits anywhere in `value` (cycle-safe). */
function anyLabel(value: unknown, seen: Set<object>): boolean {
  if (hasLabel(value)) return true;
  const inner = unbox(value);
  const kids = entries(inner);
  if (!kids || seen.has(inner as object)) return false;
  seen.add(inner as object);
  for (const kid of kids.values()) if (anyLabel(kid, seen)) return true;
  return false;
}

/**
 * Labels at the same positions, through arrays and plain records. Only a label differing makes the
 * trees differ: a position present on one side only, or a differing shape, counts only when a label
 * sits there; otherwise the base equality decides.
 */
function sameLabelTree(
  a: unknown,
  b: unknown,
  seen: Map<object, Set<object>>,
): boolean {
  if (hasLabel(a) !== hasLabel(b)) return false;
  const x = unbox(a);
  const y = unbox(b);
  if (x === y) return true;
  const kx = entries(x);
  const ky = entries(y);
  if (!kx || !ky || Array.isArray(x) !== Array.isArray(y))
    return !anyLabel(x, new Set()) && !anyLabel(y, new Set());
  // Visited PAIRS: a left object may meet several right partners in a cycle.
  const partners = seen.get(x as object) ?? new Set<object>();
  if (partners.has(y as object)) return true;
  partners.add(y as object);
  seen.set(x as object, partners);
  for (const key of new Set([...kx.keys(), ...ky.keys()]))
    if (!sameLabelTree(kx.get(key), ky.get(key), seen)) return false;
  return true;
}

/**
 * Wraps an equality for values that may hold sensitive boxes. While the mode is off this returns
 * `base` itself. While it is on, two values are equal when `base` finds their canonical forms equal
 * (boxes unwrapped deep through one memo per check, labeled absorbers as their plain absorber, edge
 * views as their raw value) and their labels sit at the same positions: a box and an equal plain
 * value differ, two boxes of equal values do not. The mode is read when the wrapper is built.
 */
export function sensitiveEqual<T>(
  base: (a: T, b: T) => boolean,
): (a: T, b: T) => boolean {
  if (!SENSITIVE.policy.mode) return base;
  return (a, b) => {
    const [ca, cb] = canonical(a, b);
    return (
      base(ca as T, cb as T) &&
      sameLabelTree(a, b, new Map<object, Set<object>>())
    );
  };
}
