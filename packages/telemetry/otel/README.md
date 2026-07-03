# @mmstack/telemetry-otel

OTLP interchange adapter for [`@mmstack/telemetry-core`](https://www.npmjs.com/package/@mmstack/telemetry-core), built on the official OpenTelemetry JS SDK. One config exports traces, metrics, and logs to any OTLP-compatible backend: Datadog, Honeycomb, Grafana, Sentry traces, a local collector, and so on.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/LICENSE)

## Install

```bash
npm install @mmstack/telemetry-otel @mmstack/telemetry-core \
  @opentelemetry/api @opentelemetry/api-logs \
  @opentelemetry/sdk-trace-web @opentelemetry/sdk-metrics @opentelemetry/sdk-logs \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/exporter-logs-otlp-http
```

All `@opentelemetry/*` packages are peers so your app controls their versions and they dedupe cleanly (a duplicated OTel API breaks context propagation).

## Usage

```ts
import { provideTelemetry } from '@mmstack/telemetry-core';
import { otelSink } from '@mmstack/telemetry-otel';

provideTelemetry({
  sinks: [
    otelSink({
      endpoint: 'http://localhost:4318', // drives /v1/traces, /v1/metrics, /v1/logs
      headers: { 'x-api-key': '...' },
    }),
  ],
});
```

- `endpoint` enables all three signals. `url` targets traces only and overrides `endpoint` for them.
- With no endpoint, url, provider, or injected processor there is nowhere to export, so `otelSink` returns `null` and the facade stays a noop.
- For tests, inject in-memory pieces instead of OTLP: `processor`, `metricReader`, `logProcessor`.

## Bring your own provider

Pass an existing `WebTracerProvider` and the adapter uses it instead of building one. OTel then owns the span ids: facade ids ride along as `mmstack.trace_id` / `mmstack.span_id` attributes, and nested facade spans keep real OTel parent links (bridged through the OTel-side span context, which stays valid even after the parent ends). Without a custom provider, the adapter mints the facade's ids straight onto the OTel spans, so both worlds share one id space.

One caveat: OTel auto-instrumentation (`@opentelemetry/auto-instrumentations-web`) overlaps the core's HTTP interceptor. Pick one, don't double-instrument.

## Metrics and logs

`telemetry.metric(name, value, { kind })` maps to counter, gauge, or histogram instruments (histogram when omitted; a name keeps the kind it registered with, and conflicting kinds are skipped with a dev warning). `telemetry.log(severity, message)` maps to OTLP log records with the matching `SeverityNumber` and the facade's emit-time timestamp. Metric export runs on a periodic reader (60s default, configurable via `metricIntervalMs`).

## Lifecycle

When the adapter builds its own providers, it flushes them when the page becomes hidden or unloads (otherwise a tab shorter than the metric interval would export nothing), and shuts them down when the providing injector is destroyed. A bring-your-own provider stays yours: the adapter never flushes or shuts it down.
