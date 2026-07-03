import {
  DestroyRef,
  effect,
  InjectionToken,
  type Injector,
  isDevMode,
  signal,
  type Signal,
  untracked,
} from '@angular/core';
import { type AttributePolicy, type Attrs, identityPolicy } from './attrs';
import {
  createConsentState,
  createNoopConsent,
  type ConsentConfig,
  type ConsentDecision,
  type ConsentState,
  type TrackingRequirement,
} from './consent';
import {
  type LogSeverity,
  type MetricKind,
  type Sink,
  type SinkInput,
  type SinkSpan,
  type SpanContext,
  type SpanHandle,
} from './sink';

/** While a sink isn't ready, telemetry is buffered then flushed; if it never
 *  becomes ready within this window the buffer is dropped (so a broken sink
 *  can't grow memory for the app's lifetime). */
export const DEFAULT_READY_TIMEOUT_MS = 5_000;

export interface EmitOptions {
  /**
   * Consent category (e.g. 'perf' | 'errors' | 'product-analytics'). With
   * `TelemetryConfig.consent` configured, delivery is gated per sink on the
   * matching {@link TrackingRequirement} decisions (uncategorized emits are
   * never gated). Without consent config, the category is inert.
   */
  readonly category?: string;
  /**
   * Correlate this emit with a span. When set — or when emitted inside a `span()`
   * body (via the synchronous active-span stack) — the facade injects
   * `trace_id`/`span_id` into the attrs so event/error sinks (PostHog/Sentry)
   * link back to the trace.
   */
  readonly parent?: SpanHandle;
}

/**
 * Options for `span()`/`startSpan()`. Unlike emits, `parent` here sets the new
 * span's **trace lineage** (same `trace_id`, `parentSpanId` link) — it does not
 * inject ids into attrs.
 *
 * `span()` auto-nests: without an explicit `parent`, a span started inside
 * another `span()` body joins the active span's trace (same synchronous stack
 * that correlates emits). Pass `parent: null` to force a fresh trace root.
 * `startSpan()` never auto-nests — a manually-managed span (like the HTTP
 * interceptor's) parents only through an explicit handle (RFC §8).
 */
export interface SpanCallOptions extends Omit<EmitOptions, 'parent'> {
  readonly attrs?: Attrs;
  readonly parent?: SpanHandle | null;
}

export interface MetricOptions extends EmitOptions {
  /** OTel instrument family; the adapter defaults this (histogram) when omitted. */
  readonly kind?: MetricKind;
}

export interface Telemetry {
  readonly enabled: Signal<boolean>;
  /** The innermost span currently executing on the synchronous call stack, if any. */
  activeSpan(): SpanHandle | undefined;
  /**
   * Start a manually-managed span — the caller is responsible for `end()`.
   * For observable lifecycles (e.g. the HTTP interceptor) where `span(fn)` doesn't fit.
   * Never auto-nests; parent only via `opt.parent`.
   */
  startSpan(name: string, opt?: SpanCallOptions): SpanHandle;
  /**
   * Wraps `fn` in a span. The span ends when `fn` returns; if `fn` returns a
   * promise the span ends on settle (and records a thrown/rejected error).
   * Auto-nests under the active span (see {@link SpanCallOptions}).
   * In the noop, `fn` STILL runs — a span wraps real work; only instrumentation is skipped.
   */
  span<T>(name: string, fn: (span: SpanHandle) => T, opt?: SpanCallOptions): T;
  event(name: string, attrs?: Attrs, opt?: EmitOptions): void;
  error(err: unknown, attrs?: Attrs, opt?: EmitOptions): void;
  metric(name: string, value: number, attrs?: Attrs, opt?: MetricOptions): void;
  /** A structured log line (OTLP logs). Distinct from `error()` (exception capture). */
  log(severity: LogSeverity, message: string, attrs?: Attrs, opt?: EmitOptions): void;

  // ---- consent (RFC §7) — live only when `TelemetryConfig.consent` is set ----
  /** Everything the app declared it wants to track. */
  readonly requirements: Signal<readonly TrackingRequirement[]>;
  /** Requirements without a decision yet — prompt for exactly these (delta re-consent). */
  readonly pending: Signal<readonly TrackingRequirement[]>;
  /** The current decisions, keyed by requirement id. */
  readonly consent: Signal<Readonly<Record<string, ConsentDecision>>>;
  /** Record a decision (and persist it via the configured store). */
  decide(id: string, grant: boolean): void;
}

