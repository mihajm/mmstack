export {
    allowOnly,
    compose,
    deny,
    hashKeys,
    identityPolicy,
    redactKeys,
    type AttributePolicy,
    type AttrMeta,
    type Attrs,
    type AttrValue
} from './lib/attrs';

export {
    localStorageConsentStore,
    type ConsentConfig,
    type ConsentDecision,
    type ConsentStore,
    type TrackingRequirement
} from './lib/consent';

export {
    type ErrorSink,
    type EventSink,
    type GlobalAttrsSink,
    type IdentitySink,
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
    type SpanSink
} from './lib/sink';

export {
    DEFAULT_READY_TIMEOUT_MS,
    injectTelemetry,
    readSpan,
    TELEMETRY,
    type EmitOptions,
    type MetricOptions,
    type SpanCallOptions,
    type Telemetry,
    type TelemetryConfig
} from './lib/telemetry';

export { provideTelemetry } from './lib/provide';

export {
    TELEMETRY_HTTP_PARENT,
    telemetryInterceptor,
    withTelemetryParent
} from './lib/http-interceptor';

export { TelemetryHandles } from './lib/handles';
export { traced, tracedCallback } from './lib/helpers';
export { TelemetryScope } from './lib/scope.directive';
export { tracedBy, tracedSignal, type CausalSignal } from './lib/traced-signal';

export {
    memorySink,
    type MemorySink,
    type RecordedError,
    type RecordedEvent,
    type RecordedLog,
    type RecordedMetric,
    type RecordedSpan
} from './lib/memory-sink';
