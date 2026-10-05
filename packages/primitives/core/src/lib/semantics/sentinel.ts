declare const SENTINEL_BRAND: unique symbol;

const SENTINEL_REGISTRY_KEY = Symbol.for('@mmstack/primitives.sentinels');
const SENTINEL_PROTOCOL = 2;

export interface SentinelRegistry {
  readonly protocol: number;
  readonly sentinels: WeakSet<object>;
  readonly aware: WeakSet<object>;
}

export class SentinelRegistryError extends TypeError {
  constructor(message: string) {
    super(`[mmstack] ${message}`);
    this.name = 'SentinelRegistryError';
  }
}

const weakSetHas = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>,
  value: object,
) => boolean;
const weakSetAdd = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>,
  value: object,
) => WeakSet<object>;

function validateForeignRegistry(slot: unknown): SentinelRegistry {
  if (typeof slot !== 'object' || slot === null) {
    throw new SentinelRegistryError(
      `sentinel registry slot is pre-seeded with a non-registry value (${slot === null ? 'null' : typeof slot})`,
    );
  }
  const record = slot as Partial<SentinelRegistry>;
  if (record.protocol !== SENTINEL_PROTOCOL) {
    throw new SentinelRegistryError(
      `sentinel registry protocol mismatch: the slot speaks ${String(record.protocol)}, this copy speaks ${SENTINEL_PROTOCOL}`,
    );
  }
  if (
    !(record.sentinels instanceof WeakSet) ||
    !(record.aware instanceof WeakSet)
  ) {
    throw new SentinelRegistryError('sentinel registry record is malformed');
  }
  return record as SentinelRegistry;
}

/**
 * Joins (or mints) the realm-wide sentinel registry at a `Symbol.for` slot on the host, so two
 * bundled copies recognise each other's sentinels. A protocol mismatch fails loud here at module
 * init rather than degrading silently.
 */