export interface TelemetryConfig {
  /** Sinks, or factories that build them in an injection context — see {@link SinkInput}. */
  readonly sinks: readonly SinkInput[];
  readonly policy?: AttributePolicy;
  /** See {@link DEFAULT_READY_TIMEOUT_MS}. */
  readonly readyTimeoutMs?: number;
  /** Reactive consent (requirements/pending/decide + persistence) — see {@link ConsentConfig}. */
  readonly consent?: ConsentConfig;
}

const ZERO_CTX: SpanContext = {
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
};

const NOOP_HANDLE: SpanHandle = {
  ctx: ZERO_CTX,
  setAttrs() {
    /* noop */
  },
  setError() {
    /* noop */
  },
  end() {
    /* noop */
  },
};

const NOOP_SINK_SPAN: SinkSpan = {
  setAttrs() {
    /* noop */
  },
  setError() {
    /* noop */
  },
  end() {
    /* noop */
  },
};

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/** Telemetry must never break the app: sink code runs behind this guard. */
function safe(sinkName: string, op: () => void): void {
  try {
    op();
  } catch (err) {
    if (isDevMode()) {
      console.warn(`[telemetry] sink "${sinkName}" threw — ignored`, err);
    }
  }
}

/**
 * A span started while its sink was buffering: each op is enqueued at its own
 * queue position (so the flush replays everything in true emission order) and
 * applies to the real span once it exists — or no-ops if the buffer dropped.
 */
class BufferedSinkSpan implements SinkSpan {
  private real: SinkSpan | null = null;
  private discarded = false;

  constructor(private readonly enqueue: (op: () => void) => void) {}

  setAttrs(attrs: Attrs): void {
    this.run((s) => s.setAttrs(attrs));
  }
  setError(err: unknown): void {
    this.run((s) => s.setError(err));
  }
  end(endMs?: number): void {
    this.run((s) => s.end(endMs));
  }

  attachReal(real: SinkSpan): void {
    if (!this.discarded) this.real = real;
  }

  discard(): void {
    this.discarded = true;
  }

  private run(op: (s: SinkSpan) => void): void {
    if (this.discarded) return;
    if (this.real) op(this.real);
    else
      this.enqueue(() => {
        if (!this.discarded && this.real) op(this.real);
      });
  }
}

/**
 * Per-sink readiness gate: forwards when ready, buffers while pending. On
 * timeout the buffer is dropped (bounded memory), but live delivery still
 * resumes if the sink becomes ready later — a slow sink loses its startup
 * window, not the session.
 */
class SinkDispatcher {
  private state: 'ready' | 'pending' | 'dropped' | 'destroyed';
  private queue: (() => void)[] = [];
  private bufferedSpans: BufferedSinkSpan[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly sink: Sink,
    injector: Injector,
    timeoutMs: number,
  ) {
    if (untracked(sink.ready)) {
      this.state = 'ready';
      return;
    }
    this.state = 'pending';
    effect(
      () => {
        if (sink.ready()) this.onReady();
      },
      { injector },
    );
    this.timer = setTimeout(() => this.drop(), timeoutMs);
    injector.get(DestroyRef).onDestroy(() => this.destroy());
  }

  emit(op: (sink: Sink) => void): void {
    if (this.state === 'ready') safe(this.sink.name, () => op(this.sink));
    else if (this.state === 'pending')
      this.queue.push(() => op(this.sink));
    // dropped/destroyed → discard
  }

  startSpan(name: string, ctx: SpanContext, attrs: Attrs, startMs: number): SinkSpan {
    const start = this.sink.startSpan;
    if (!start) return NOOP_SINK_SPAN;
    if (this.state === 'ready') {
      let span: SinkSpan = NOOP_SINK_SPAN;
      safe(this.sink.name, () => {
        span = start.call(this.sink, name, ctx, attrs, startMs);
      });
      return span;
    }
    if (this.state !== 'pending') return NOOP_SINK_SPAN;
    const rec = new BufferedSinkSpan((op) => {
      if (this.state === 'pending') this.queue.push(op);
    });
    this.bufferedSpans.push(rec);
    this.queue.push(() =>
      rec.attachReal(start.call(this.sink, name, ctx, attrs, startMs)),
    );
    return rec;
  }

  private onReady(): void {
    if (this.state === 'dropped') {
      // buffer already lost; resume live delivery
      this.state = 'ready';
      return;
    }
    if (this.state !== 'pending') return;
    this.state = 'ready';
    this.clearTimer();
    const queued = this.queue;
    this.queue = [];
    this.bufferedSpans = [];
    for (const op of queued) safe(this.sink.name, op);
  }

  private drop(): void {
    if (this.state !== 'pending') return;
    this.state = 'dropped';
    this.clearTimer();
    this.queue = [];
    for (const span of this.bufferedSpans) span.discard();
    this.bufferedSpans = [];
    if (isDevMode()) {
      console.warn(
        `[telemetry] sink "${this.sink.name}" did not become ready in time — dropped buffered telemetry (live delivery resumes when it becomes ready)`,
      );
    }
  }

