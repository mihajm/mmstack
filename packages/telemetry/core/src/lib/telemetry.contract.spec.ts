import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type AttrMeta, type AttributePolicy } from './attrs';
import { memorySink } from './memory-sink';
import { provideTelemetry } from './provide';
import { injectTelemetry, readSpan, TELEMETRY } from './telemetry';

const ZERO = { traceId: '0'.repeat(32), spanId: '0'.repeat(16) };

describe('noop service (no providers or no sinks)', () => {
  it('hands out an inert, zero-id span handle and empty consent state', () => {
    TestBed.configureTestingModule({});
    const t = TestBed.inject(TELEMETRY);

    expect(t.enabled()).toBe(false);
    expect(readSpan(t.startSpan('x'))).toEqual(ZERO);
    expect(t.requirements()).toEqual([]);
    expect(t.pending()).toEqual([]);
    expect(t.consent()).toEqual({});
    expect(() =>
      t.span('x', (h) => {
        expect(readSpan(h)).toEqual(ZERO);
        h.setAttrs({ a: 1 });
        h.setError(new Error('x'));
        h.end();
      }),
    ).not.toThrow();
  });

  it('injectTelemetry() resolves the TELEMETRY token', () => {
    TestBed.configureTestingModule({});
    const viaHelper = TestBed.runInInjectionContext(() => injectTelemetry());
    expect(viaHelper).toBe(TestBed.inject(TELEMETRY));
  });

  it('readSpan exposes the handle correlation ids', () => {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const h = TestBed.inject(TELEMETRY).startSpan('x');
    expect(readSpan(h)).toBe(h.ctx);
    expect(readSpan(h)).toEqual(sink.spans[0].ctx);
  });
});

describe('span() return values', () => {
  function setup() {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    return { sink, t: TestBed.inject(TELEMETRY) };
  }

  it('returns null and plain objects as is and ends the span at once', () => {
    const { sink, t } = setup();
    const o = { a: 1 };
    expect(t.span('n', () => null)).toBeNull();
    expect(t.span('o', () => o)).toBe(o);
    expect(sink.spans.map((s) => [s.name, s.ended])).toEqual([
      ['n', true],
      ['o', true],
    ]);
  });

  it('treats a thenable function as async: the span ends on settle', async () => {
    const { sink, t } = setup();
    let settle: (v: number) => void = () => undefined;
    const thenableFn = Object.assign(() => 0, {
      then: (resolve: (v: number) => unknown) =>
        new Promise((done) => {
          settle = (v) => done(resolve(v));
        }),
    });
    const out = t.span('f', () => thenableFn) as unknown as Promise<number>;
    expect(sink.spans[0].ended).toBe(false);
    settle(5);
    await expect(out).resolves.toBe(5);
    expect(sink.spans[0].ended).toBe(true);
  });
});

describe('readiness: live delivery and timers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers a new emit live after the pending to ready flush', () => {
    const ready = signal(false);
    const sink = memorySink('m', ready);
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const t = TestBed.inject(TELEMETRY);
    t.event('buffered');
    ready.set(true);
    TestBed.tick();

    t.event('live');
    t.span('s', () => undefined);
    expect(sink.events.map((e) => e.name)).toEqual(['buffered', 'live']);
    expect(sink.spans.map((s) => [s.name, s.ended])).toEqual([['s', true]]);
  });

  it('leaves no timer behind once a pending sink becomes ready', () => {
    vi.useFakeTimers();
    const ready = signal(false);
    TestBed.configureTestingModule({
      providers: [
        provideTelemetry({
          sinks: [memorySink('m', ready)],
          readyTimeoutMs: 1000,
        }),
      ],
    });
    TestBed.inject(TELEMETRY).event('e');
    TestBed.tick(); // settles the scheduler's own timers; only the ready timeout is left
    expect(vi.getTimerCount()).toBe(1);
    ready.set(true);
    TestBed.tick();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind when the injector is destroyed while pending', () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideTelemetry({
          sinks: [memorySink('m', signal(false))],
          readyTimeoutMs: 1000,
        }),
      ],
    });
    TestBed.inject(TELEMETRY).event('e');
    TestBed.tick();
    expect(vi.getTimerCount()).toBe(1);
    TestBed.resetTestingModule();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('AttributePolicy: skip on throw, meta per kind', () => {
  function setup(policy: AttributePolicy) {
    const a = memorySink('a');
    const b = memorySink('b');
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [a, b], policy })],
    });
    return { a, b, t: TestBed.inject(TELEMETRY) };
  }

  it('a policy that throws for one sink skips that sink for every emit kind', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { a, b, t } = setup((attrs, meta) => {
        if (meta.sink === 'a') throw new Error('policy bug');
        return attrs;
      });
      t.error(new Error('e'));
      t.metric('m', 1);
      t.log('info', 'l');
      t.identify('u1');
      t.finding('F', { severity: 'warn', path: 'p', message: 'm' });
      t.span('s', () => undefined);

      expect(a.errors).toEqual([]);
      expect(a.metrics).toEqual([]);
      expect(a.logs).toEqual([]);
      expect(a.identifies).toEqual([]);
      expect(a.findings).toEqual([]);
      expect(a.spans).toEqual([]);
      expect(b.errors.length).toBe(1);
      expect(b.metrics.length).toBe(1);
      expect(b.logs.length).toBe(1);
      expect(b.identifies.length).toBe(1);
      expect(b.findings.length).toBe(1);
      expect(b.spans.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('identify reports kind identify, named by user id or anonymous', () => {
    const metas: AttrMeta[] = [];
    const { t } = setup((attrs, meta) => {
      metas.push(meta);
      return attrs;
    });
    t.identify('u1', { plan: 'pro' });
    t.identify(null);
    expect(
      metas.filter((m) => m.sink === 'a').map((m) => `${m.kind}:${m.name}`),
    ).toEqual(['identify:u1', 'identify:anonymous']);
  });

  it('span setAttrs runs the policy with kind span', () => {
    const metas: AttrMeta[] = [];
    const { t } = setup((attrs, meta) => {
      metas.push(meta);
      return attrs;
    });
    t.span('s', (h) => h.setAttrs({ x: 1 }));
    expect(
      metas.filter((m) => m.sink === 'a').map((m) => `${m.kind}:${m.name}`),
    ).toEqual(['span:s', 'span:s']);
  });

  it('a policy throwing on setAttrs leaves the span attrs as they were', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let calls = 0;
      const { a, b, t } = setup((attrs, meta) => {
        if (meta.sink === 'a' && ++calls === 2) throw new Error('late');
        return attrs;
      });
      t.span('s', (h) => h.setAttrs({ x: 1 }), { attrs: { y: 2 } });
      expect(a.spans[0].attrs).toStrictEqual({ y: 2 });
      expect(b.spans[0].attrs).toStrictEqual({ y: 2, x: 1 });
      expect(a.spans[0].ended).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('setGlobalAttrs removal', () => {
  it('an undefined value removes the key from later emits', () => {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const t = TestBed.inject(TELEMETRY);
    t.setGlobalAttrs({ a: 1, b: 2 });
    t.setGlobalAttrs({ b: undefined, c: 3 });
    t.event('e');
    expect(sink.events[0].attrs).toStrictEqual({ a: 1, c: 3 });
  });
});
