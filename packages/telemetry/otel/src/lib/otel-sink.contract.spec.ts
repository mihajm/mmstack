import { TestBed } from '@angular/core/testing';
import {
  provideTelemetry,
  TELEMETRY,
  type AttrMeta,
} from '@mmstack/telemetry-core';
import {
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { otelSink, type OtelSinkConfig } from './otel-sink';

function setup(config: OtelSinkConfig, metas?: AttrMeta[]) {
  TestBed.configureTestingModule({
    providers: [
      provideTelemetry({
        sinks: [otelSink(config)],
        policy: (attrs, meta) => {
          metas?.push(meta);
          return attrs;
        },
      }),
    ],
  });
  return TestBed.inject(TELEMETRY);
}

function metricsSetup() {
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 100_000,
  });
  const telemetry = setup({ metricReader: reader });
  const collect = async () => {
    const { resourceMetrics } = await reader.collect();
    return resourceMetrics.scopeMetrics;
  };
  return { telemetry, collect };
}

describe('otel-sink contract', () => {
  it('names itself otel and exports under the @mmstack/telemetry scope', async () => {
    const spans = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();
    const reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 100_000,
    });
    const metas: AttrMeta[] = [];
    const telemetry = setup(
      {
        processor: new SimpleSpanProcessor({ exporter: spans }),
        metricReader: reader,
        logProcessor: new SimpleLogRecordProcessor({ exporter: logs }),
      },
      metas,
    );
    telemetry.span('s', () => undefined);
    telemetry.metric('m', 1);
    telemetry.log('info', 'l');

    expect(new Set(metas.map((m) => m.sink))).toEqual(new Set(['otel']));
    expect(spans.getFinishedSpans()[0].instrumentationScope.name).toBe(
      '@mmstack/telemetry',
    );
    expect(logs.getFinishedLogRecords()[0].instrumentationScope.name).toBe(
      '@mmstack/telemetry',
    );
    const { resourceMetrics } = await reader.collect();
    expect(resourceMetrics.scopeMetrics[0].scope.name).toBe(
      '@mmstack/telemetry',
    );
  });

  it('drops undefined metric attributes before they key a stream', async () => {
    const { telemetry, collect } = metricsSetup();
    telemetry.metric('m', 1, { a: 'x', gone: undefined }, { kind: 'counter' });
    const [scope] = await collect();
    expect(Object.keys(scope.metrics[0].dataPoints[0].attributes)).toEqual([
      'a',
    ]);
  });

  it('a counter accumulates every record of the same name', async () => {
    const { telemetry, collect } = metricsSetup();
    telemetry.metric('x', 2, undefined, { kind: 'counter' });
    telemetry.metric('x', 3, undefined, { kind: 'counter' });
    const [scope] = await collect();
    expect(scope.metrics[0].dataPoints[0].value).toBe(5);
  });

  it('a default-kind metric and an explicit histogram share one instrument', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { telemetry, collect } = metricsSetup();
      telemetry.metric('x', 1);
      telemetry.metric('x', 2, undefined, { kind: 'histogram' });
      const [scope] = await collect();
      expect(scope.metrics[0].dataPoints[0].value).toMatchObject({
        count: 2,
        sum: 3,
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('records a thrown non-Error as the exception message', () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = setup({
      processor: new SimpleSpanProcessor({ exporter }),
    });
    expect(() =>
      telemetry.span('s', () => {
        throw 'nope';
      }),
    ).toThrow();
    const [span] = exporter.getFinishedSpans();
    const exception = span.events.find((e) => e.name === 'exception')!;
    expect(exception.attributes?.['exception.message']).toBe('nope');
    expect(span.status.message).toBe('nope');
  });

  it('a child links to a local (not remote) parent context', () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = setup({
      processor: new SimpleSpanProcessor({ exporter }),
    });
    telemetry.span('parent', (p) =>
      telemetry.span('child', () => undefined, { parent: p }),
    );
    const child = exporter.getFinishedSpans().find((s) => s.name === 'child')!;
    expect(child.parentSpanContext?.isRemote).toBe(false);
  });

  it('a bring-your-own provider wins over an injected processor', () => {
    const own = new InMemorySpanExporter();
    const other = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter: own })],
    });
    const telemetry = setup({
      provider,
      processor: new SimpleSpanProcessor({ exporter: other }),
    });
    telemetry.span('s', () => undefined);
    expect(own.getFinishedSpans().map((s) => s.name)).toEqual(['s']);
    expect(own.getFinishedSpans()[0].attributes['mmstack.trace_id']).toEqual(
      expect.any(String),
    );
    expect(other.getFinishedSpans()).toEqual([]);
  });

  it('bring-your-own: a child of an evicted parent starts a fresh root', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });
    const telemetry = setup({ provider });
    const old = telemetry.startSpan('old');
    old.end();
    for (let i = 0; i <= 2001; i++) telemetry.startSpan(`s${i}`).end();
    telemetry.span('orphan', () => undefined, { parent: old });
    const orphan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'orphan')!;
    expect(orphan.parentSpanContext).toBeUndefined();
  });
});
