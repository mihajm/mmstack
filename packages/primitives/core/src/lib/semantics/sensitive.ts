import { openWalk, walkSensitive } from './sensitive-walk';
import {
  isSentinel,
  isStrictSentinels,
  labeledTwin,
  reportError,
} from './sentinel';
import {
  addLabel,
  PLACEHOLDER_MARKER,
  SENSITIVE,
  type SensitivePolicy,
} from './sensitive-registry';

const POLICY = SENSITIVE.policy;
const COUNTERS = SENSITIVE.counters;

export class SensitiveLeakError extends TypeError {
  constructor(boundary: string) {
    super(`[mmstack] sensitive value leaked to a ${boundary} boundary`);
    this.name = 'SensitiveLeakError';
  }
}

type LeakBoundary =
  'primitive-coercion' | 'string-coercion' | 'serialization' | 'inspection';

const leakReported = new WeakSet<object>();

/** Strict: throw. Soft: report the first coercion of this box, then let the caller answer. */
function coerced(box: object, boundary: LeakBoundary): void {
  if (isStrictSentinels() || !SENSITIVE.inner.has(box))
    throw new SensitiveLeakError(boundary);
  if (leakReported.has(box)) return;
  leakReported.add(box);
  reportError({
    origin: 'leak',
    subclass: 'author-fault',
    cause: new SensitiveLeakError(boundary),
    sensitive: true,
  });
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A sensitive value. Instances are frozen and have no own properties (the value lives in the
 * registry's side table), so every box shares one shape. Every coercion and inspection protocol is
 * guarded: strict sentinels throw `SensitiveLeakError`, soft ones report once and answer the
 * placeholder.
 */
class SensitiveBox {
  constructor() {
    Object.freeze(this);
  }
  [Symbol.toPrimitive](hint: string): string | number {
    coerced(this, 'primitive-coercion');
    return hint === 'number' ? NaN : POLICY.placeholder;
  }
  valueOf(): string {
    coerced(this, 'primitive-coercion');
    return POLICY.placeholder;
  }
  toString(): string {
    coerced(this, 'string-coercion');
    return POLICY.placeholder;
  }
  toJSON(): { readonly $sensitive: true } {
    coerced(this, 'serialization');
    return { $sensitive: true };
  }
  [INSPECT](): string {
    coerced(this, 'inspection');
    return POLICY.placeholder;
  }
  get [Symbol.toStringTag](): string {
    return 'Sensitive';
  }
}
Object.freeze(SensitiveBox.prototype);
Object.freeze(SensitiveBox);

function mintBox(inner: unknown): object {
  const box = new SensitiveBox();
  SENSITIVE.inner.set(box, inner);
  addLabel(box);
  return box;
}

/** Whether `value` is a sensitive box (whatever the mode). */
export function isSensitive(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && SENSITIVE.inner.has(value)
  );
}

/**
 * Declares a value sensitive. While the mode is off this is the identity and registers nothing.
 * While it is on: a box is itself, a sentinel (pending, error, done) is its labeled twin (it still
 * absorbs, ranks and settles as its kind; a sentinel is never boxed), an object gets its one box (boxing the same object twice gives the same
 * box), and any other value gets a fresh box. Nested boxes are kept.
 */
export function sensitive(value: unknown): unknown {
  if (!POLICY.mode) return value;
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'function' ? boxObject(value) : mintBox(value);
  }
  if (SENSITIVE.inner.has(value)) return value;
  if (isSentinel(value)) return labeledTwin(value);
  return boxObject(value);
}

function boxObject(value: object): object {
  const known = SENSITIVE.objectBox.get(value);
  if (known) return known;
  const box = mintBox(value);
  SENSITIVE.objectBox.set(value, box);
  return box;
}

/**
 * A reader operation: the value inside a box (the plain absorber for a labeled one), anything else
 * as is. One level only. Reading through a box is how a value leaves the sensitive plane, so a
 * consumer should restrict which modules may import this.
 */
export function unbox(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (SENSITIVE.inner.has(value)) return SENSITIVE.inner.get(value);
  return SENSITIVE.plain.get(value) ?? value;
}

/**
 * Records the raw value an edge minted a per-field view from (an object whose fields are boxes),
 * so equality treats the view as that raw value. Mode off: nothing is recorded.
 */
export function registerCanonical<T extends object>(view: T, raw: unknown): T {
  if (!POLICY.mode) return view;
  SENSITIVE.canonical.set(view, raw);
  COUNTERS.registered++;
  return view;
}

/** Turns boxing on or off for every copy of `@mmstack/primitives` sharing the registry. */
export function setSensitiveMode(on: boolean): void {
  POLICY.mode = on;
}

export function isSensitiveMode(): boolean {
  return POLICY.mode;
}

/**
 * Sets what a soft coercion of a box answers (`placeholder`, `[mmstack sensitive]` by default) and
 * what `redact` substitutes for a labeled value (`marker`, the placeholder by default). Omitted
 * fields keep their value.
 */
export function setSensitivePolicy(
  policy: Partial<Pick<SensitivePolicy, 'placeholder' | 'marker'>>,
): void {
  if (policy.placeholder !== undefined) POLICY.placeholder = policy.placeholder;
  if ('marker' in policy) POLICY.marker = policy.marker;
}

/**
 * Runs `fn` as a labeled region: every error minted inside it is labeled (reported with
 * `sensitive: true` and a boxed cause). The region closes when `fn` returns or throws. Mode off: `fn`
 * runs as is.
 */
export function runSensitiveRegion<T>(fn: () => T): T {
  if (!POLICY.mode) return fn();
  COUNTERS.region++;
  try {
    return fn();
  } finally {
    COUNTERS.region--;
  }
}

/** Whether a labeled region is open (see {@link runSensitiveRegion}). Mode off: false. */
export function inSensitiveRegion(): boolean {
  return POLICY.mode && COUNTERS.region > 0;
}

/**
 * A reader operation: every box removed, deep through arrays and plain objects (a labeled sentinel
 * becomes its plain sentinel). Containers are copied only where a box was found; accessors are never
 * run, cycles and prototypes are kept. A consumer should restrict which modules may import this.
 */
export function unboxAll(value: unknown): unknown {
  if (COUNTERS.registered === 0) return value;
  const walk = openWalk((v) => {
    if (SENSITIVE.inner.has(v)) return { into: SENSITIVE.inner.get(v) };
    return SENSITIVE.plain.has(v) ? { to: SENSITIVE.plain.get(v) } : undefined;
  }, true);
  return walkSensitive(value, walk);
}

/**
 * A reader operation for readers that withhold: every labeled value (a box, a labeled pending, error
 * or done) replaced by the policy marker, deep through arrays and plain objects. Containers are
 * copied only where something was replaced. A consumer should restrict which modules may import this.
 */
export function redact(value: unknown): unknown {
  if (COUNTERS.registered === 0) return value;
  const marker =
    POLICY.marker === PLACEHOLDER_MARKER ? POLICY.placeholder : POLICY.marker;
  const walk = openWalk(
    (v) => (SENSITIVE.labels.has(v) ? { to: marker } : undefined),
    true,
  );
  return walkSensitive(value, walk);
}
