# @mmstack/telemetry-sentry

Sentry adapter for [`@mmstack/telemetry-core`](https://www.npmjs.com/package/@mmstack/telemetry-core). An `ErrorSink` over your own Sentry SDK, plus a reactive last-event-id handle.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/LICENSE)

## Install

```bash
npm install @mmstack/telemetry-sentry
```

No Sentry SDK is bundled or required as a peer. You bring your own inited SDK or namespace (so replay, profiling, and source maps stay configured your way) and the adapter uses a minimal structural slice of it.

## Usage

```ts
import * as Sentry from '@sentry/browser';
import { provideTelemetry } from '@mmstack/telemetry-core';
import { sentrySink } from '@mmstack/telemetry-sentry';

Sentry.init({ dsn: '<dsn>' });

provideTelemetry({
  sinks: [sentrySink({ sentry: Sentry })],
});
```

`telemetry.error(err, attrs)` forwards to `captureException`, with attrs carried as Sentry `extra`. Errors recorded inside a span carry `trace_id` / `span_id` automatically, so a Sentry issue links back to the trace your OTLP backend received. Send traces themselves to Sentry through [`@mmstack/telemetry-otel`](https://www.npmjs.com/package/@mmstack/telemetry-otel) and OTLP.

## Last event id handle

Each capture returns Sentry's event id. The adapter publishes the most recent one in the `TelemetryHandles` registry as a signal, keyed by sink name: `sentry.last_event_id` for the default (the `SENTRY_LAST_EVENT_ID` constant), `<name>.last_event_id` when you pass a custom `name`. Use it to deep-link to the captured event (for a feedback dialog, a support id in the UI, or a span attribute):

```ts
const lastEventId = inject(TelemetryHandles).get<string>(SENTRY_LAST_EVENT_ID);
```

Pass `null` for the client and the factory returns `null`, dropping the sink so the facade stays a noop.
