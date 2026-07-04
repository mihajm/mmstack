import { TestBed } from '@angular/core/testing';
import { provideTelemetry, TELEMETRY } from '@mmstack/telemetry-core';
import { otelSink } from './otel-sink';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web';

describe('@mmstack/telemetry-otel', () => {
  function setup() {
    const exporter = new InMemorySpanExporter();
    const sink = otelSink({ processor: new SimpleSpanProcessor(exporter) });
    TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [sink] })] });
    return { exporter, telemetry: TestBed.inject(TELEMETRY) };
  }

  it('maps a facade span to an OTel span with name + attrs', () => {
    const { exporter, telemetry } = setup();
    telemetry.span('work', (s) => s.setAttrs({ step: 1 }), { attrs: { a: 'x' } });

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe('work');
    expect(spans[0].attributes).toMatchObject({ a: 'x', step: 1 });
  });

  it('shares one trace across parent/child (our ids minted onto OTel spans)', () => {
    const { exporter, telemetry } = setup();
    telemetry.span('parent', (p) => {
      telemetry.span('child', () => undefined, { parent: p });
    });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === 'parent');
    const child = spans.find((s) => s.name === 'child');
    expect(parent && child).toBeTruthy();
    expect(child!.spanContext().traceId).toBe(parent!.spanContext().traceId);
    expect(child!.parentSpanContext?.spanId).toBe(parent!.spanContext().spanId);
    // ids are OTel-shaped (32/16 hex)
    expect(parent!.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parent!.spanContext().spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('records the exception and sets ERROR status on throw', () => {
    const { exporter, telemetry } = setup();
    expect(() =>
      telemetry.span('boom', () => {
        throw new Error('x');
      }),
    ).toThrow('x');

    const span = exporter.getFinishedSpans()[0];
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('records metrics as the requested instrument kind', async () => {
    const reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 100_000, // long, so it never auto-flushes mid-test
    });
    const sink = otelSink({ metricReader: reader });
    TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [sink] })] });
    const telemetry = TestBed.inject(TELEMETRY);

    telemetry.metric('signups', 2, undefined, { kind: 'counter' });
    telemetry.metric('latency_ms', 12, undefined, { kind: 'histogram' });

    const { resourceMetrics } = await reader.collect();
    const metrics = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
    const byName = new Map(metrics.map((m) => [m.descriptor.name, m]));

    expect(byName.get('signups')?.dataPoints[0].value).toBe(2);
    expect(byName.get('latency_ms')?.dataPoints[0].value).toMatchObject({ count: 1 });
  });

  it('emits a log record with mapped severity, body, and attributes', () => {
    const exporter = new InMemoryLogRecordExporter();
    const sink = otelSink({ logProcessor: new SimpleLogRecordProcessor(exporter) });
    TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [sink] })] });
    TestBed.inject(TELEMETRY).log('error', 'disk full', { device: 'sda1' });

    const records = exporter.getFinishedLogRecords();
    expect(records.length).toBe(1);
    expect(records[0].body).toBe('disk full');
    expect(records[0].severityNumber).toBe(SeverityNumber.ERROR);
    expect(records[0].severityText).toBe('ERROR');
    expect(records[0].attributes).toMatchObject({ device: 'sda1' });
  });

  it('returns null with no exporter/url/provider (factory drops it to noop)', () => {
    expect(otelSink({})).toBeNull();
  });

  describe('bring-your-own provider', () => {
    function byoSetup() {
      const exporter = new InMemorySpanExporter();
      const provider = new WebTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const sink = otelSink({ provider });
      TestBed.configureTestingModule({
        providers: [provideTelemetry({ sinks: [sink] })],
      });
      return { exporter, telemetry: TestBed.inject(TELEMETRY) };
    }

    it('lets OTel own the ids and carries facade ids as mmstack.* attributes', () => {
      const { exporter, telemetry } = byoSetup();
      let facadeCtx: { traceId: string; spanId: string } | undefined;
      telemetry.span('work', (s) => {
        facadeCtx = s.ctx;
      });

      const [span] = exporter.getFinishedSpans();
      expect(span.attributes['mmstack.trace_id']).toBe(facadeCtx!.traceId);
      expect(span.attributes['mmstack.span_id']).toBe(facadeCtx!.spanId);
      // OTel generated its own ids (valid W3C shape, not the facade's)
      expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanContext().traceId).not.toBe(facadeCtx!.traceId);
    });

    it('keeps a nested facade span in ONE OTel trace while the parent is open', () => {
      const { exporter, telemetry } = byoSetup();
      telemetry.span('parent', (p) => {
        telemetry.span('child', () => undefined, { parent: p });
      });

      const spans = exporter.getFinishedSpans();
      const parent = spans.find((s) => s.name === 'parent')!;
      const child = spans.find((s) => s.name === 'child')!;
      expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
      expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    });

    it('keeps the OTel parent link even when the parent already ended (SpanContext stays valid)', () => {
      const { exporter, telemetry } = byoSetup();
      const parent = telemetry.startSpan('parent');
      parent.end();
      telemetry.span('late-child', () => undefined, { parent });

      const spans = exporter.getFinishedSpans();
      const parentSpan = spans.find((s) => s.name === 'parent')!;
      const child = spans.find((s) => s.name === 'late-child')!;
      expect(child.spanContext().traceId).toBe(parentSpan.spanContext().traceId); // ONE OTel trace
      expect(child.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
      // facade-level correlation rides along too
      expect(child.attributes['mmstack.trace_id']).toBe(parentSpan.attributes['mmstack.trace_id']);
    });

    it('bounds the parent-context map: the oldest entry is evicted past the 2000 cap', () => {
      const { exporter, telemetry } = byoSetup();
      const oldParent = telemetry.startSpan('old-parent'); // first entry in the map
      oldParent.end();
      // overflow the cap so the oldest entry (old-parent) is evicted
      for (let i = 0; i <= 2001; i++) telemetry.startSpan(`s${i}`).end();

      // a child parented to the evicted span can no longer link → it starts a fresh OTel trace
      telemetry.span('orphan', () => undefined, { parent: oldParent });

      const spans = exporter.getFinishedSpans();
      const old = spans.find((s) => s.name === 'old-parent')!;
      const orphan = spans.find((s) => s.name === 'orphan')!;
      expect(orphan.spanContext().traceId).not.toBe(old.spanContext().traceId);
    });
  });

  it('maps every LogSeverity tier to the matching SeverityNumber', () => {
    const exporter = new InMemoryLogRecordExporter();
    const sink = otelSink({ logProcessor: new SimpleLogRecordProcessor(exporter) });
    TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [sink] })] });
    const telemetry = TestBed.inject(TELEMETRY);

    const tiers = [
      ['trace', SeverityNumber.TRACE],
      ['debug', SeverityNumber.DEBUG],
      ['info', SeverityNumber.INFO],
      ['warn', SeverityNumber.WARN],
      ['error', SeverityNumber.ERROR],
      ['fatal', SeverityNumber.FATAL],
    ] as const;
    for (const [severity] of tiers) telemetry.log(severity, severity);

    const records = exporter.getFinishedLogRecords();
    expect(records.map((r) => [r.body, r.severityNumber])).toEqual(
      tiers.map(([severity, num]) => [severity, num]),
    );
  });

  it('defaults metrics to histograms, supports gauges, and rejects a kind change per name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const reader = new PeriodicExportingMetricReader({
        exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
        exportIntervalMillis: 100_000,
      });
      const sink = otelSink({ metricReader: reader });
      TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [sink] })] });
      const telemetry = TestBed.inject(TELEMETRY);

      telemetry.metric('latency_ms', 40); // no kind → histogram
      telemetry.metric('fps', 60, undefined, { kind: 'gauge' });
      telemetry.metric('fps', 1, undefined, { kind: 'counter' }); // conflicting kind → skipped + warned

      const { resourceMetrics } = await reader.collect();
      const metrics = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
      const byName = new Map(metrics.map((m) => [m.descriptor.name, m]));

      expect(byName.get('latency_ms')?.dataPoints[0].value).toMatchObject({ count: 1, sum: 40 });
      expect(byName.get('fps')?.dataPoints[0].value).toBe(60); // still the gauge, counter add skipped
      expect(byName.size).toBe(2); // no duplicate conflicting stream
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('strips null/undefined attr values before export', () => {
    const { exporter, telemetry } = setup();
    telemetry.span('attrs', () => undefined, {
      attrs: { keep: 'x', zero: 0, no: false, gone: null, missing: undefined },
    });

    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes).toEqual({ keep: 'x', zero: 0, no: false });
  });

  describe('config → capability shape', () => {
    it('url alone enables traces only; endpoint enables traces, metrics, and logs', () => {
      const urlOnly = otelSink({ url: 'http://localhost:4318/v1/traces' })!;
      expect(urlOnly.startSpan).toBeDefined();
      expect(urlOnly.record).toBeUndefined();
      expect(urlOnly.emitLog).toBeUndefined();

      const full = otelSink({ endpoint: 'http://localhost:4318/' })!; // trailing slash normalized
      expect(full.startSpan).toBeDefined();
      expect(full.record).toBeDefined();
      expect(full.emitLog).toBeDefined();
    });
  });
});
