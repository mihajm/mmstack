import {
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
  readonly policy: { readonly mode: boolean };
  readonly counters: { registered: number };
}

const SENSITIVE_PROTOCOL = 1;

function readRegistry(): SensitiveRegistryView {
  const slot = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('@mmstack/primitives.sensitive')
  ] as Partial<SensitiveRegistryView> | undefined;
  if (
    !slot ||
    slot.protocol !== SENSITIVE_PROTOCOL ||
    !(slot.labels instanceof WeakSet) ||
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

/** @internal Labels a hook result: a box for a value, the twin for an absorber. */
export const label = sensitive;

/** The values an array holds in own data properties (an accessor index is never run). */
function arrayData(value: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, i);
    if (d && 'value' in d) out.push(d.value);
  }
  return out;
}

/** @internal Labeled at the top or inside nested arrays (the depth native coercion reads). */
export function labeledInArrays(value: unknown): boolean {
  if (isLabeled(value)) return true;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return false;
  const seen = new Set<object>([value]);
  const stack: unknown[] = [value];
  while (stack.length) {
    const items = arrayData(stack.pop() as unknown[]);
    for (const item of items) {
      if (isLabeled(item)) return true;
      // Plain arrays only: an array subclass is a class instance, not descended.
      if (
        Array.isArray(item) &&
        Object.getPrototypeOf(item) === Array.prototype &&
        !seen.has(item)
      ) {
        seen.add(item);
        stack.push(item);
      }
    }
  }
  return false;
}

/** @internal Marks an object thrown under a labeled call as labeled, so its mint is labeled. */
export function markThrown(thrown: unknown): void {
  if (typeof thrown !== 'object' || thrown === null) return;
  REGISTRY.labels.add(thrown);
  REGISTRY.counters.registered++;
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
  markThrown(thrown);
}

/** @internal Runs `fn` and marks what it throws as labeled. */
export function markingThrows<T>(fn: () => T): T {
  try {
    return fn();
  } catch (thrown) {
    markThrown(thrown);
    throw thrown;
  }
}

/**
 * @internal Runs `fn` as a labeled region (mints inside it are labeled) and marks what it throws.
 */
export function underLabel<T>(fn: () => T): T {
  try {
    return runSensitiveRegion(fn);
  } catch (thrown) {
    markThrown(thrown);
    throw thrown;
  }
}

/**
 * @internal One alias-preserving unwrap over the core walk: one canonical value per original across
 * every value unwrapped with it, `found` records whether any label was crossed.
 */
export interface Unwrap {
  walk?: ɵSensitiveWalk;
  found: boolean;
}

export function openUnwrap(): Unwrap {
  return { found: false };
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
        if (weakSetHas(REGISTRY.labels, v)) unwrap.found = true;
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
