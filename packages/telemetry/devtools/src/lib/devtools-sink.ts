import { isDevMode, signal } from '@angular/core';
import {
  type Attrs,
  type Finding,
  formatOrigin,
  type Origin,
  type OriginKind,
  type Sink,
  type SinkSpan,
} from '@mmstack/telemetry-core';

/** The palette Chrome's Performance panel accepts for custom track entries. */
export type DevtoolsColor =
  | 'primary'
  | 'primary-light'
  | 'primary-dark'
  | 'secondary'
  | 'secondary-light'
  | 'secondary-dark'
  | 'tertiary'
  | 'tertiary-light'
  | 'tertiary-dark'
  | 'error'
  | 'warning';

/**
 * What a `track`/`color` callback sees. For a finding, `name` is its code and `attrs` carries the
 * finding's `code`, `severity`, `path`, `node` and `fingerprint` over the delivered attrs.
 */
export interface TrackInput {
  readonly kind: 'span' | 'event' | 'finding';
  readonly name: string;
  readonly attrs: Attrs;
  /** `true` for a span on which `setError` was called; absent otherwise. */
  readonly error?: boolean;
}

export interface DevtoolsSinkConfig {
  /** Sink name. Default `'devtools'`. */
  readonly name?: string;
  /**
   * `'cheap'` = `console.timeStamp` only (nothing retained); `'rich'` = `performance.measure` with
   * tooltips and properties. Default `'rich'` in dev mode, `'cheap'` otherwise.
   */
  readonly mode?: 'cheap' | 'rich';
  /** Track group every track renders under. Default `'mmstack'`. */
  readonly group?: string;
  /** Which track an entry lands on. Default: a string `attrs.track`, else `Spans`, `Events` or `Findings` by kind. */
  readonly track?: (input: TrackInput) => string;
  readonly color?: (input: TrackInput) => DevtoolsColor;
  /**
   * Track names to seed in this order at t≈0 so the group renders stably. Replaces the default
   * `['Spans', 'Events', 'Findings']` entirely.
   */
  readonly seed?: readonly string[];
}

type Entry = {
  readonly label: string;
  /** performance-relative ms */
  readonly start: number;
  readonly end: number;
  readonly track: string;
  readonly color?: DevtoolsColor;
  readonly tooltip?: string;
  readonly properties?: readonly (readonly [string, string])[];
};

type TimeStamp = (
  label: string,
  start: number,
  end: number,
  track: string,
  group: string,
  color?: DevtoolsColor,
) => void;

const LABEL_MAX = 120;
/** Just after the time origin, so seeded tracks come before any real entry. */
const SEED_AT = 0.003;

const BUCKETS: Record<TrackInput['kind'], string> = {
  span: 'Spans',
  event: 'Events',
  finding: 'Findings',
};
const DEFAULT_SEED: readonly string[] = ['Spans', 'Events', 'Findings'];

function defaultTrack(input: TrackInput): string {
  const track = input.attrs['track'];
  if (typeof track === 'string' && track) return track;
  return BUCKETS[input.kind];
}

function defaultColor(
  input: TrackInput,
  severity?: Finding['severity'],
): DevtoolsColor {
  if (input.kind === 'span') return input.error ? 'error' : 'primary';
  if (input.kind === 'event') return 'secondary';
  if (severity === 'error') return 'error';
  if (severity === 'warn') return 'warning';
  return 'tertiary';
}

/** The origin the facade folded into these attrs, if any. */
function originOf(attrs: Attrs): Origin | undefined {
  const kind = attrs['origin.kind'];
  const name = attrs['origin.name'];
  if (typeof kind !== 'string' || typeof name !== 'string') return undefined;
  const target = attrs['origin.target'];
  return typeof target === 'string'
    ? { kind: kind as OriginKind, name, target }
    : { kind: kind as OriginKind, name };
}

/** Primitive attrs as Chrome property rows; null and undefined are skipped. */
function propertiesOf(attrs: Attrs): [string, string][] {
  const out: [string, string][] = [];
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') {
      out.push([key, String(value)]);
    }
  }
  return out;
}

function truncate(text: string): string {
  return text.length > LABEL_MAX ? text.slice(0, LABEL_MAX - 1) + '…' : text;
}

/** Epoch ms (the facade's stamps) → ms relative to `performance.timeOrigin` (Chrome's clock). */
function toPerf(epochMs: number): number {
  return epochMs - performance.timeOrigin;
}

function cheapEmitter(group: string): (entry: Entry) => void {
  return (e) => {
    const timeStamp = console.timeStamp as unknown as TimeStamp;
    if (e.color === undefined)
      timeStamp(e.label, e.start, e.end, e.track, group);
    else timeStamp(e.label, e.start, e.end, e.track, group, e.color);
  };
}

