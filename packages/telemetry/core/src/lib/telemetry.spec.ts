import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  allowOnly,
  compose,
  deny,
  hashKeys,
  redactKeys,
  type AttrMeta,
  type AttributePolicy,
} from './attrs';
import { memorySink } from './memory-sink';
import { provideTelemetry } from './provide';
import { type Sink } from './sink';
import { TELEMETRY } from './telemetry';

describe('@mmstack/telemetry-core', () => {
  function setup(opt?: {
    policy?: Parameters<typeof provideTelemetry>[0]['policy'];
  }) {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink], policy: opt?.policy })],
    });
    return { sink, telemetry: TestBed.inject(TELEMETRY) };
  }

  it('routes event / metric / error to the sink', () => {
    const { sink, telemetry } = setup();
    telemetry.event('checkout', { plan: 'pro' });
    telemetry.metric('items', 3, { plan: 'pro' });
    telemetry.error(new Error('boom'), { where: 'x' });

    expect(sink.events).toEqual([{ name: 'checkout', attrs: { plan: 'pro' } }]);
    expect(sink.metrics).toEqual([
      { name: 'items', value: 3, attrs: { plan: 'pro' } },
    ]);
    expect(sink.errors.length).toBe(1);
    expect((sink.errors[0].err as Error).message).toBe('boom');
  });

  it('routes a structured log line with its severity and an emit-time timestamp', () => {
    const { sink, telemetry } = setup();
    telemetry.log('warn', 'cache miss', { key: 'todos' });

    expect(sink.logs).toEqual([
      {
        severity: 'warn',
        body: 'cache miss',
        attrs: { key: 'todos' },
        timestamp: expect.any(Number),
      },
    ]);
  });

  it('forwards the metric instrument kind to the sink', () => {
    const { sink, telemetry } = setup();
    telemetry.metric('latency', 12, undefined, { kind: 'histogram' });
    telemetry.metric('signups', 1, undefined, { kind: 'counter' });

    expect(sink.metrics.map((m) => [m.name, m.kind])).toEqual([
      ['latency', 'histogram'],
      ['signups', 'counter'],
    ]);
  });

  it('auto-correlates a log emitted inside a span', () => {
    const { sink, telemetry } = setup();
    telemetry.span('op', () => telemetry.log('info', 'inside'));

    const log = sink.logs.find((l) => l.body === 'inside')!;
    const span = sink.spans.find((s) => s.name === 'op')!;
    expect(log.attrs).toMatchObject({
      trace_id: span.ctx.traceId,
      span_id: span.ctx.spanId,
    });
  });

  it('applies the AttributePolicy per emit (allowOnly strips the rest)', () => {
    const { sink, telemetry } = setup({ policy: allowOnly(['plan']) });
    telemetry.event('e', { plan: 'pro', email: 'a@b.c' });
    expect(sink.events[0].attrs).toEqual({ plan: 'pro' });
  });

  it('span: records, ends, runs the body, returns its value, merges setAttrs', () => {
    const { sink, telemetry } = setup();
    const out = telemetry.span(
      'work',
      (s) => {
        s.setAttrs({ step: 1 });
        return 42;
      },
      { attrs: { a: 1 } },
    );
    expect(out).toBe(42);
    expect(sink.spans[0].name).toBe('work');
    expect(sink.spans[0].ended).toBe(true);
    expect(sink.spans[0].attrs).toEqual({ a: 1, step: 1 });
  });

  it('span: child shares the trace and links to the parent', () => {
    const { sink, telemetry } = setup();
    telemetry.span('parent', (p) => {
      telemetry.span('child', () => undefined, { parent: p });
    });
    const [parent, child] = sink.spans;
    expect(child.ctx.traceId).toBe(parent.ctx.traceId);
    expect(child.ctx.parentSpanId).toBe(parent.ctx.spanId);
  });

  it('span: ends on promise settle and propagates the value', async () => {
    const { sink, telemetry } = setup();
    const v = await telemetry.span('async', async () => 'done');
    expect(v).toBe('done');
    expect(sink.spans[0].ended).toBe(true);
  });

  it('span: records a thrown error and rethrows', () => {
    const { sink, telemetry } = setup();
    expect(() =>
      telemetry.span('boom', () => {
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(sink.spans[0].error).toBeInstanceOf(Error);
    expect(sink.spans[0].ended).toBe(true);
  });

  it('noop when no sinks: disabled, captures nothing, still runs the span body', () => {
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);
    expect(telemetry.enabled()).toBe(false);

    let ran = false;
    const out = telemetry.span('x', () => {
      ran = true;
      return 7;
    });
    expect(ran).toBe(true);
    expect(out).toBe(7);
  });

  it('default (no provideTelemetry) injects the noop', () => {
    TestBed.configureTestingModule({});
    const telemetry = TestBed.inject(TELEMETRY);
    expect(telemetry.enabled()).toBe(false);
    expect(telemetry.span('x', () => 1)).toBe(1);
  });

  it('buffers telemetry while a sink is not ready, then flushes on ready', () => {
    const ready = signal(false);
    const sink = memorySink('m', ready);
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    telemetry.event('e', { a: 1 });
    telemetry.span('s', () => undefined);
    expect(sink.events.length).toBe(0); // buffered, not yet flushed
    expect(sink.spans.length).toBe(0);

    ready.set(true);
    TestBed.tick(); // flush the readiness effect

    expect(sink.events).toEqual([{ name: 'e', attrs: { a: 1 } }]);
    expect(sink.spans.length).toBe(1);
    expect(sink.spans[0].ended).toBe(true);
  });

  it('drops buffered telemetry if a sink never becomes ready (timeout)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const ready = signal(false);
      const sink = memorySink('m', ready);
      TestBed.configureTestingModule({
        providers: [provideTelemetry({ sinks: [sink], readyTimeoutMs: 1000 })],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      telemetry.event('e', { a: 1 });
      vi.advanceTimersByTime(1001); // past the ready timeout → dropped

      ready.set(true);
      TestBed.tick();

      expect(sink.events.length).toBe(0); // dropped, never flushed
      expect(warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});

describe('readiness buffering (deep)', () => {
  /** Records every sink call into one ordered list, across capability kinds. */
  function orderedSink(ready: Signal<boolean>, name = 'ordered') {
    const calls: string[] = [];
    const sink: Sink = {
      name,
      ready,
      capture: (n) => calls.push(`event:${n}`),
      record: (n, v) => calls.push(`metric:${n}=${v}`),
      recordError: (e) => calls.push(`error:${(e as Error).message}`),
      emitLog: (r) => calls.push(`log:${r.body}`),
      startSpan: (n) => {
        calls.push(`span:${n}`);
        return {
          setAttrs: () => calls.push(`span:${n}:attrs`),
          setError: () => calls.push(`span:${n}:error`),
          end: () => calls.push(`span:${n}:end`),
        };
      },
    };
    return { sink, calls };
  }

  it('flushes buffered telemetry in emission order, across kinds', () => {
    const ready = signal(false);
    const { sink, calls } = orderedSink(ready);
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    telemetry.event('a');
    telemetry.metric('b', 1);
    telemetry.log('info', 'c');
    telemetry.error(new Error('d'));
    telemetry.span('e', () => undefined);
    expect(calls).toEqual([]);

    ready.set(true);
    TestBed.tick();

    expect(calls).toEqual([
      'event:a',
      'metric:b=1',
      'log:c',
      'error:d',
      'span:e',
      'span:e:end',
    ]);
  });

  it('replays a buffered span faithfully: merged attrs, error, ended — nothing before ready', () => {
    const ready = signal(false);
    const sink = memorySink('m', ready);
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    const handle = telemetry.startSpan('op', { attrs: { a: 1 } });
    handle.setAttrs({ step: 1 });
    handle.setAttrs({ step: 2, extra: true }); // last write per key wins
    const boom = new Error('boom');
    handle.setError(boom);
    handle.end();
    expect(sink.spans).toEqual([]); // zero sink activity while pending

    ready.set(true);
    TestBed.tick();

    expect(sink.spans.length).toBe(1);
    const span = sink.spans[0];
    expect(span.name).toBe('op');
    expect(span.attrs).toEqual({ a: 1, step: 2, extra: true });
    expect(span.error).toBe(boom);
    expect(span.ended).toBe(true);
  });

  it('routes span ops issued after the flush directly to the live span', () => {
    const ready = signal(false);
    const sink = memorySink('m', ready);
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    const handle = telemetry.startSpan('op');
    ready.set(true);
    TestBed.tick();
    expect(sink.spans[0].ended).toBe(false);

    handle.setAttrs({ late: 1 });
    handle.end();
    expect(sink.spans[0].attrs).toEqual({ late: 1 });
    expect(sink.spans[0].ended).toBe(true);
  });

  it('the dropped buffer never resurrects: post-drop ops and a later ready deliver nothing buffered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const ready = signal(false);
      const sink = memorySink('m', ready);
      TestBed.configureTestingModule({
        providers: [provideTelemetry({ sinks: [sink], readyTimeoutMs: 50 })],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      const handle = telemetry.startSpan('op');
      telemetry.event('e');
      vi.advanceTimersByTime(51);

      handle.setAttrs({ post: 1 }); // ops after the drop are discarded too
      handle.end();
      ready.set(true);
      TestBed.tick();

      expect(sink.spans).toEqual([]);
      expect(sink.events).toEqual([]);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('gates readiness per sink: a ready sink receives immediately, a timed-out one drops alone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const live = memorySink('live');
      const pendingReady = signal(false);
      const pending = memorySink('pending', pendingReady);
      TestBed.configureTestingModule({
        providers: [
          provideTelemetry({ sinks: [live, pending], readyTimeoutMs: 50 }),
        ],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      telemetry.event('e');
      expect(live.events.length).toBe(1); // synchronous, no tick needed
      expect(pending.events.length).toBe(0);

      vi.advanceTimersByTime(51);
      pendingReady.set(true);
      TestBed.tick();

      expect(pending.events.length).toBe(0); // dropped
      expect(live.events.length).toBe(1); // unaffected
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('readiness is a one-way latch: flipping back to not-ready keeps delivering', () => {
    const ready = signal(true);
    const sink = memorySink('m', ready);
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    telemetry.event('first');
    ready.set(false);
    TestBed.tick();
    telemetry.event('second');

    expect(sink.events.map((e) => e.name)).toEqual(['first', 'second']);
  });

  it('flushes exactly once: later ticks and ready churn do not re-deliver', () => {
    const ready = signal(false);
    const sink = memorySink('m', ready);
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    telemetry.event('e');
    ready.set(true);
    TestBed.tick();
    TestBed.tick();
    ready.set(false);
    TestBed.tick();
    ready.set(true);
    TestBed.tick();

    expect(sink.events.length).toBe(1);
  });
});

describe('AttributePolicy (deep)', () => {
  it('varies per sink and reports correct meta for every emit kind', () => {
    const metas: AttrMeta[] = [];
    const policy: AttributePolicy = (attrs, meta) => {
      metas.push(meta);
      return meta.sink === 'redacted' ? {} : attrs;
    };
    const full = memorySink('full');
    const redacted = memorySink('redacted');
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [full, redacted], policy })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    const attrs = { plan: 'pro' };
    telemetry.span('s', () => undefined, { attrs });
    telemetry.event('e', attrs);
    telemetry.error(new Error('boom'), attrs);
    telemetry.error('plain-value', attrs);
    telemetry.metric('m', 1, attrs);
    telemetry.log('info', 'msg', attrs);

    // one policy application per sink per emit
    expect(metas.length).toBe(12);
    const seen = metas
      .filter((m) => m.sink === 'full')
      .map((m) => `${m.kind}:${m.name}`);
    expect(seen).toEqual([
      'span:s',
      'event:e',
      'error:Error', // Error instances report their name
      'error:error', // non-Error throwables fall back to 'error'
      'metric:m',
      'log:msg', // logs use the message as the policy name
    ]);

    expect(full.events[0].attrs).toEqual({ plan: 'pro' });
    expect(redacted.events[0].attrs).toEqual({});
    expect(full.spans[0].attrs).toEqual({ plan: 'pro' });
    expect(redacted.spans[0].attrs).toEqual({});
    expect(redacted.errors.map((e) => e.attrs)).toEqual([{}, {}]);
    expect(redacted.metrics[0].attrs).toEqual({});
    expect(redacted.logs[0].attrs).toEqual({});
  });

  it('compose applies left-to-right (redact→hash differs from hash→redact)', () => {
    const hash = (v: unknown) => `#${String(v)}`;
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [
        provideTelemetry({
          sinks: [sink],
          policy: compose(redactKeys(['token'], () => 'X'), hashKeys(['token'], hash)),
        }),
      ],
    });
    TestBed.inject(TELEMETRY).event('e', { token: 'secret' });
    expect(sink.events[0].attrs).toEqual({ token: '#X' }); // redacted first, then hashed

    TestBed.resetTestingModule();
    const sink2 = memorySink();
    TestBed.configureTestingModule({
      providers: [
        provideTelemetry({
          sinks: [sink2],
          policy: compose(hashKeys(['token'], hash), redactKeys(['token'], () => 'X')),
        }),
      ],
    });
    TestBed.inject(TELEMETRY).event('e', { token: 'secret' });
    expect(sink2.events[0].attrs).toEqual({ token: 'X' }); // hash overwritten by redact
  });

  it('applies the policy on span setAttrs, not only at start', () => {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [
        provideTelemetry({ sinks: [sink], policy: allowOnly(['keep']) }),
      ],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    telemetry.span('s', (span) => span.setAttrs({ keep: 2, secret: 3 }), {
      attrs: { keep: 1, drop: 1 },
    });

    expect(sink.spans[0].attrs).toEqual({ keep: 2 });
  });

  it('allowOnly([]) empties the attrs but the emit still reaches the sink', () => {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink], policy: allowOnly([]) })],
    });
    TestBed.inject(TELEMETRY).event('e', { a: 1 });
    expect(sink.events).toEqual([{ name: 'e', attrs: {} }]);
  });

  it('runs after correlation injection: a policy can strip the auto trace ids', () => {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [
        provideTelemetry({ sinks: [sink], policy: deny(['trace_id', 'span_id']) }),
      ],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    telemetry.span('op', () => telemetry.event('inside', { a: 1 }));

    expect(sink.events[0].attrs).toEqual({ a: 1 }); // ids injected, then denied
  });
});