export function joinSentinelRegistry(
  host: Record<symbol, unknown> = globalThis as unknown as Record<
    symbol,
    unknown
  >,
): SentinelRegistry {
  const existing = host[SENTINEL_REGISTRY_KEY];
  if (existing !== undefined) return validateForeignRegistry(existing);
  const minted: SentinelRegistry = Object.freeze({
    protocol: SENTINEL_PROTOCOL,
    sentinels: new WeakSet<object>(),
    aware: new WeakSet<object>(),
  });
  Object.defineProperty(host, SENTINEL_REGISTRY_KEY, {
    value: minted,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return minted;
}

const REGISTRY = joinSentinelRegistry();

export const SENTINEL_KINDS = Object.freeze([
  'loading',
  'done',
  'error',
] as const);
export type SentinelKind = (typeof SENTINEL_KINDS)[number];

export interface Sentinel<TKind extends SentinelKind = SentinelKind> {
  readonly [SENTINEL_BRAND]: true;
  readonly kind: TKind;
  readonly source: unknown;
}

export type Loading = Sentinel<'loading'>;

export type Done = Sentinel<'done'>;

/**
 * Who constructed an error, for presentation/telemetry classification only. `authored` = an
 * `error(...)` an author wrote; `evaluation` = a containable evaluation failure an evaluator mints;
 * `edge` = a transport/timeout failure minted at an I/O adapter.
 */
export type ErrorOrigin = 'authored' | 'evaluation' | 'edge';

/**
 * Operational telemetry sub-class — a COARSE triage-ownership hint, not a causality claim: a fault in
 * author-supplied expression/data (`author-fault`), an internal engine defect (`engine-defect`), or a
 * failure outside the app's control (`external-fault`: transport error, HTTP error status, timeout).
 * Edge faults are `external-fault` — attribution of a specific status (e.g. a 4xx) to author vs backend
 * is unreliable, so it stays external unless a future dedicated reason field earns finer attribution.
 */
export type ErrorSubclass = 'author-fault' | 'engine-defect' | 'external-fault';

/**
 * The second absorbing sentinel: a contained failure that flows as a value (constructed by
 * `error(...)`). Value-free by law — the cause lives only on the telemetry channel, reported once
 * at mint, never stored on the object.
 */
export interface ErrorSentinel extends Sentinel<'error'> {
  readonly origin: ErrorOrigin;
  readonly renderableMessage?: string;
}

/** The two absorbing kinds. `done` is a settlement sentinel and is deliberately NOT absorbing. */
export type Absorbing = Loading | ErrorSentinel;

export class SentinelLeakError extends TypeError {
  constructor(boundary: string) {
    super(`[mmstack] sentinel leaked to a ${boundary} boundary`);
    this.name = 'SentinelLeakError';
  }
}

const leak = (boundary: string) => () => {
  throw new SentinelLeakError(boundary);
};

const LEAK_PRIMITIVE = leak('primitive-coercion');
const LEAK_STRING = leak('string-coercion');
const LEAK_JSON = leak('serialization');

function mint<TKind extends SentinelKind>(
  kind: TKind,
  source: unknown,
  extra?: Record<string, unknown>,
): Sentinel<TKind> {
  const sentinel = Object.freeze({
    kind,
    source,
    ...extra,
    [Symbol.toPrimitive]: LEAK_PRIMITIVE,
    toString: LEAK_STRING,
    toJSON: LEAK_JSON,
  });
  weakSetAdd(REGISTRY.sentinels, sentinel);
  return sentinel as unknown as Sentinel<TKind>;
}

export function loading(source?: unknown): Loading {
  return mint('loading', source);
}

/** The canonical no-payload settlement sentinel. One shared, frozen, un-serializable value. */
export const DONE: Done = mint('done', undefined);

export function isSentinel(value: unknown): value is Sentinel {
  return (
    typeof value === 'object' &&
    value !== null &&
    weakSetHas(REGISTRY.sentinels, value)
  );
}

/** True for the two absorbing kinds (`loading`, `error`); `done` is deliberately NOT absorbing. */
export function isAbsorbing(value: unknown): value is Absorbing {
  return (
    isSentinel(value) && (value.kind === 'loading' || value.kind === 'error')
  );
}

export function sentinelAware<T extends (...args: never[]) => unknown>(
  fn: T,
): T {
  weakSetAdd(REGISTRY.aware, fn);
  return fn;
}

export function isSentinelAware(value: unknown): boolean {
  return typeof value === 'function' && weakSetHas(REGISTRY.aware, value);
}

export const isLoading = sentinelAware((value: unknown): value is Loading => {
  return isSentinel(value) && value.kind === 'loading';
});

export const isDone = sentinelAware((value: unknown): value is Done => {
  return isSentinel(value) && value.kind === 'done';
});

export const ifLoading = sentinelAware(
  (value: unknown, fallback: unknown): unknown => {
    return isLoading(value) ? fallback : value;
  },
);

export interface ErrorMintReport {
  readonly origin: ErrorOrigin;
  readonly subclass: ErrorSubclass;
  readonly cause: unknown;
}

export type ErrorReporter = (report: ErrorMintReport) => void;

let errorReporter: ErrorReporter | undefined;

/**
 * Install the observability sink that receives every error mint exactly once (the sentinel is
 * value-free, so the cause travels only on this channel). Wiring-side; the default is no reporter,
 * and later `ifError` absorption never retracts a report that already fired.
 */
export function setErrorReporter(reporter: ErrorReporter | undefined): void {
  errorReporter = reporter;
}

function mintError(
  origin: ErrorOrigin,
  cause: unknown,
  renderableMessage: string | undefined,
  subclass: ErrorSubclass,
): ErrorSentinel {
  const extra: Record<string, unknown> = { origin };
  if (renderableMessage !== undefined)
    extra['renderableMessage'] = renderableMessage;
  const sentinel = mint('error', undefined, extra) as ErrorSentinel;
  errorReporter?.({ origin, subclass, cause });
  return sentinel;
}

/**
 * The authored error constructor. `message` is reported to telemetry once and never stored on the
 * value; only `errorConstant` sets a renderable message. Origin defaults to `authored`; evaluation
 * and edge mint sites pass theirs.
 */
export function error(
  message?: unknown,
  origin: ErrorOrigin = 'authored',
): ErrorSentinel {
  return mintError(origin, message, undefined, 'author-fault');
}

/**
 * Mint for a message known to be a constant, never runtime data: the text is safe to render
 * (escaped downstream) AND still reported to telemetry. For callers that can prove the message is a
 * constant, such as a compiler folding an `error(...)` argument.
 */
export function errorConstant(
  message: string,
  origin: ErrorOrigin = 'authored',
): ErrorSentinel {
  return mintError(origin, message, message, 'author-fault');
}

/**
 * The edge mint — a transport/timeout failure at an I/O boundary. Origin `edge`, subclass
 * `external-fault` (never inherits the authored default). Generic presentation (no renderableMessage:
 * edge messages are not authored constants); the cause travels to telemetry once at mint, value-free.
 */
export function errorEdge(cause?: unknown): ErrorSentinel {
  return mintError('edge', cause, undefined, 'external-fault');
}

export const isError = sentinelAware(
  (value: unknown): value is ErrorSentinel => {
    return isSentinel(value) && value.kind === 'error';
  },
);

/**
 * Explicit-fallback law: an error is replaced by `fallback`, everything else (values, pending, done)
 * passes through. The raw cause is value-free and never reaches the fallback — handling is positional
 * and taxonomy-free. Absorbs ANY error regardless of origin (uniform absorbability); handling never
 * suppresses the mint-time telemetry that already fired.
 */
export const ifError = sentinelAware(
  (value: unknown, fallback: unknown): unknown => {
    return isError(value) ? fallback : value;
  },
);
