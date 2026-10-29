import { isStore } from '../store/internals';
import { isSentinel } from './sentinel';

/**
 * What a walk does with one object: `{ to }` replaces it with a value as is, `{ into }` replaces it
 * with the walk of another value (a box with its inner value), `undefined` descends it. `scan` on a
 * `to` answer still visits what the object holds (its replacement is not descended).
 */
export type WalkStep =
  | { readonly to: unknown; readonly scan?: boolean }
  | { readonly into: unknown }
  | undefined;

/**
 * @internal One walk over a value graph. `copies` maps each original to its result and keeps
 * aliases across several roots walked with the same state; `visit` sees every reached object once;
 * `copied` sees each container copy beside its original.
 */
export interface SensitiveWalk {
  readonly step: (value: object) => WalkStep;
  /** Descend plain records as well as arrays. */
  readonly records: boolean;
  readonly visit?: (value: object) => void;
  readonly copied?: (copy: object, original: object) => void;
  readonly copies: Map<object, unknown>;
  readonly steps: Map<object, WalkStep>;
  readonly dirty: Map<object, boolean>;
}

export function openWalk(
  step: SensitiveWalk['step'],
  records: boolean,
  hooks: Pick<SensitiveWalk, 'visit' | 'copied'> = {},
): SensitiveWalk {
  return {
    step,
    records,
    ...hooks,
    copies: new Map(),
    steps: new Map(),
    dirty: new Map(),
  };
}

/** A plain record: not a sentinel, store, box or class instance. */
export function isPlainRecord(value: object): boolean {
  if (isSentinel(value) || isStore(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A plain `Array`, checked by prototype: an array subclass is a class instance, never descended and
 * handed on as it is.
 */
export function isPlainArray(value: object): value is unknown[] {
  return (
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  );
}

/** The keys a walk descends: plain array indexes, or the own enumerable string keys of a plain record. */
function walkKeys(value: object, records: boolean): string[] | undefined {
  if (isPlainArray(value))
    return Array.from({ length: value.length }, (_, i) => String(i));
  if (Array.isArray(value)) return undefined;
  return records && isPlainRecord(value) ? Object.keys(value) : undefined;
}

/** The values a walk descends into: own data properties only (an accessor is never run). */
function dataChildren(value: object, records: boolean): unknown[] {
  const out: unknown[] = [];
  for (const key of walkKeys(value, records) ?? []) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d && 'value' in d) out.push(d.value);
  }
  return out;
}

/** Visits everything reachable from `root` once and marks containers that must be copied. */
function analyze(root: unknown, walk: SensitiveWalk): void {
  if (typeof root !== 'object' || root === null || walk.dirty.has(root)) return;
  const nodes: object[] = [];
  const edges = new Map<object, object[]>();
  const stack: object[] = [root];
  walk.dirty.set(root, false);
  while (stack.length) {
    const node = stack.pop() as object;
    nodes.push(node);
    walk.visit?.(node);
    const step = walk.step(node);
    walk.steps.set(node, step);
    const children =
      step === undefined
        ? dataChildren(node, walk.records)
        : 'into' in step
          ? [step.into]
          : step.scan
            ? dataChildren(node, true)
            : [];
    const targets: object[] = [];
    for (const child of children) {
      if (typeof child !== 'object' || child === null) continue;
      if (step === undefined || 'into' in step) targets.push(child);
      if (!walk.dirty.has(child)) {
        walk.dirty.set(child, false);
        stack.push(child);
      }
    }
    edges.set(node, targets);
  }
  for (const node of nodes)
    if (walk.steps.get(node) !== undefined) walk.dirty.set(node, true);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (walk.dirty.get(node)) continue;
      if ((edges.get(node) ?? []).some((t) => walk.dirty.get(t))) {
        walk.dirty.set(node, true);
        changed = true;
      }
    }
  }
}

function build(value: unknown, walk: SensitiveWalk): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (walk.copies.has(value)) return walk.copies.get(value);
  const step = walk.steps.get(value);
  if (step !== undefined) {
    const out = 'into' in step ? build(step.into, walk) : step.to;
    walk.copies.set(value, out);
    return out;
  }
  const keys = walk.dirty.get(value)
    ? walkKeys(value, walk.records)
    : undefined;
  if (!keys) {
    walk.copies.set(value, value);
    return value;
  }
  // Register the copy before filling it, so a cycle through it points at the copy.
  const copy: Record<string, unknown> = isPlainArray(value)
    ? (new Array(value.length) as never)
    : Object.create(Object.getPrototypeOf(value));
  walk.copies.set(value, copy);
  walk.copied?.(copy, value);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d) continue;
    // Defined, never assigned: an own `__proto__` key stays an own key and the prototype is untouched.
    if ('value' in d)
      Object.defineProperty(copy, key, { ...d, value: build(d.value, walk) });
    else Object.defineProperty(copy, key, d);
  }
  return copy;
}

/**
 * @internal The one walk every sensitive traversal uses: through arrays (and plain records when
 * `records`) by own enumerable data properties only, so accessors are never run and are copied as
 * accessors; stores, sentinels and class instances are not descended; cycle-safe. A container is
 * copied only when something below it is replaced, its copy is registered before it is filled (so
 * aliases and cycles survive), and it keeps its prototype (null included).
 */
export function walkSensitive(value: unknown, walk: SensitiveWalk): unknown {
  analyze(value, walk);
  return build(value, walk);
}