describe('active-span stack discipline', () => {
  function setup() {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    return { sink, telemetry: TestBed.inject(TELEMETRY) };
  }

  it('tracks the innermost span and restores the outer one when the inner returns', () => {
    const { sink, telemetry } = setup();

    telemetry.span('outer', (outer) => {
      expect(telemetry.activeSpan()).toBe(outer);
      telemetry.span('inner', (inner) => {
        expect(telemetry.activeSpan()).toBe(inner);
        telemetry.event('in-inner');
      });
      expect(telemetry.activeSpan()).toBe(outer);
      telemetry.event('in-outer');
    });
    expect(telemetry.activeSpan()).toBeUndefined();

    const outer = sink.spans.find((s) => s.name === 'outer')!;
    const inner = sink.spans.find((s) => s.name === 'inner')!;
    const inInner = sink.events.find((e) => e.name === 'in-inner')!;
    const inOuter = sink.events.find((e) => e.name === 'in-outer')!;
    expect(inInner.attrs).toEqual({
      trace_id: inner.ctx.traceId,
      span_id: inner.ctx.spanId,
    });
    expect(inOuter.attrs).toEqual({
      trace_id: outer.ctx.traceId,
      span_id: outer.ctx.spanId,
    });
  });

  it('pops the stack on throw: no stale active span, no stale correlation', () => {
    const { sink, telemetry } = setup();

    expect(() =>
      telemetry.span('boom', () => {
        throw new Error('x');
      }),
    ).toThrow('x');

    expect(telemetry.activeSpan()).toBeUndefined();
    telemetry.event('after', { a: 1 });
    expect(sink.events[0].attrs).toEqual({ a: 1 }); // no leaked trace_id
  });

  it('span() auto-nests under the active span; parent: null forces a fresh root', () => {
    const { sink, telemetry } = setup();
    telemetry.span('outer', () => {
      telemetry.span('inner', () => undefined); // no parent → joins the active span's trace
      telemetry.span('detached', () => undefined, { parent: null }); // explicit opt-out
    });

    const outer = sink.spans.find((s) => s.name === 'outer')!;
    const inner = sink.spans.find((s) => s.name === 'inner')!;
    const detached = sink.spans.find((s) => s.name === 'detached')!;
    expect(inner.ctx.traceId).toBe(outer.ctx.traceId);
    expect(inner.ctx.parentSpanId).toBe(outer.ctx.spanId);
    expect(detached.ctx.traceId).not.toBe(outer.ctx.traceId);
    expect(detached.ctx.parentSpanId).toBeUndefined();
  });

  it('startSpan() never auto-nests: manual spans parent only explicitly', () => {
    const { sink, telemetry } = setup();
    telemetry.span('outer', () => {
      telemetry.startSpan('manual').end();
    });

    const outer = sink.spans.find((s) => s.name === 'outer')!;
    const manual = sink.spans.find((s) => s.name === 'manual')!;
    expect(manual.ctx.traceId).not.toBe(outer.ctx.traceId);
    expect(manual.ctx.parentSpanId).toBeUndefined();
  });
});

