import {
  memorySink,
  provideTelemetry,
  telemetryInterceptor,
} from '@mmstack/telemetry-core';
import { otelSink } from '@mmstack/telemetry-otel';

export { telemetryInterceptor };

// In-page sink: the /telemetry example renders everything emitted, so the loop
// closes even without the docker stack running.
export const pageSink = memorySink('page');

/**
 * Playground telemetry: the in-page memory sink plus OTLP export to the local
 * grafana/otel-lgtm stack (`KEEP=1 bash scripts/telemetry-otlp-smoke.sh`, then
 * browse traces/metrics/logs at http://localhost:3000). The OTLP sink is
 * browser-only; the factory returns null during the server render, and export
 * failures are harmless noise when the stack isn't up.
 */
export function providePlaygroundTelemetry() {
  return provideTelemetry({
    sinks: [
      pageSink,
      () =>
        typeof window === 'undefined'
          ? null
          : otelSink({ endpoint: 'http://localhost:4318' }),
    ],
  });
}
