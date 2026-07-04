# @mmstack/telemetry-posthog

> **Experimental.** The API may still change and this package is not yet battle-tested in production. Pin a version and expect some churn.

PostHog adapter for [`@mmstack/telemetry-core`](https://www.npmjs.com/package/@mmstack/telemetry-core). An `EventSink` over your own `posthog-js` instance, plus a reactive session-replay URL handle.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/LICENSE)

## Install

```bash
npm install @mmstack/telemetry-posthog
```

No PostHog SDK is bundled or required as a peer. You bring your own inited client (so replay, autocapture, and flags stay configured your way) and the adapter uses a minimal structural slice of it.

## Usage

```ts
import posthog from 'posthog-js';
import { provideTelemetry } from '@mmstack/telemetry-core';
import { posthogSink } from '@mmstack/telemetry-posthog';

posthog.init('<key>', { api_host: 'https://eu.posthog.com' });

provideTelemetry({
  sinks: [posthogSink({ posthog })],
});
```

`telemetry.event(name, attrs)` forwards to `posthog.capture(name, attrs)`. Events emitted inside a span carry `trace_id` / `span_id` automatically, so a PostHog event links back to the trace your OTLP backend received.

## Session replay handle

If the client exposes `get_session_replay_url`, the adapter publishes it in the `TelemetryHandles` registry as a signal, keyed by sink name: `posthog.replay_url` for the default (the `POSTHOG_REPLAY_URL` constant), `<name>.replay_url` when you pass a custom `name`, so two PostHog sinks never shadow each other. It starts undefined and fills in once recording begins, so other sinks or your own code can attach the replay link to spans and errors:

```ts
const replayUrl = inject(TelemetryHandles).get<string>(POSTHOG_REPLAY_URL);
```

Pass `null` for the client and the factory returns `null`, dropping the sink so the facade stays a noop.