describe('id generation', () => {
  it('mints W3C-shaped, distinct ids per span', () => {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    telemetry.span('a', (a) => {
      telemetry.span('child', () => undefined, { parent: a });
    });
    telemetry.span('b', () => undefined);

    const [a, child, b] = sink.spans;
    for (const span of [a, child, b]) {
      expect(span.ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(a.ctx.traceId).not.toBe(b.ctx.traceId); // independent spans = independent traces
    expect(child.ctx.spanId).not.toBe(a.ctx.spanId); // child gets its own span id
    expect(child.ctx.traceId).toBe(a.ctx.traceId);
  });
});

describe('correlation across every emit kind', () => {
  it('injects trace ids into error() and metric() emitted inside a span, not just events/logs', () => {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    telemetry.span('op', () => {
      telemetry.error(new Error('boom'), { where: 'x' });
      telemetry.metric('m', 1, { a: 1 });
    });

    const span = sink.spans[0];
    const ids = { trace_id: span.ctx.traceId, span_id: span.ctx.spanId };
    expect(sink.errors[0].attrs).toEqual({ where: 'x', ...ids });
    expect(sink.metrics[0].attrs).toEqual({ a: 1, ...ids });
  });
});

describe('fault isolation (telemetry must never break the app)', () => {
  function throwingSink(name: string): Sink {
    return {
      name,
      ready: signal(true).asReadonly(),
      capture: () => {
        throw new Error(`${name} capture failed`);
      },
      startSpan: () => ({
        setAttrs: () => undefined,
        setError: () => {
          throw new Error(`${name} setError failed`);
        },
        end: () => undefined,
      }),
    };
  }

  it('a throwing sink does not break the caller, and healthy sinks still receive', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const good = memorySink('good');
      TestBed.configureTestingModule({
        providers: [provideTelemetry({ sinks: [throwingSink('bad'), good] })],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      expect(() => telemetry.event('e', { a: 1 })).not.toThrow();
      expect(good.events).toEqual([{ name: 'e', attrs: { a: 1 } }]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a throwing setError does not mask the original error thrown from a span body', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      TestBed.configureTestingModule({
        providers: [provideTelemetry({ sinks: [throwingSink('bad')] })],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      expect(() =>
        telemetry.span('op', () => {
          throw new Error('original');
        }),
      ).toThrow('original'); // not "bad setError failed"
    } finally {
      warn.mockRestore();
    }
  });

  it('a flush keeps going past a throwing delivery', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ready = signal(false);
      const delivered: string[] = [];
      let first = true;
      const flaky: Sink = {
        name: 'flaky',
        ready,
        capture: (n) => {
          if (first) {
            first = false;
            throw new Error('one-off');
          }
          delivered.push(n);
        },
      };
      TestBed.configureTestingModule({
        providers: [provideTelemetry({ sinks: [flaky] })],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      telemetry.event('a');
      telemetry.event('b');
      ready.set(true);
      TestBed.tick();

      expect(delivered).toEqual(['b']); // a threw, b still flushed
    } finally {
      warn.mockRestore();
    }
  });

  it('a throwing AttributePolicy skips that sink and spares the caller and other sinks', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const a = memorySink('a');
      const b = memorySink('b');
      TestBed.configureTestingModule({
        providers: [
          provideTelemetry({
            sinks: [a, b],
            policy: (attrs, meta) => {
              if (meta.sink === 'a') throw new Error('policy bug');
              return attrs;
            },
          }),
        ],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      expect(() => telemetry.event('e', { x: 1 })).not.toThrow();
      expect(a.events).toEqual([]);
      expect(b.events).toEqual([{ name: 'e', attrs: { x: 1 } }]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a throwing sink factory is skipped; remaining sinks still activate', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const good = memorySink('good');
      TestBed.configureTestingModule({
        providers: [
          provideTelemetry({
            sinks: [
              () => {
                throw new Error('factory bug');
              },
              good,
            ],
          }),
        ],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      expect(telemetry.enabled()).toBe(true);
      telemetry.event('e');
      expect(good.events.length).toBe(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('falsy sink entries and null-returning factories degrade to noop without crashing', () => {
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [null, undefined, () => null] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    expect(telemetry.enabled()).toBe(false);
    expect(() => telemetry.event('e')).not.toThrow();
  });
});

describe('buffering: order, time, resume, teardown', () => {
  it('interleaves buffered span ops with other emits in true FIFO order', () => {
    const ready = signal(false);
    const calls: string[] = [];
    const sink: Sink = {
      name: 'ordered',
      ready,
      capture: (n) => calls.push(`event:${n}`),
      startSpan: (n) => {
        calls.push(`span:${n}`);
        return {
          setAttrs: () => calls.push(`span:${n}:attrs`),
          setError: () => undefined,
          end: () => calls.push(`span:${n}:end`),
        };
      },
    };
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    const handle = telemetry.startSpan('s');
    telemetry.event('e');
    handle.end();

    ready.set(true);
    TestBed.tick();

    expect(calls).toEqual(['span:s', 'event:e', 'span:s:end']); // end AFTER the event that preceded it
  });

  it('replays buffered spans and logs with their true emit-time clocks, not the flush time', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const ready = signal(false);
      const sink = memorySink('m', ready);
      TestBed.configureTestingModule({
        providers: [provideTelemetry({ sinks: [sink], readyTimeoutMs: 60_000 })],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      const handle = telemetry.startSpan('op');
      telemetry.log('info', 'early');
      vi.setSystemTime(10_100);
      handle.end();

      vi.setSystemTime(15_000); // sink becomes ready much later
      ready.set(true);
      TestBed.tick();

      expect(sink.spans[0].startMs).toBe(10_000);
      expect(sink.spans[0].endMs).toBe(10_100);
      expect(sink.logs[0].timestamp).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes live delivery when a sink becomes ready after the drop timeout', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const ready = signal(false);
      const sink = memorySink('slow', ready);
      TestBed.configureTestingModule({
        providers: [provideTelemetry({ sinks: [sink], readyTimeoutMs: 1000 })],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      telemetry.event('buffered');
      vi.advanceTimersByTime(1001); // buffer dropped

      ready.set(true);
      TestBed.tick();
      telemetry.event('after-ready');

      expect(sink.events).toEqual([{ name: 'after-ready', attrs: {} }]); // startup window lost, session alive
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('injector destroy cancels the drop timer and silences the pending buffer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const ready = signal(false);
      const sink = memorySink('m', ready);
      TestBed.configureTestingModule({
        providers: [provideTelemetry({ sinks: [sink], readyTimeoutMs: 1000 })],
      });
      TestBed.inject(TELEMETRY).event('e');

      TestBed.resetTestingModule(); // destroys the environment injector
      vi.advanceTimersByTime(2000);

      expect(warn).not.toHaveBeenCalled(); // timer was cancelled, no orphan drop warning
      expect(sink.events).toEqual([]);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('disposes sinks when the providing injector is destroyed', () => {
    let disposed = 0;
    const sink: Sink = {
      name: 'd',
      ready: signal(true).asReadonly(),
      capture: () => undefined,
      dispose: () => {
        disposed++;
      },
    };
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    TestBed.inject(TELEMETRY);

    TestBed.resetTestingModule();
    expect(disposed).toBe(1);
  });
});

describe('async span settle', () => {
  it('treats a non-Promise thenable as async: the span ends on settle', async () => {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    let resolve!: (v: number) => void;
    const inner = new Promise<number>((r) => (resolve = r));
    const thenable = {
      then: (res: (v: number) => unknown, rej: (e: unknown) => unknown) => inner.then(res, rej),
    };

    const out = telemetry.span('t', () => thenable) as unknown as Promise<number>;
    expect(sink.spans[0].ended).toBe(false); // still open after the sync return

    resolve(7);
    await expect(out).resolves.toBe(7);
    expect(sink.spans[0].ended).toBe(true);
  });

  it('records a thenable rejection and rethrows it', async () => {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);

    const boom = new Error('late');
    const inner = Promise.reject(boom);
    const thenable = {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => inner.then(res, rej),
    };

    const out = telemetry.span('t', () => thenable) as unknown as Promise<unknown>;
    await expect(out).rejects.toBe(boom);
    expect(sink.spans[0].error).toBe(boom);
    expect(sink.spans[0].ended).toBe(true);
  });
});

describe('category without consent config', () => {
  it('is inert: accepted, not gated, and never leaked into the attrs', () => {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    TestBed.inject(TELEMETRY).event('e', { a: 1 }, { category: 'product-analytics' });
    expect(sink.events).toEqual([{ name: 'e', attrs: { a: 1 } }]);
  });
});
