import { TestBed } from '@angular/core/testing';
import { provideTelemetry, TELEMETRY } from '@mmstack/telemetry-core';
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
} from '@opentelemetry/sdk-trace';
import { otelSink } from './otel-sink';

type Visibility = 'visible' | 'hidden';

function setVisibility(state: Visibility): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
}

function parts() {
  const processor = new SimpleSpanProcessor({
    exporter: new InMemorySpanExporter(),
  });
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 100_000,
  });
  const logProcessor = new SimpleLogRecordProcessor({
    exporter: new InMemoryLogRecordExporter(),
  });
  const flushes = [
    vi.spyOn(processor, 'forceFlush'),
    vi.spyOn(reader, 'forceFlush'),
    vi.spyOn(logProcessor, 'forceFlush'),
  ];
  const shutdowns = [
    vi.spyOn(processor, 'shutdown'),
    vi.spyOn(reader, 'shutdown'),
    vi.spyOn(logProcessor, 'shutdown'),
  ];
  return { processor, metricReader: reader, logProcessor, flushes, shutdowns };
}

function provide(sink: ReturnType<typeof otelSink>): void {
  TestBed.configureTestingModule({
    providers: [provideTelemetry({ sinks: [sink] })],
  });
  TestBed.inject(TELEMETRY);
}

// the meter provider reaches its reader's forceFlush a few microtasks later
async function flushCounts(flushes: { mock: { calls: unknown[] } }[]) {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return flushes.map((f) => f.mock.calls.length);
}

describe('otel-sink page lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setVisibility('visible');
  });

  it('flushes every signal when the page becomes hidden, not when it becomes visible', async () => {
    const p = parts();
    provide(otelSink(p));

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await flushCounts(p.flushes)).toEqual([0, 0, 0]);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await flushCounts(p.flushes)).toEqual([1, 1, 1]);
  });

  it('flushes on pagehide even while the page still reports visible', async () => {
    const p = parts();
    provide(otelSink(p));
    setVisibility('visible');
    window.dispatchEvent(new Event('pagehide'));
    expect(await flushCounts(p.flushes)).toEqual([1, 1, 1]);
  });

  it('flushes with only a span processor configured', () => {
    const p = parts();
    provide(otelSink({ processor: p.processor }));
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(p.flushes[0]).toHaveBeenCalledTimes(1);
  });

  it('dispose shuts every provider down and removes the page listeners', async () => {
    const p = parts();
    provide(otelSink(p));
    TestBed.resetTestingModule();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    for (const s of p.shutdowns) expect(s).toHaveBeenCalled();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    expect(await flushCounts(p.flushes)).toEqual([0, 0, 0]);
  });

  it('builds without a document (server rendering)', () => {
    const p = parts();
    vi.stubGlobal('document', undefined);
    expect(() => otelSink({ processor: p.processor })).not.toThrow();
    expect(otelSink({ processor: p.processor })?.startSpan).toBeDefined();
  });
});
