import { TestBed } from '@angular/core/testing';
import { provideTelemetry, TELEMETRY } from '@mmstack/telemetry-core';
import { otelSink, type OtelSinkConfig } from './otel-sink';

type Built = { signal: string; options: { url?: string; headers?: unknown } };

const exporters = vi.hoisted(() => {
  const built: Built[] = [];
  const exported: string[] = [];
  const make = (signal: string) =>
    class {
      constructor(options: Built['options']) {
        built.push({ signal, options });
      }
      export(_items: unknown, cb: (r: { code: number }) => void): void {
        exported.push(signal);
        cb({ code: 0 });
      }
      forceFlush(): Promise<void> {
        return Promise.resolve();
      }
      shutdown(): Promise<void> {
        return Promise.resolve();
      }
    };
  return { built, exported, make };
});

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: exporters.make('traces'),
}));
vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: exporters.make('metrics'),
}));
vi.mock('@opentelemetry/exporter-logs-otlp-http', () => ({
  OTLPLogExporter: exporters.make('logs'),
}));

function setup(config: OtelSinkConfig) {
  TestBed.configureTestingModule({
    providers: [provideTelemetry({ sinks: [otelSink(config)] })],
  });
  return TestBed.inject(TELEMETRY);
}

const HEADERS = { authorization: 'Bearer t' };

describe('otel-sink OTLP exporter wiring', () => {
  beforeEach(() => {
    exporters.built.length = 0;
    exporters.exported.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds one exporter per signal from the endpoint, trailing slash dropped, headers passed', () => {
    setup({ endpoint: 'http://localhost:4318/', headers: HEADERS });
    expect(exporters.built).toEqual([
      {
        signal: 'traces',
        options: { url: 'http://localhost:4318/v1/traces', headers: HEADERS },
      },
      {
        signal: 'metrics',
        options: { url: 'http://localhost:4318/v1/metrics', headers: HEADERS },
      },
      {
        signal: 'logs',
        options: { url: 'http://localhost:4318/v1/logs', headers: HEADERS },
      },
    ]);
  });

  it('an explicit url drives traces only, with the headers', () => {
    setup({ url: 'https://collector.example.com/traces', headers: HEADERS });
    expect(exporters.built).toEqual([
      {
        signal: 'traces',
        options: {
          url: 'https://collector.example.com/traces',
          headers: HEADERS,
        },
      },
    ]);
  });

  it('a finished span and a log line reach their exporters', () => {
    const telemetry = setup({ endpoint: 'http://localhost:4318' });
    telemetry.span('s', () => undefined);
    telemetry.log('info', 'l');
    expect(exporters.exported).toEqual(['traces', 'logs']);
  });

  it('metrics export on the configured interval', async () => {
    vi.useFakeTimers();
    const telemetry = setup({
      endpoint: 'http://localhost:4318',
      metricIntervalMs: 5_000,
    });
    telemetry.metric('m', 1, undefined, { kind: 'counter' });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(exporters.exported).not.toContain('metrics');
    await vi.advanceTimersByTimeAsync(200);
    expect(exporters.exported).toContain('metrics');
  });

  it('metrics default to a 60 second interval', async () => {
    vi.useFakeTimers();
    const telemetry = setup({ endpoint: 'http://localhost:4318' });
    telemetry.metric('m', 1, undefined, { kind: 'counter' });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(exporters.exported).not.toContain('metrics');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(exporters.exported).toContain('metrics');
  });
});
