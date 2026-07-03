// @mmstack/telemetry-core — headless, signals-native, opt-in telemetry facade.
// Privacy is consumer policy (AttributePolicy); adapters implement capability sinks.

export {
  allowOnly,
  compose,
  deny,
  hashKeys,
  identityPolicy,
  redactKeys,
  type AttrMeta,
  type AttrValue,
  type Attrs,
  type AttributePolicy,
} from './lib/attrs';

export {
  localStorageConsentStore,
  type ConsentConfig,
  type ConsentDecision,
  type ConsentStore,
  type TrackingRequirement,
} from './lib/consent';

export {
  type ErrorSink,
  type EventSink,
  type LogRecord,
  type LogSeverity,
  type LogSink,
  type MetricKind,
  type MetricSink,
  type Sink,
  type SinkInput,
  type SinkSpan,
  type SpanContext,
  type SpanHandle,
  type SpanSink,
} from './lib/sink';

export {
  DEFAULT_READY_TIMEOUT_MS,
  readSpan,
  TELEMETRY,
  type EmitOptions,
  type MetricOptions,
  type SpanCallOptions,
  type Telemetry,
  type TelemetryConfig,
} from './lib/telemetry';

export { provideTelemetry } from './lib/provide';

export { TELEMETRY_HTTP_PARENT, telemetryInterceptor, withTelemetryParent } from './lib/http-interceptor';

// Hook-ins (Angular-idiomatic ways to attach telemetry to the facade).
export { TelemetryHandles } from './lib/handles';
export { traced, tracedCallback } from './lib/helpers';
export { tracedSignal, type CausalSignal } from './lib/traced-signal';
export { TelemetryScope } from './lib/scope.directive';

// Test utility (importable by consumers' specs).
export {
  memorySink,
  type MemorySink,
  type RecordedError,
  type RecordedEvent,
  type RecordedLog,
  type RecordedMetric,
  type RecordedSpan,
} from './lib/memory-sink';