  private destroy(): void {
    this.clearTimer();
    if (this.state === 'pending') {
      this.queue = [];
      for (const span of this.bufferedSpans) span.discard();
      this.bufferedSpans = [];
    }
    this.state = 'destroyed';
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

class NoopTelemetry implements Telemetry {
  readonly enabled: Signal<boolean> = signal(false).asReadonly();
  readonly requirements: Signal<readonly TrackingRequirement[]> = signal<
    readonly TrackingRequirement[]
  >([]).asReadonly();
  readonly pending = this.requirements;
  readonly consent: Signal<Readonly<Record<string, ConsentDecision>>> = signal(
    {},
  ).asReadonly();
  decide(): void {
    /* noop */
  }
  startSpan(): SpanHandle {
    return NOOP_HANDLE;
  }
  activeSpan(): SpanHandle | undefined {
    return undefined;
  }
  span<T>(_name: string, fn: (span: SpanHandle) => T): T {
    return fn(NOOP_HANDLE); // body still runs; instrumentation skipped
  }
  event(): void {
    /* noop */
  }
  error(): void {
    /* noop */
  }
  metric(): void {
    /* noop */
  }
  log(): void {
    /* noop */
  }
}

class ActiveTelemetry implements Telemetry {
  readonly enabled: Signal<boolean> = signal(true).asReadonly();
  private readonly policy: AttributePolicy;
  private readonly dispatchers: readonly SinkDispatcher[];
  private readonly stack: SpanHandle[] = [];
  private readonly consentState: ConsentState;

  readonly requirements: Signal<readonly TrackingRequirement[]>;
  readonly pending: Signal<readonly TrackingRequirement[]>;
  readonly consent: Signal<Readonly<Record<string, ConsentDecision>>>;

  constructor(
    sinks: readonly Sink[],
    config: Omit<TelemetryConfig, 'sinks'>,
    injector: Injector,
  ) {
    this.policy = config.policy ?? identityPolicy;
    const timeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.dispatchers = sinks.map(
      (sink) => new SinkDispatcher(sink, injector, timeoutMs),
    );
    this.consentState = config.consent
      ? createConsentState(config.consent)
      : createNoopConsent();
    this.requirements = this.consentState.requirements;
    this.pending = this.consentState.pending;
    this.consent = this.consentState.consent;
    injector.get(DestroyRef).onDestroy(() => {
      this.consentState.destroy();
      for (const sink of sinks) safe(sink.name, () => sink.dispose?.());
    });
  }

  decide(id: string, grant: boolean): void {
    this.consentState.decide(id, grant);
  }

  /** Route one sink delivery through the consent gate (deferring while a store hydrates). */
  private gated(
    category: string | undefined,
    sink: string,
    deliver: () => void,
  ): void {
    const verdict = this.consentState.gate(category, sink);
    if (verdict === 'allow') deliver();
    else if (verdict === 'defer' && category !== undefined) {
      this.consentState.defer(category, sink, deliver);
    }
  }

  /** A throwing (user-supplied) policy skips that sink instead of breaking the caller. */
  private apply(
    kind: 'span' | 'event' | 'error' | 'metric' | 'log',
    name: string,
    sink: Sink,
    attrs: Attrs | undefined,
  ): Attrs | null {
    try {
      return this.policy(attrs ?? {}, { kind, name, sink: sink.name });
    } catch (err) {
      if (isDevMode()) {
        console.warn(`[telemetry] AttributePolicy threw for sink "${sink.name}" — emit skipped`, err);
      }
      return null;
    }
  }

  activeSpan(): SpanHandle | undefined {
    return this.stack.at(-1);
  }

  /** Merge correlation ids (from the explicit parent or the active span) into the attrs. */
  private correlated(attrs?: Attrs, opt?: EmitOptions): Attrs | undefined {
    const span = opt?.parent ?? this.activeSpan();
    if (!span) return attrs;
    return {
      ...attrs,
      trace_id: span.ctx.traceId,
      span_id: span.ctx.spanId,
    };
  }

  event(name: string, eventAttrs?: Attrs, opt?: EmitOptions): void {
    const base = this.correlated(eventAttrs, opt);
    for (const d of this.dispatchers) {
      if (!d.sink.capture) continue;
      const attrs = this.apply('event', name, d.sink, base);
      if (!attrs) continue;
      this.gated(opt?.category, d.sink.name, () =>
        d.emit((s) => s.capture?.(name, attrs)),
      );
    }
  }

  error(err: unknown, errorAttrs?: Attrs, opt?: EmitOptions): void {
    const name = err instanceof Error ? err.name : 'error';
    const base = this.correlated(errorAttrs, opt);
    for (const d of this.dispatchers) {
      if (!d.sink.recordError) continue;
      const attrs = this.apply('error', name, d.sink, base);
      if (!attrs) continue;
      this.gated(opt?.category, d.sink.name, () =>
        d.emit((s) => s.recordError?.(err, attrs)),
      );
    }
  }

  metric(name: string, value: number, metricAttrs?: Attrs, opt?: MetricOptions): void {
    const base = this.correlated(metricAttrs, opt);
    for (const d of this.dispatchers) {
      if (!d.sink.record) continue;
      const attrs = this.apply('metric', name, d.sink, base);
      if (!attrs) continue;
      this.gated(opt?.category, d.sink.name, () =>
        d.emit((s) => s.record?.(name, value, attrs, opt?.kind)),
      );
    }
  }

  log(severity: LogSeverity, message: string, logAttrs?: Attrs, opt?: EmitOptions): void {
    const base = this.correlated(logAttrs, opt);
    const timestamp = Date.now(); // stamped at emit time, so buffered logs replay with true clocks
    for (const d of this.dispatchers) {
      if (!d.sink.emitLog) continue;
      const attrs = this.apply('log', message, d.sink, base);
      if (!attrs) continue;
      this.gated(opt?.category, d.sink.name, () =>
        d.emit((s) => s.emitLog?.({ severity, body: message, attrs, timestamp })),
      );
    }
  }

  startSpan(name: string, opt?: SpanCallOptions): SpanHandle {
    const parent = opt?.parent ?? undefined; // null (explicit root) and undefined both mean "no parent" here
    const ctx: SpanContext = {
      traceId: parent?.ctx.traceId ?? randomHex(16),
      spanId: randomHex(8),
      parentSpanId: parent?.ctx.spanId,
    };
    const startMs = Date.now();

    const live: { sink: Sink; span: SinkSpan }[] = [];
    for (const d of this.dispatchers) {
      if (!d.sink.startSpan) continue;
      // spans don't defer during consent hydration — a gated-out sink is skipped;
      // the handle stays fully usable (ctx, children, correlation) either way
      if (this.consentState.gate(opt?.category, d.sink.name) !== 'allow') continue;
      const attrs = this.apply('span', name, d.sink, opt?.attrs);
      if (attrs) {
        live.push({ sink: d.sink, span: d.startSpan(name, ctx, attrs, startMs) });
      }
    }

    return {
      ctx,
      setAttrs: (attrs) => {
        for (const { sink, span } of live) {
          const applied = this.apply('span', name, sink, attrs);
          if (applied) safe(sink.name, () => span.setAttrs(applied));
        }
      },
      setError: (err) => {
        for (const { sink, span } of live) safe(sink.name, () => span.setError(err));
      },
      end: () => {
        const endMs = Date.now();
        for (const { sink, span } of live) safe(sink.name, () => span.end(endMs));
      },
    };
  }

  span<T>(name: string, fn: (span: SpanHandle) => T, opt?: SpanCallOptions): T {
    // auto-nest under the active span; `parent: null` forces a fresh root
    const parent =
      opt?.parent === null ? undefined : (opt?.parent ?? this.activeSpan());
    const handle = this.startSpan(name, { ...opt, parent });
    this.stack.push(handle);
    let result: T;
    try {
      result = fn(handle);
    } catch (err) {
      this.stack.pop();
      handle.setError(err);
      handle.end();
      throw err;
    }
    this.stack.pop(); // active-span tracking is synchronous-only (RFC §8.2)

    if (isPromiseLike(result)) {
      return result.then(
        (value) => {
          handle.end();
          return value;
        },
        (err: unknown) => {
          handle.setError(err);
          handle.end();
          throw err;
        },
      ) as unknown as T;
    }

    handle.end();
    return result;
  }
}

/** Builds the runtime service: active when ≥1 sink, otherwise the zero-overhead noop. */
export function createTelemetry(
  sinks: readonly Sink[],
  config: Omit<TelemetryConfig, 'sinks'>,
  injector: Injector,
): Telemetry {
  return sinks.length > 0
    ? new ActiveTelemetry(sinks, config, injector)
    : new NoopTelemetry();
}

/** Default token value is the noop, so `inject(TELEMETRY)` works with no config. */
export const TELEMETRY = new InjectionToken<Telemetry>('@mmstack/telemetry', {
  providedIn: 'root',
  factory: () => new NoopTelemetry(),
});

/** Escape hatch: read a span's raw correlation ids. Handles are otherwise opaque. */
export function readSpan(handle: SpanHandle): SpanContext {
  return handle.ctx;
}
