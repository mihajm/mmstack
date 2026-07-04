import { TestBed } from '@angular/core/testing';
import { provideTelemetry, TELEMETRY } from '@mmstack/telemetry-core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-web';
import { otelSink } from './otel-sink';

// Live-collector smoke, skipped unless OTLP_E2E is set. Run it via
// `bash scripts/telemetry-otlp-smoke.sh` (boots grafana/otel-lgtm on :4318).
const BASE = 'http://localhost:4318';

/** Wraps an OTLP exporter to record each export's result code (0 = success). */
function observed<T extends { export(items: never, cb: (r: { code: number }) => void): void }>(
  exporter: T,
): { exporter: T; codes: number[] } {
  const codes: number[] = [];
  const raw = exporter.export.bind(exporter);
  exporter.export = ((items: never, cb: (r: { code: number }) => void) =>
    raw(items, (result) => {
      codes.push(result.code);
      cb(result);
    })) as T['export'];
  return { exporter, codes };
}

describe.runIf(!!process.env['OTLP_E2E'])('otel-sink OTLP e2e (live collector)', () => {
  it(
    'exports spans, metrics, and logs to the collector successfully',
    async () => {
      const traces = observed(new OTLPTraceExporter({ url: `${BASE}/v1/traces` }));
      const metrics = observed(new OTLPMetricExporter({ url: `${BASE}/v1/metrics` }));
      const logs = observed(new OTLPLogExporter({ url: `${BASE}/v1/logs` }));

      const processor = new SimpleSpanProcessor(traces.exporter);
      const metricReader = new PeriodicExportingMetricReader({
        exporter: metrics.exporter,
        exportIntervalMillis: 3_600_000, // flushed manually below
      });
      const logProcessor = new SimpleLogRecordProcessor(logs.exporter);

      const sink = otelSink({ processor, metricReader, logProcessor });
      TestBed.configureTestingModule({
        providers: [provideTelemetry({ sinks: [sink] })],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      telemetry.span(
        'otlp-e2e',
        (span) => {
          span.setAttrs({ suite: 'telemetry-otlp-smoke' });
          telemetry.log('info', 'otlp-e2e log line');
          telemetry.metric('otlp_e2e_runs', 1, undefined, { kind: 'counter' });
        },
        { attrs: { runner: 'vitest' } },
      );

      await processor.forceFlush();
      await metricReader.forceFlush();
      await logProcessor.forceFlush();

      expect(traces.codes).toEqual([0]); // ExportResultCode.SUCCESS
      expect(metrics.codes).toEqual([0]);
      expect(logs.codes).toEqual([0]);
    },
    20_000,
  );
});
