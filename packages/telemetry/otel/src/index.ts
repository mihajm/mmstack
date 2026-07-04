// @mmstack/telemetry-otel — OTLP interchange adapter (traces) on the official
// OpenTelemetry JS SDK. One OTLP config → many trace backends. Maps the core's
// capability spans → OTel spans carrying the facade's ids.

export { otelSink, type OtelSinkConfig } from './lib/otel-sink';
