import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { allowOnly, deny, type AttrMeta, type Attrs } from './attrs';
import { fingerprintOf, type FindingSpec } from './finding';
import { memorySink } from './memory-sink';
import { provideTelemetry } from './provide';
import { type Sink } from './sink';
import { TELEMETRY, type TelemetryConfig } from './telemetry';

const SPEC: FindingSpec = {
  severity: 'warn',
  path: 'pages.home.form',
  node: 'email',
  message: 'Bind the field to a model property.',
  data: { rule: 'unbound' },
};

function setup(sinks: Sink[], config: Omit<TelemetryConfig, 'sinks'> = {}) {
  TestBed.configureTestingModule({
    providers: [provideTelemetry({ sinks, ...config })],
  });
  return TestBed.inject(TELEMETRY);
}

function captureOnlySink(name = 'capture-only') {
  const events: { name: string; attrs?: Attrs }[] = [];
  const sink: Sink = {
    name,
    ready: signal(true).asReadonly(),
    capture: (eventName, attrs) => events.push({ name: eventName, attrs }),
  };
  return { sink, events };
}

describe('findings', () => {
  it('fingerprint is code|path|node, stable, and empty-tailed without a node', () => {
    expect(fingerprintOf('C', 'a.b', 'n')).toBe('C|a.b|n');
    expect(fingerprintOf('C', 'a.b')).toBe('C|a.b|');
    expect(fingerprintOf('C', 'a.b', 'n')).toBe(fingerprintOf('C', 'a.b', 'n'));
    expect(fingerprintOf('C', 'a.b', 'n')).not.toBe(
      fingerprintOf('C', 'a.b', 'm'),
    );
  });

  it('dispatches to recordFinding with the built finding and merged attrs — not to capture', () => {
    const sink = memorySink();
    const telemetry = setup([sink]);
    telemetry.finding('UNBOUND', SPEC);

    expect(sink.findings).toEqual([
      {
        finding: {
          ...SPEC,
          code: 'UNBOUND',
          fingerprint: 'UNBOUND|pages.home.form|email',
        },
        attrs: { rule: 'unbound' },
      },
    ]);
    expect(sink.events).toEqual([]); // recordFinding wins over the event fallback
  });

  it('falls back to a finding.<code> event on sinks that only capture', () => {
    const { sink, events } = captureOnlySink();
    const telemetry = setup([sink]);
    telemetry.finding('UNBOUND', SPEC);
    telemetry.finding('NO_NODE', {
      severity: 'error',
      path: 'p',
      message: 'm',
    });

    expect(events).toEqual([
      {
        name: 'finding.UNBOUND',
        attrs: {
          rule: 'unbound',
          'finding.code': 'UNBOUND',
          'finding.severity': 'warn',
          'finding.path': 'pages.home.form',
          'finding.node': 'email',
          'finding.fingerprint': 'UNBOUND|pages.home.form|email',
          'finding.message': 'Bind the field to a model property.',
        },
      },
      {
        name: 'finding.NO_NODE',
        attrs: {
          'finding.code': 'NO_NODE',
          'finding.severity': 'error',
          'finding.path': 'p',
          'finding.fingerprint': 'NO_NODE|p|',
          'finding.message': 'm',
        },
      },
    ]);
    expect(events[1].attrs).not.toHaveProperty('finding.node');
  });

  it('skips sinks with neither recordFinding nor capture (the policy never runs for them)', () => {
    const metas: AttrMeta[] = [];
    const record = vi.fn();
    const metricsOnly: Sink = {
      name: 'metrics',
      ready: signal(true).asReadonly(),
      record,
    };
    const memory = memorySink();
    const telemetry = setup([metricsOnly, memory], {
      policy: (attrs, meta) => {
        metas.push(meta);
        return attrs;
      },
    });
    telemetry.finding('F', SPEC);

    expect(metas).toEqual([{ kind: 'finding', name: 'F', sink: 'memory' }]);
    expect(record).not.toHaveBeenCalled();
    expect(memory.findings.length).toBe(1);
  });

  it('runs the policy with kind finding, and delivers its output as attrs (both paths)', () => {
    const memory = memorySink();
    const { sink: fallback, events } = captureOnlySink();
    const telemetry = setup([memory, fallback], { policy: deny(['secret']) });
    telemetry.finding('F', { ...SPEC, data: { rule: 'r', secret: 'x' } });

    expect(memory.findings[0].attrs).toEqual({ rule: 'r' });
    expect(events[0].attrs).not.toHaveProperty('secret');
    expect(events[0].attrs).toMatchObject({ rule: 'r', 'finding.code': 'F' });
  });

  it('a policy that denies every attr still delivers the finding with its own fields intact', () => {
    const memory = memorySink();
    const telemetry = setup([memory], { policy: allowOnly([]) });
    telemetry.finding('UNBOUND', SPEC);

    expect(memory.findings).toEqual([
      {
        finding: {
          ...SPEC,
          code: 'UNBOUND',
          fingerprint: 'UNBOUND|pages.home.form|email',
        },
        attrs: {},
      },
    ]);
  });

  it('honours consent like event(): an undecided category drops, a grant delivers', () => {
    const sink = memorySink();
    const telemetry = setup([sink], {
      consent: {
        requirements: [
          { id: 'q', category: 'quality', purpose: 'issue reports' },
        ],
      },
    });
    telemetry.finding('F', SPEC, { category: 'quality' });
    expect(sink.findings).toEqual([]);

    telemetry.decide('q', true);
    telemetry.finding('F', SPEC, { category: 'quality' });
    expect(sink.findings.length).toBe(1);

    telemetry.decide('q', false);
    telemetry.finding('F', SPEC, { category: 'quality' });
    expect(sink.findings.length).toBe(1);
  });

  it('injects correlation ids inside a span and for an explicit parent', () => {
    const sink = memorySink();
    const telemetry = setup([sink]);
    telemetry.span('check', () => telemetry.finding('INSIDE', SPEC));
    const manual = telemetry.startSpan('manual');
    telemetry.finding('PARENTED', SPEC, { parent: manual });
    manual.end();

    const [check, man] = sink.spans;
    expect(sink.findings[0].attrs).toEqual({
      rule: 'unbound',
      trace_id: check.ctx.traceId,
      span_id: check.ctx.spanId,
    });
    expect(sink.findings[1].attrs).toMatchObject({
      trace_id: man.ctx.traceId,
      span_id: man.ctx.spanId,
    });
  });

  it('buffers while a sink is not ready and replays in order on ready (both paths)', () => {
    const ready = signal(false);
    const memory = memorySink('m', ready);
    const events: string[] = [];
    const fallback: Sink = {
      name: 'fallback',
      ready,
      capture: (name) => events.push(name),
    };
    const telemetry = setup([memory, fallback]);
    telemetry.event('first');
    telemetry.finding('F', SPEC);
    telemetry.event('last');
    expect(memory.findings).toEqual([]);
    expect(events).toEqual([]);

    ready.set(true);
    TestBed.tick();
    expect(memory.findings.map((r) => r.finding.code)).toEqual(['F']);
    expect(memory.events.map((e) => e.name)).toEqual(['first', 'last']);
    expect(events).toEqual(['first', 'finding.F', 'last']);

    TestBed.tick();
    expect(memory.findings.length).toBe(1); // flushed exactly once
  });

  it('memorySink records findings and reset() clears them with everything else', () => {
    const sink = memorySink();
    const telemetry = setup([sink]);
    telemetry.finding('A', SPEC);
    telemetry.finding('B', { severity: 'info', path: 'q', message: 'm' });
    telemetry.event('e');
    expect(sink.findings.map((r) => r.finding.fingerprint)).toEqual([
      'A|pages.home.form|email',
      'B|q|',
    ]);

    sink.reset();
    expect(sink.findings).toEqual([]);
    expect(sink.events).toEqual([]);
  });
});
