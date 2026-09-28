import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  formatOrigin,
  type Origin,
  provideTelemetry,
  type Sink,
  type SpanContext,
  TELEMETRY,
} from '@mmstack/telemetry-core';
import { type Mock } from 'vitest';
import { devtoolsSink, type DevtoolsSinkConfig } from './devtools-sink';

const ORIGIN = 1_000_000; // stubbed performance.timeOrigin (epoch ms)
const CTX: SpanContext = { traceId: 't'.repeat(32), spanId: 's'.repeat(16) };

/** Replace `obj[key]` with `value` (own property) until the returned restore runs. */
function shadow(obj: object, key: string, value: unknown): () => void {
  const own = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    if (own) Object.defineProperty(obj, key, own);
    else delete (obj as Record<string, unknown>)[key];
  };
}

const hide = (obj: object, key: string) => shadow(obj, key, undefined);

describe('@mmstack/telemetry-devtools', () => {
  // the test environment's console has no timeStamp, so every API is shadowed with a mock
  let timeStamp: Mock;
  let measure: Mock;
  let clear: Mock;
  const restores: (() => void)[] = [];

  beforeEach(() => {
    timeStamp = vi.fn();
    measure = vi.fn();
    clear = vi.fn();
    restores.push(
      shadow(console, 'timeStamp', timeStamp),
      shadow(performance, 'measure', measure),
      shadow(performance, 'clearMeasures', clear),
      shadow(performance, 'timeOrigin', ORIGIN),
    );
  });

  afterEach(() => {
    while (restores.length) restores.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function make(config?: DevtoolsSinkConfig): Sink {
    // no seed unless the test asks, so each assertion sees only the entries under test
    const sink = devtoolsSink({ seed: [], ...config })();
    if (!sink) throw new Error('expected a sink');
    return sink;
  }

  function viaFacade(sink: Sink) {
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    return TestBed.inject(TELEMETRY);
  }

  describe('availability', () => {
    it('returns null during SSR (no window)', () => {
      vi.stubGlobal('window', undefined);
      expect(devtoolsSink()()).toBeNull();
    });

    it('returns null when neither console.timeStamp nor performance.measure exists', () => {
      restores.push(hide(console, 'timeStamp'), hide(performance, 'measure'));
      expect(devtoolsSink({ mode: 'rich' })()).toBeNull();
      expect(devtoolsSink({ mode: 'cheap' })()).toBeNull();
    });

    it('uses console.timeStamp when it is the only API, even in rich mode', () => {
      restores.push(hide(performance, 'measure'));
      make({ mode: 'rich' }).capture?.('e', {});
      expect(timeStamp).toHaveBeenCalledTimes(1);
    });

    it('uses performance.measure when it is the only API, even in cheap mode', () => {
      restores.push(hide(console, 'timeStamp'));
      make({ mode: 'cheap' }).capture?.('e', {});
      expect(measure).toHaveBeenCalledTimes(1);
      expect(timeStamp).not.toHaveBeenCalled();
    });

    it('defaults to rich in dev mode', () => {
      make().capture?.('e', {});
      expect(measure).toHaveBeenCalledTimes(1);
      expect(timeStamp).not.toHaveBeenCalled();
    });
  });

  describe('clock', () => {
    it('converts the facade epoch stamps to performance-relative ms exactly', () => {
      const span = make({ mode: 'cheap' }).startSpan?.(
        's',
        CTX,
        {},
        ORIGIN + 250.5,
      );
      span?.end(ORIGIN + 400.25);
      expect(timeStamp.mock.calls[0]).toEqual([
        's',
        250.5,
        400.25,
        'Spans',
        'mmstack',
        'primary',
      ]);
    });

    it('falls back to Date.now() at the call for missing stamps', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(ORIGIN + 10);
      const span = make({ mode: 'cheap' }).startSpan?.('s', CTX, {});
      now.mockReturnValue(ORIGIN + 30);
      span?.end();
      expect(timeStamp.mock.calls[0].slice(1, 3)).toEqual([10, 30]);
    });

    it('stamps events at the call through the facade', () => {
      vi.spyOn(Date, 'now').mockReturnValue(ORIGIN + 77);
      viaFacade(make({ mode: 'cheap' })).event('cart.add');
      expect(timeStamp.mock.calls[0]).toEqual([
        'cart.add',
        77,
        77,
        'Events',
        'mmstack',
        'secondary',
      ]);
    });

    it('buffered replay keeps the span’s original stamps', () => {
      const now = vi.spyOn(Date, 'now');
      const ready = signal(false);
      const sink: Sink = {
        ...make({ mode: 'cheap' }),
        ready: ready.asReadonly(),
      };
      const telemetry = viaFacade(sink);

      now.mockReturnValue(ORIGIN + 100);
      const handle = telemetry.startSpan('boot');
      now.mockReturnValue(ORIGIN + 200);
      handle.end();
      telemetry.event('booted'); // events carry no facade stamp: replayed at flush time
      expect(timeStamp).not.toHaveBeenCalled();

      now.mockReturnValue(ORIGIN + 900);
      ready.set(true);
      TestBed.tick();

      expect(timeStamp.mock.calls).toEqual([
        ['boot', 100, 200, 'Spans', 'mmstack', 'primary'],
        ['booted', 900, 900, 'Events', 'mmstack', 'secondary'],
      ]);
    });
  });

  describe('span labels', () => {
    it('prefixes the formatOrigin label when origin attrs are present', () => {
      const origin: Origin = {
        kind: 'interaction',
        name: 'click',
        target: 'button#demo',
      };
      const telemetry = viaFacade(make({ mode: 'cheap' }));
      telemetry.withOrigin(origin, () =>
        telemetry.span('demo', () => undefined),
      );
      expect(timeStamp.mock.calls[0][0]).toBe(`${formatOrigin(origin)} · demo`);
      expect(timeStamp.mock.calls[0][0]).toBe('click on button#demo · demo');
    });

    it('uses formatOrigin for non-interaction kinds and a missing target', () => {
      const sink = make({ mode: 'cheap' });
      const nav = {
        'origin.kind': 'navigation',
        'origin.name': 'route-change',
        'origin.target': '/u',
      };
      sink.startSpan?.('load', CTX, nav, ORIGIN).end(ORIGIN);
      sink
        .startSpan?.(
          'tick',
          CTX,
          { 'origin.kind': 'external', 'origin.name': 'timer' },
          ORIGIN,
        )
        .end(ORIGIN);
      expect(timeStamp.mock.calls.map((c) => c[0])).toEqual([
        'navigation route-change → /u · load',
        'external timer · tick',
      ]);
    });

    it('is the plain name without origin attrs', () => {
      viaFacade(make({ mode: 'cheap' })).span(
        'checkout.submit',
        () => undefined,
      );
      expect(timeStamp.mock.calls[0][0]).toBe('checkout.submit');
    });

    it('reads origin attrs set after start, and ends only once', () => {
      const span = make({ mode: 'cheap' }).startSpan?.('late', CTX, {}, ORIGIN);
      span?.setAttrs({ 'origin.kind': 'action', 'origin.name': 'save' });
      span?.end(ORIGIN);
      span?.end(ORIGIN);
      expect(timeStamp.mock.calls).toEqual([
        ['action save · late', 0, 0, 'Spans', 'mmstack', 'primary'],
      ]);
    });
  });

  describe('emission shapes', () => {
    it('cheap: console.timeStamp(label, start, end, track, group, color)', () => {
      const span = make({ mode: 'cheap', group: 'app' }).startSpan?.(
        'checkout.submit',
        CTX,
        {},
        ORIGIN + 5,
      );
      span?.end(ORIGIN + 9);
      expect(timeStamp.mock.calls).toEqual([
        ['checkout.submit', 5, 9, 'Spans', 'app', 'primary'],
      ]);
      expect(measure).not.toHaveBeenCalled();
    });

    it('rich: performance.measure with the devtools detail; properties keep primitives only', () => {
      const attrs = {
        items: 3,
        flag: true,
        who: 'me',
        gone: null,
        unset: undefined,
      };
      make({ mode: 'rich' })
        .startSpan?.('checkout.submit', CTX, attrs, ORIGIN + 5)
        .end(ORIGIN + 9);
      expect(measure.mock.calls).toEqual([
        [
          'checkout.submit',
          {
            start: 5,
            end: 9,
            detail: {
              devtools: {
                dataType: 'track-entry',
                track: 'Spans',
                trackGroup: 'mmstack',
                color: 'primary',
                properties: [
                  ['items', '3'],
                  ['flag', 'true'],
                  ['who', 'me'],
                ],
              },
            },
          },
        ],
      ]);
      expect(timeStamp).not.toHaveBeenCalled();
    });

    it('rich: clears each emitted label once, in a microtask after the burst', async () => {
      const sink = make({ mode: 'rich' });
      sink.capture?.('a', {});
      sink.capture?.('b', {});
      sink.capture?.('a', {});
      expect(clear).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(clear.mock.calls).toEqual([['a'], ['b']]);

      sink.capture?.('c', {}); // a new burst schedules a new clear
      await Promise.resolve();
      expect(clear.mock.calls).toEqual([['a'], ['b'], ['c']]);
    });

    it('cheap: retains nothing, so there is nothing to clear', async () => {
      make({ mode: 'cheap' }).capture?.('a', {});
      await Promise.resolve();
      expect(clear).not.toHaveBeenCalled();
    });
  });

  describe('seeding', () => {
    it('cheap: one zero-length entry per seed track at 0.003, in order, on factory success', () => {
      make({ mode: 'cheap', seed: ['Interactions', 'Spans', 'Findings'] });
      expect(timeStamp.mock.calls).toEqual([
        ['Interactions', 0.003, 0.003, 'Interactions', 'mmstack'],
        ['Spans', 0.003, 0.003, 'Spans', 'mmstack'],
        ['Findings', 0.003, 0.003, 'Findings', 'mmstack'],
      ]);
    });

    it('rich: seeds as measures on the named tracks', () => {
      make({ mode: 'rich', group: 'g', seed: ['A', 'B'] });
      const seeded = (track: string) => [
        track,
        {
          start: 0.003,
          end: 0.003,
          detail: {
            devtools: { dataType: 'track-entry', track, trackGroup: 'g' },
          },
        },
      ];
      expect(measure.mock.calls).toEqual([seeded('A'), seeded('B')]);
    });

    it('seeds Spans, Events, Findings by default', () => {
      devtoolsSink({ mode: 'cheap' })();
      expect(timeStamp.mock.calls).toEqual([
        ['Spans', 0.003, 0.003, 'Spans', 'mmstack'],
        ['Events', 0.003, 0.003, 'Events', 'mmstack'],
        ['Findings', 0.003, 0.003, 'Findings', 'mmstack'],
      ]);
    });

    it('a configured seed replaces the default entirely; [] seeds nothing', () => {
      devtoolsSink({ mode: 'cheap', seed: ['Only'] })();
      devtoolsSink({ mode: 'cheap', seed: [] })();
      expect(timeStamp.mock.calls).toEqual([
        ['Only', 0.003, 0.003, 'Only', 'mmstack'],
      ]);
    });

    it('seeds nothing when the factory returns null', () => {
      vi.stubGlobal('window', undefined);
      devtoolsSink({ mode: 'cheap' })();
      devtoolsSink({ mode: 'cheap', seed: ['A'] })();
      expect(timeStamp).not.toHaveBeenCalled();
    });
  });

  describe('track and colour', () => {
    const tracksAndColors = () =>
      timeStamp.mock.calls.map((c) => [c[0], c[3], c[5]]);

    it('buckets by kind, a string attrs.track overrides the bucket, colours by kind', () => {
      const sink = make({ mode: 'cheap' });
      sink.startSpan?.('checkout.submit', CTX, {}, ORIGIN).end(ORIGIN);
      sink.startSpan?.('load page', CTX, {}, ORIGIN).end(ORIGIN);
      sink
        .startSpan?.('pinned', CTX, { track: 'Interactions' }, ORIGIN)
        .end(ORIGIN);
      sink.startSpan?.('not-a-string', CTX, { track: 1 }, ORIGIN).end(ORIGIN);
      const failed = sink.startSpan?.('fails', CTX, {}, ORIGIN);
      failed?.setError(new Error('x'));
      failed?.end(ORIGIN);
      sink.capture?.('cart.add', {});
      sink.capture?.('ping', { track: 'Pings' });
      const finding = { path: 'p', message: 'm', fingerprint: 'F|p|' };
      sink.recordFinding?.({ ...finding, code: 'I', severity: 'info' }, {});
      sink.recordFinding?.({ ...finding, code: 'W', severity: 'warn' }, {});
      sink.recordFinding?.(
        { ...finding, code: 'E', severity: 'error' },
        { track: 'Lint' },
      );

      expect(tracksAndColors()).toEqual([
        ['checkout.submit', 'Spans', 'primary'],
        ['load page', 'Spans', 'primary'],
        ['pinned', 'Interactions', 'primary'],
        ['not-a-string', 'Spans', 'primary'],
        ['fails', 'Spans', 'error'],
        ['cart.add', 'Events', 'secondary'],
        ['ping', 'Pings', 'secondary'],
        ['I: m', 'Findings', 'tertiary'],
        ['W: m', 'Findings', 'warning'],
        ['E: m', 'Lint', 'error'],
      ]);
    });

    it('custom track and color callbacks win over everything, and see the pinned input', () => {
      const seen: unknown[] = [];
      const sink = make({
        mode: 'cheap',
        track: (input) => {
          seen.push(input);
          return `T-${input.kind}`;
        },
        color: (input) =>
          input.error
            ? 'warning'
            : input.kind === 'finding'
              ? 'tertiary-dark'
              : 'primary-light',
      });
      sink.startSpan?.('ok', CTX, { track: 'Ignored' }, ORIGIN).end(ORIGIN);
      const failed = sink.startSpan?.('s.x', CTX, { a: 1 }, ORIGIN);
      failed?.setError(new Error('x'));
      failed?.end(ORIGIN);
      sink.capture?.('e.x', { b: 2 });
      sink.recordFinding?.(
        {
          code: 'C',
          severity: 'error',
          path: 'p',
          node: 'n',
          message: 'm',
          fingerprint: 'C|p|n',
        },
        { c: 3 },
      );

      expect(tracksAndColors()).toEqual([
        ['ok', 'T-span', 'primary-light'],
        ['s.x', 'T-span', 'warning'],
        ['e.x', 'T-event', 'primary-light'],
        ['C: m', 'T-finding', 'tertiary-dark'],
      ]);
      expect(seen).toEqual([
        { kind: 'span', name: 'ok', attrs: { track: 'Ignored' } },
        { kind: 'span', name: 's.x', attrs: { a: 1 }, error: true },
        { kind: 'event', name: 'e.x', attrs: { b: 2 } },
        {
          kind: 'finding',
          name: 'C',
          attrs: {
            c: 3,
            code: 'C',
            severity: 'error',
            path: 'p',
            node: 'n',
            fingerprint: 'C|p|n',
          },
        },
      ]);
      // error is absent (not false) on a span that did not fail
      expect(Object.keys(seen[0] as object)).toEqual(['kind', 'name', 'attrs']);
    });
  });

  describe('findings', () => {
    it('renders a zero-length entry with code: message label, message tooltip and finding properties', () => {
      vi.spyOn(Date, 'now').mockReturnValue(ORIGIN + 42);
      const telemetry = viaFacade(make({ mode: 'rich' }));
      telemetry.finding('UNBOUND_FIELD', {
        severity: 'warn',
        path: 'pages.checkout.form',
        node: 'email',
        message: 'Bind the field to a model property.',
        data: { rule: 'binding' },
      });
      expect(measure.mock.calls).toEqual([
        [
          'UNBOUND_FIELD: Bind the field to a model property.',
          {
            start: 42,
            end: 42,
            detail: {
              devtools: {
                dataType: 'track-entry',
                track: 'Findings',
                trackGroup: 'mmstack',
                color: 'warning',
                tooltipText: 'Bind the field to a model property.',
                properties: [
                  ['rule', 'binding'],
                  ['code', 'UNBOUND_FIELD'],
                  ['severity', 'warn'],
                  ['path', 'pages.checkout.form'],
                  ['node', 'email'],
                  ['fingerprint', 'UNBOUND_FIELD|pages.checkout.form|email'],
                ],
              },
            },
          },
        ],
      ]);
    });

    it('omits node when the finding has none', () => {
      make({ mode: 'rich' }).recordFinding?.(
        {
          code: 'C',
          severity: 'info',
          path: 'p',
          message: 'm',
          fingerprint: 'C|p|',
        },
        {},
      );
      const detail = measure.mock.calls[0][1].detail.devtools;
      expect(detail.properties).toEqual([
        ['code', 'C'],
        ['severity', 'info'],
        ['path', 'p'],
        ['fingerprint', 'C|p|'],
      ]);
    });

    it('truncates the label to 120 characters; the tooltip keeps the whole message', () => {
      const message = 'x'.repeat(200);
      make({ mode: 'rich' }).recordFinding?.(
        {
          code: 'LONG',
          severity: 'info',
          path: 'p',
          message,
          fingerprint: 'LONG|p|',
        },
        {},
      );
      const [label, options] = measure.mock.calls[0];
      expect(label).toHaveLength(120);
      expect(label).toBe(`LONG: ${'x'.repeat(113)}…`);
      expect(options.detail.devtools.tooltipText).toBe(message);
    });

    it('keeps a label of exactly 120 characters whole', () => {
      const message = 'y'.repeat(114); // 'CODE: ' is 6 chars
      make({ mode: 'cheap' }).recordFinding?.(
        {
          code: 'CODE',
          severity: 'info',
          path: 'p',
          message,
          fingerprint: 'CODE|p|',
        },
        {},
      );
      expect(timeStamp.mock.calls[0][0]).toBe(`CODE: ${message}`);
    });
  });
});
