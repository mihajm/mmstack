const SENSITIVE_REGISTRY_KEY = Symbol.for('@mmstack/primitives.sensitive');
const SENSITIVE_PROTOCOL = 1;

/**
 * The marker value meaning "substitute the placeholder". Realm-wide, so every copy reads the same
 * default from the shared policy record.
 */
export const PLACEHOLDER_MARKER: unique symbol = Symbol.for(
  '@mmstack/primitives.sensitive.placeholder',
) as never;

/** The sensitive-value policy. Mutable on purpose: the one record every copy shares. */
export interface SensitivePolicy {
  /** Whether values declared sensitive are boxed at all. Off: every declaration is the identity. */
  mode: boolean;
  /** What a soft coercion of a box answers in a string context. */
  placeholder: string;
  /** What `redact` substitutes for a labeled value ({@link PLACEHOLDER_MARKER}: the placeholder). */
  marker: unknown;
}

/** Mutable counters shared by every copy. */
export interface SensitiveCounters {
  /** Depth of open labeled regions: an error minted while it is above zero is labeled. */
  region: number;
  /** Every write into the side tables, for the "mode off registers nothing" witness. */
  registered: number;
}

export interface SensitiveRegistry {
  readonly protocol: number;
  /** Box to its inner value. A box has no own properties: its value lives only here. */
  readonly inner: WeakMap<object, unknown>;
  /** Every labeled object: boxes, labeled absorbers, objects thrown under a labeled call. */
  readonly labels: WeakSet<object>;
  /** Absorber to its labeled twin. */
  readonly twin: WeakMap<object, object>;
  /** Labeled twin to the absorber it labels. */
  readonly plain: WeakMap<object, object>;
  /** Object to its one box, so boxing an object is idempotent and a host's result maps back. */
  readonly objectBox: WeakMap<object, object>;
  /** Edge-minted per-field view to the raw value it was minted from. */
  readonly canonical: WeakMap<object, unknown>;
  readonly policy: SensitivePolicy;
  readonly counters: SensitiveCounters;
}

export class SensitiveRegistryError extends TypeError {
  constructor(message: string) {
    super(`[mmstack] ${message}`);
    this.name = 'SensitiveRegistryError';
  }
}

function validateForeignRegistry(slot: unknown): SensitiveRegistry {
  if (typeof slot !== 'object' || slot === null) {
    throw new SensitiveRegistryError(
      `sensitive registry slot is pre-seeded with a non-registry value (${slot === null ? 'null' : typeof slot})`,
    );
  }
  const record = slot as Partial<SensitiveRegistry>;
  if (record.protocol !== SENSITIVE_PROTOCOL) {
    throw new SensitiveRegistryError(
      `sensitive registry protocol mismatch: the slot speaks ${String(record.protocol)}, this copy speaks ${SENSITIVE_PROTOCOL}`,
    );
  }
  const maps = [
    record.inner,
    record.twin,
    record.plain,
    record.objectBox,
    record.canonical,
  ];
  if (
    !maps.every((m) => m instanceof WeakMap) ||
    !(record.labels instanceof WeakSet)
  ) {
    throw new SensitiveRegistryError('sensitive registry record is malformed');
  }
  const policy = record.policy;
  const counters = record.counters;
  if (
    typeof policy !== 'object' ||
    policy === null ||
    typeof policy.mode !== 'boolean' ||
    typeof policy.placeholder !== 'string' ||
    typeof counters !== 'object' ||
    counters === null ||
    typeof counters.region !== 'number' ||
    typeof counters.registered !== 'number'
  ) {
    throw new SensitiveRegistryError('sensitive registry policy is malformed');
  }
  return record as SensitiveRegistry;
}

/**
 * Joins (or mints) the realm-wide sensitive registry at a `Symbol.for` slot on the host, so two
 * bundled copies recognize each other's boxes and share one mode. A protocol mismatch fails loud
 * here at module init.
 */
export function joinSensitiveRegistry(
  host: Record<symbol, unknown> = globalThis as unknown as Record<
    symbol,
    unknown
  >,
): SensitiveRegistry {
  const existing = host[SENSITIVE_REGISTRY_KEY];
  if (existing !== undefined) return validateForeignRegistry(existing);
  const minted: SensitiveRegistry = Object.freeze({
    protocol: SENSITIVE_PROTOCOL,
    inner: new WeakMap<object, unknown>(),
    labels: new WeakSet<object>(),
    twin: new WeakMap<object, object>(),
    plain: new WeakMap<object, object>(),
    objectBox: new WeakMap<object, object>(),
    canonical: new WeakMap<object, unknown>(),
    policy: {
      mode: false,
      placeholder: '[mmstack sensitive]',
      marker: PLACEHOLDER_MARKER,
    },
    counters: { region: 0, registered: 0 },
  });
  Object.defineProperty(host, SENSITIVE_REGISTRY_KEY, {
    value: minted,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return minted;
}

export const SENSITIVE: SensitiveRegistry = joinSensitiveRegistry();

const weakSetHas = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>,
  value: object,
) => boolean;
const weakSetAdd = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>,
  value: object,
) => WeakSet<object>;

/** Registers `value` as labeled. Callers check the mode first. */
export function addLabel(value: object): void {
  weakSetAdd(SENSITIVE.labels, value);
  SENSITIVE.counters.registered++;
}

/** Mode on and `value` is a labeled object: the one predicate every hook branch starts with. */
export function hasLabel(value: unknown): boolean {
  return (
    SENSITIVE.policy.mode &&
    typeof value === 'object' &&
    value !== null &&
    weakSetHas(SENSITIVE.labels, value)
  );
}

/**
 * How an error minted now over `cause` is sensitive. `labeled` (the error carries the label and its
 * report is sensitive): inside a labeled region, or over a labeled object that is not a box, such as
 * one thrown under a labeled call. `hidden` (only the report is sensitive, the error stays plain): over
 * a box, the way an edge mints a sensitive source's own failure. Otherwise neither.
 */
export function mintSensitivity(
  cause: unknown,
): 'labeled' | 'hidden' | undefined {
  if (!SENSITIVE.policy.mode) return undefined;
  if (SENSITIVE.counters.region > 0) return 'labeled';
  if (typeof cause !== 'object' || cause === null) return undefined;
  if (SENSITIVE.inner.has(cause)) return 'hidden';
  return weakSetHas(SENSITIVE.labels, cause) ? 'labeled' : undefined;
}
