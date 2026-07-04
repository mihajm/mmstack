import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-telemetry-adapters',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Adapters"
      pkg="@mmstack/telemetry-*"
      lead="One core, several backends. Each adapter implements the capability sinks its backend supports and correlates with everything else through the shared trace context. Pull only the SDK weight you use."
    >
      <docs-section title="OpenTelemetry (OTLP)" id="otel">
        <p>
          <code>&#64;mmstack/telemetry-otel</code> is the OTLP interchange
          adapter, built on the official OpenTelemetry JS SDK. One config
          exports traces, metrics, and logs to any OTLP-compatible backend:
          Datadog, Honeycomb, Grafana, a local collector, and so on.
        </p>
        <docs-code [code]="otel" lang="ts" />
        <p>
          <code>endpoint</code> enables all three signals. Pass an existing
          <code>WebTracerProvider</code> to share one export pipeline with
          official OpenTelemetry instrumentation. Metrics run on a periodic
          reader, and the adapter flushes them when the page is hidden, so a
          short session still reports. All the OpenTelemetry packages are peer
          dependencies, so your app controls their versions and they dedupe.
        </p>
      </docs-section>

      <docs-section title="PostHog" id="posthog">
        <p>
          <code>&#64;mmstack/telemetry-posthog</code> is an event sink over your
          own <code>posthog-js</code> instance. No SDK is bundled. Events emitted
          inside a span carry the trace ids, so a PostHog event links back to the
          trace your OTLP backend received.
        </p>
        <docs-code [code]="posthog" lang="ts" />
        <p>
          If the client exposes a session-replay URL, the adapter publishes it as
          a signal in the <code>TelemetryHandles</code> registry, keyed by sink
          name, so other code can attach the replay link to a span or an error.
        </p>
      </docs-section>

      <docs-section title="Sentry" id="sentry">
        <p>
          <code>&#64;mmstack/telemetry-sentry</code> is an error sink over your
          own Sentry SDK. Attributes ride as Sentry <code>extra</code>, and errors
          recorded inside a span carry the trace ids. The most recent event id is
          published as a signal, so you can deep-link to the captured event from a
          feedback dialog or a support id in the UI.
        </p>
        <docs-code [code]="sentry" lang="ts" />
        <p>
          Send traces themselves to Sentry through the OTLP adapter. This adapter
          is for Sentry's error-tracking strength.
        </p>
      </docs-section>

      <docs-section title="Combining adapters" id="combining">
        <p>
          Provide several sinks at once. The facade fans each emit out to the
          sinks that support it and shares the trace ids across all of them, so a
          span, its errors in Sentry, and its analytics events in PostHog all
          correlate without any extra plumbing.
        </p>
        <docs-code [code]="combined" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class TelemetryAdapters {
  protected readonly otel = `import { provideTelemetry } from '@mmstack/telemetry-core';
import { otelSink } from '@mmstack/telemetry-otel';

provideTelemetry({
  sinks: [
    otelSink({
      endpoint: 'http://localhost:4318', // drives /v1/traces, /v1/metrics, /v1/logs
      headers: { 'x-api-key': '...' },
    }),
  ],
});`;

  protected readonly posthog = `import posthog from 'posthog-js';
import { provideTelemetry } from '@mmstack/telemetry-core';
import { posthogSink } from '@mmstack/telemetry-posthog';

posthog.init('<key>', { api_host: 'https://eu.posthog.com' });

provideTelemetry({
  sinks: [posthogSink({ posthog })],
});`;

  protected readonly sentry = `import * as Sentry from '@sentry/browser';
import { provideTelemetry } from '@mmstack/telemetry-core';
import { sentrySink } from '@mmstack/telemetry-sentry';

Sentry.init({ dsn: '<dsn>' });

provideTelemetry({
  sinks: [sentrySink({ sentry: Sentry })],
});`;

  protected readonly combined = `provideTelemetry({
  sinks: [
    otelSink({ endpoint: 'http://localhost:4318' }),
    sentrySink({ sentry: Sentry }),
    posthogSink({ posthog }),
  ],
});`;
}
