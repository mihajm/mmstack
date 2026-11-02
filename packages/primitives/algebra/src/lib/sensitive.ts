import {
  alwaysSensitive,
  runSensitiveRegion,
  sensitive,
  ɵopenSensitiveWalk,
  type ɵSensitiveWalk,
  ɵwalkSensitive,
} from '@mmstack/primitives/core';

/** The fields of the realm's sensitive registry the hooks read (minted by the core entry). */
interface SensitiveRegistryView {
  readonly protocol: number;
  readonly inner: WeakMap<object, unknown>;
  readonly labels: WeakSet<object>;
  readonly plain: WeakMap<object, object>;
  readonly canonical: WeakMap<object, unknown>;
  readonly always: WeakSet<object>;
  readonly policy: { readonly mode: boolean };
  readonly counters: { registered: number; alwaysRegion: number };
}

const SENSITIVE_PROTOCOL = 2;

function readRegistry(): SensitiveRegistryView {
  const slot = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('@mmstack/primitives.sensitive')
  ] as Partial<SensitiveRegistryView> | undefined;
  if (
    !slot ||
    slot.protocol !== SENSITIVE_PROTOCOL ||
    !(slot.labels instanceof WeakSet) ||
    !(slot.always instanceof WeakSet) ||
    !(slot.inner instanceof WeakMap)
  ) {
    throw new TypeError(
      '[mmstack] the sensitive registry is missing or speaks another protocol',
    );
  }
  return slot as SensitiveRegistryView;
}

const REGISTRY = readRegistry();

/** @internal The shared policy record: every hook reads `.mode` first. */
export const SENSITIVE_POLICY = REGISTRY.policy;

const weakSetHas = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>,
  value: object,
) => boolean;

/**
 * Hook-internal: whether boxing is on and `value` carries the label (a sensitive box, a labeled
 * pending or error, or an object thrown under a labeled call).
 */
export function isLabeled(value: unknown): boolean {
  return (
    SENSITIVE_POLICY.mode &&
    typeof value === 'object' &&
    value !== null &&
    weakSetHas(REGISTRY.labels, value)
  );
}

/**
 * Hook-internal: the value a hook operates on. A box gives its inner value (the real object, not a
 * copy), a labeled pending or error gives its plain absorber, anything else is returned as is.
 * Not a reader operation: the result is meant to be labeled again by the hook.
 */
export function unlabel(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (REGISTRY.inner.has(value)) return REGISTRY.inner.get(value);
  return REGISTRY.plain.get(value) ?? value;
}

/**
 * @internal How labeled a value is: 0 plain, 1 labeled, 2 always sensitive (labeled, and every
 * result it reaches is always sensitive too). Hooks join levels by maximum.
 */
export type Level = 0 | 1 | 2;

/** @internal The level of `value` itself (no look inside). */
export function levelOf(value: unknown): Level {
  if (!isLabeled(value)) return 0;
  return weakSetHas(REGISTRY.always, value as object) ? 2 : 1;
}

/**
 * Hook-internal: whether boxing is on and `value` itself is an always-sensitive label (one level, the
 * reach of {@link isLabeled}). An interpreter that labels a result of its own over labeled operands
 * labels it with `alwaysSensitive` when any of them answers true here, so the class propagates
 * through its own sites as it does through the hooks.
 */
export function isAlwaysLabeled(value: unknown): boolean {
  return levelOf(value) === 2;
}

/** @internal The join of two levels. */
export const raise = (a: Level, b: Level): Level => (a > b ? a : b);

/** @internal The join of `of` over every value (no short circuit below the top level). */
export function maxLevel(
  values: readonly unknown[],
  of: (value: unknown) => Level,
): Level {
  let level: Level = 0;
  for (const value of values) {
    level = raise(level, of(value));
    if (level === 2) return 2;
  }
  return level;
}

/**
 * @internal Labels a hook result at `level`: as it is at 0, a box for a value or the twin for an
 * absorber at 1, the always-sensitive box or twin at 2. Never lowers a label already there.
 */
export function labelAt(level: Level, value: unknown): unknown {
  if (level === 0) return value;
  return level === 2 ? alwaysSensitive(value) : sensitive(value);
}

/** The values an array holds in own data properties (an accessor index is never run). */
function arrayData(value: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, i);
    if (d && 'value' in d) out.push(d.value);
  }
  return out;
}

const isPlainArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;

/**
 * @internal The level at the top or inside nested arrays (the depth native coercion reads): nonzero
 * exactly when a label sits there. Below a label it also looks inside boxes, through arrays, for an
 * always-sensitive one, since canonicalizing reads the box's inner value at that depth.
 */
export function levelInArrays(value: unknown): Level {
  let level: Level = 0;
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    const own = levelOf(node);
    if (own === 2) return 2;
    if (own === 1) level = 1;
    const inner = own ? REGISTRY.inner.get(node) : node;
    // Plain arrays only: an array subclass is a class instance, not descended.
    if (isPlainArray(inner)) stack.push(...arrayData(inner));
  }
  return level;
}

/**
 * @internal Marks an object thrown under a labeled call as labeled (always sensitive at level 2), so
 * its mint is labeled (and always sensitive).
 */
export function markThrown(thrown: unknown, level: Level): void {
  if (typeof thrown !== 'object' || thrown === null) return;
  REGISTRY.labels.add(thrown);
  REGISTRY.counters.registered++;
  if (level === 2) {
    REGISTRY.always.add(thrown);
    REGISTRY.counters.registered++;
  }
}

/**
 * Marks a thrown object as labeled, so an error minted over it later is labeled, the way an object
 * thrown under a labeled call is. Mode off, a primitive, or an object already labeled: nothing.
 */
export function markLabeled(thrown: unknown): void {
  if (
    !SENSITIVE_POLICY.mode ||
    typeof thrown !== 'object' ||
    thrown === null ||
    weakSetHas(REGISTRY.labels, thrown)
  )
    return;
  markThrown(thrown, 1);
}

/** @internal Runs `fn` and marks what it throws as labeled at `level`. */
export function markingThrows<T>(fn: () => T, level: Level): T {
  try {
    return fn();
  } catch (thrown) {
    markThrown(thrown, level);
    throw thrown;
  }
}

/**
 * @internal Runs `fn` as a labeled region (mints inside it are labeled; at level 2 also always
 * sensitive) and marks what it throws at `level`.
 */
export function underLabel<T>(fn: () => T, level: Level): T {
  if (level === 2) REGISTRY.counters.alwaysRegion++;
  try {
    return runSensitiveRegion(fn);
  } catch (thrown) {
    markThrown(thrown, level);
    throw thrown;
  } finally {
    if (level === 2) REGISTRY.counters.alwaysRegion--;
  }
}

/**
 * @internal One alias-preserving unwrap over the core walk: one canonical value per original across
 * every value unwrapped with it, `level` records the highest label crossed (0: none).
 */
export interface Unwrap {
  walk?: ɵSensitiveWalk;
  level: Level;
}

export function openUnwrap(): Unwrap {
  return { level: 0 };
}

/**
 * @internal The canonical form of `value` for one unwrap: boxes replaced by their inner value (the
 * real inner when it holds no label), labeled sentinels by their plain sentinel, edge views by their
 * raw value; arrays (and plain records when `objects`) copied only where something below changed,
 * by own enumerable data properties (accessors kept, never run), cycles and prototypes kept.
 */
export function canonicalize(
  value: unknown,
  unwrap: Unwrap,
  objects: boolean,
): unknown {
  unwrap.walk ??= ɵopenSensitiveWalk(
    (v) => {
      if (REGISTRY.inner.has(v)) return { into: REGISTRY.inner.get(v) };
      if (REGISTRY.plain.has(v)) return { to: REGISTRY.plain.get(v) };
      // A view stands for its raw value; its fields are still visited for labels.
      if (REGISTRY.canonical.has(v))
        return { to: REGISTRY.canonical.get(v), scan: true };
      return undefined;
    },
    objects,
    {
      visit: (v) => {
        if (weakSetHas(REGISTRY.labels, v))
          unwrap.level = weakSetHas(REGISTRY.always, v)
            ? 2
            : raise(unwrap.level, 1);
      },
    },
  );
  return ɵwalkSensitive(value, unwrap.walk);
}

/** @internal A result that is a canonical value of this unwrap maps back to its original. */
export function mapBack(result: unknown, unwrap: Unwrap): unknown {
  if (typeof result !== 'object' || result === null || !unwrap.walk)
    return result;
  for (const [original, copy] of unwrap.walk.copies)
    if (copy === result && original !== result) return original;
  return result;
}