/**
 * `performance.measure` with Chrome's `devtools` detail. The panel captures each entry when it is
 * made, so emitted labels are cleared in one microtask per burst and User Timing retains nothing.
 */
function richEmitter(group: string): (entry: Entry) => void {
  let pending: Set<string> | null = null;
  const flush = () => {
    const labels = pending;
    pending = null;
    if (!labels || typeof performance.clearMeasures !== 'function') return;
    for (const label of labels) performance.clearMeasures(label);
  };
  return (e) => {
    performance.measure(e.label, {
      start: e.start,
      end: e.end,
      detail: {
        devtools: {
          dataType: 'track-entry',
          track: e.track,
          trackGroup: group,
          ...(e.color === undefined ? undefined : { color: e.color }),
          ...(e.tooltip === undefined ? undefined : { tooltipText: e.tooltip }),
          ...(e.properties === undefined
            ? undefined
            : { properties: e.properties }),
        },
      },
    });
    if (!pending) {
      pending = new Set();
      queueMicrotask(flush);
    }
    pending.add(e.label);
  };
}

/**
 * A dev sink that renders spans, events and findings as named tracks on Chrome's Performance
 * panel, next to its main-thread and network tracks. It shows the same records every other sink
 * gets; labels come only from `formatOrigin` and the record names.
 *
 * Entries are emitted after the fact from the facade's own time stamps, so readiness-buffered spans
 * keep their real times. Returns `null` during SSR and where neither `console.timeStamp` nor
 * `performance.measure` exists; with only one of them, that one is used whatever the `mode`.
 */
export function devtoolsSink(
  config: DevtoolsSinkConfig = {},
): () => Sink | null {
  return () => {
    if (typeof window === 'undefined') return null;
    const cheapOk = typeof globalThis.console?.timeStamp === 'function';
    const richOk = typeof globalThis.performance?.measure === 'function';
    if (!cheapOk && !richOk) return null;

    const wanted = config.mode ?? (isDevMode() ? 'rich' : 'cheap');
    const rich = wanted === 'rich' ? richOk : !cheapOk;
    const group = config.group ?? 'mmstack';
    const emit = rich ? richEmitter(group) : cheapEmitter(group);
    const trackOf = config.track ?? defaultTrack;
    const colorOf = (
      input: TrackInput,
      severity?: Finding['severity'],
    ): DevtoolsColor =>
      config.color ? config.color(input) : defaultColor(input, severity);

    for (const track of config.seed ?? DEFAULT_SEED) {
      emit({ label: track, start: SEED_AT, end: SEED_AT, track });
    }

    return {
      name: config.name ?? 'devtools',
      ready: signal(true).asReadonly(),
      startSpan(name, _ctx, attrs, startMs): SinkSpan {
        const start = toPerf(startMs ?? Date.now());
        let bag: Attrs = { ...attrs };
        let errored = false;
        let ended = false;
        return {
          setAttrs(more) {
            bag = { ...bag, ...more };
          },
          setError() {
            errored = true;
          },
          end(endMs) {
            if (ended) return;
            ended = true;
            const input: TrackInput = errored
              ? { kind: 'span', name, attrs: bag, error: true }
              : { kind: 'span', name, attrs: bag };
            const origin = originOf(bag);
            emit({
              label: origin ? `${formatOrigin(origin)} · ${name}` : name,
              start,
              end: toPerf(endMs ?? Date.now()),
              track: trackOf(input),
              color: colorOf(input),
              properties: propertiesOf(bag),
            });
          },
        };
      },
      capture(name, attrs) {
        const now = toPerf(Date.now());
        const input: TrackInput = { kind: 'event', name, attrs: attrs ?? {} };
        emit({
          label: name,
          start: now,
          end: now,
          track: trackOf(input),
          color: colorOf(input),
          properties: propertiesOf(input.attrs),
        });
      },
      recordFinding(finding, attrs) {
        const now = toPerf(Date.now());
        const bag: Attrs = {
          ...attrs,
          code: finding.code,
          severity: finding.severity,
          path: finding.path,
          ...(finding.node === undefined ? undefined : { node: finding.node }),
          fingerprint: finding.fingerprint,
        };
        const input: TrackInput = {
          kind: 'finding',
          name: finding.code,
          attrs: bag,
        };
        emit({
          label: truncate(`${finding.code}: ${finding.message}`),
          start: now,
          end: now,
          track: trackOf(input),
          color: colorOf(input, finding.severity),
          tooltip: finding.message,
          properties: propertiesOf(bag),
        });
      },
    };
  };
}
