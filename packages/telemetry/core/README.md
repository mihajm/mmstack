# @mmstack/telemetry-core

Headless, signals-native telemetry for Angular. One facade for spans, events, errors, metrics, and logs, fanned out to capability-based sinks (OTLP, PostHog, Sentry, or your own). Context propagation is explicit and zone-free, consent-ready, and without configuration the injected facade is a noop whose empty methods cost effectively nothing.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/LICENSE)

## Why this exists

Angular is zoneless by default since v21. OpenTelemetry's browser context propagation still relies on zone.js (`ZoneContextManager`), which also breaks on native `async/await`, and there is no built-in zoneless context manager and no official Angular instrumentation. If you want real traces in a modern Angular app, ambient context is a dead end.

This suite answers that with explicit, zone-free context: spans parent through values you already hold (a `SpanHandle` you pass, an `HttpContext` on the request, the injector tree for component lineage) instead of through a patched runtime. It is a telemetry library first, not an OTel library. The trace representation is OTel/W3C-shaped so OTLP export and cross-vendor correlation come for free, but events, errors, metrics, and logs stay first-class instead of being forced through a trace model.

## Highlights

- **Capability sinks.** A backend implements only what it supports (`SpanSink`, `EventSink`, `ErrorSink`, `MetricSink`, `LogSink`). The facade routes each emit to the sinks that can handle it and shares one trace context across all of them.
- **Opt-in, noop by default.** `inject(TELEMETRY)` works with zero configuration and costs nothing. `provideTelemetry` activates it only when at least one sink validates; adapter factories return `null` for bad config and get filtered out.
- **Signal-native readiness.** A sink declares `ready: Signal<boolean>`. While it initializes, telemetry buffers (spans record and replay), then flushes in order on ready, or drops after a timeout so a broken sink can't leak memory.
- **Explicit context, no zones.** A synchronous active-span stack drives correlation: emits inside a `span()` body carry its trace ids, and nested `span()` calls join the active trace (`parent: null` opts out). Across async boundaries nothing is ambient: HTTP spans nest via `withTelemetryParent`, raw async via `traced()` or an explicit `parent`.
- **Privacy is mechanism, not policy.** The core sends the attributes you pass. An optional per-sink `AttributePolicy` transforms them first, with builders to compose: `allowOnly`, `deny`, `redactKeys`, `hashKeys`, `compose`. Rich attrs to your own sink, a redacted subset to a vendor.
- **Signal causality.** `tracedSignal` records the span active at each write, so a downstream reactive consumer (a refetch, a derived recompute) can attribute itself to the interaction that caused it.
- **Component lineage from DI.** The `TelemetryScope` directive builds an ancestor path from the injector tree, composable onto any component via `hostDirectives`. No DOM walking, no globals.
- **Testable by design.** `memorySink()` records everything a real sink would receive, so you can assert your instrumentation in plain unit tests.

## Install

```bash
npm install @mmstack/telemetry-core
```

`@angular/core`, `@angular/common`, and `rxjs` are peer dependencies. Add an adapter for your backend: [`@mmstack/telemetry-otel`](https://www.npmjs.com/package/@mmstack/telemetry-otel) (OTLP: Datadog, Honeycomb, Grafana, and friends), [`@mmstack/telemetry-posthog`](https://www.npmjs.com/package/@mmstack/telemetry-posthog), [`@mmstack/telemetry-sentry`](https://www.npmjs.com/package/@mmstack/telemetry-sentry).

## Quick start

```ts
// app.config.ts
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideTelemetry, telemetryInterceptor } from '@mmstack/telemetry-core';
import { otelSink } from '@mmstack/telemetry-otel';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([telemetryInterceptor])),
    provideTelemetry({
      sinks: [otelSink({ endpoint: 'https://collector.example.com' })],
    }),
  ],
};
```

```ts
import { inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TELEMETRY, withTelemetryParent } from '@mmstack/telemetry-core';

export class CheckoutComponent {
  private readonly telemetry = inject(TELEMETRY);
  private readonly http = inject(HttpClient);

  submit() {
    // the body returns a promise, so the span stays open until it settles
    return this.telemetry.span('checkout', async (span) => {
      this.telemetry.event('checkout.started', { plan: 'pro' });
      // nests the HTTP span under `checkout`
      await firstValueFrom(
        this.http.post('/api/orders', body, { context: withTelemetryParent(span) }),
      );
    });
  }
}
```

Everything emitted inside the synchronous part of the span body carries its `trace_id`/`span_id` automatically. The HTTP interceptor records method, host and path, status, and duration, and never the query string or body.

## Privacy

The core is privacy-agnostic: it sends what you pass. Policy belongs to you, per sink:

```ts
provideTelemetry({
  sinks: [vendorSink, internalSink],
  policy: (attrs, meta) =>
    meta.sink === 'vendor' ? allowOnly(['plan', 'step'])(attrs, meta) : attrs,
});
```

The one place the library forms its own attributes (the HTTP interceptor) defaults conservatively. Your policy still applies on top.

## Consent

Headless and reactive: declare what the app wants to track, tag emits with a category, and the facade gates delivery on the decisions. No UI ships here; `pending()` tells you exactly what to prompt for.

```ts
provideTelemetry({
  sinks: [posthogSink({ posthog })],
  consent: {
    requirements: [
      { id: 'analytics', category: 'analytics', purpose: 'Anonymous product analytics' },
    ],
    store: localStorageConsentStore(), // async stores (server-side) work too
  },
});

telemetry.event('checkout', { plan: 'pro' }, { category: 'analytics' });

// in your consent prompt component
telemetry.pending();          // requirements still needing an answer
telemetry.decide('analytics', true);
```

The default mode is `required`: a categorized emit needs an explicit grant, and undecided or undeclared categories are dropped (you cannot track something you didn't ask consent for). `mode: 'implicit'` flips that to opt-out. Uncategorized emits are never gated. Requirements can be a signal, so when a new app section needs new tracking, `pending()` becomes exactly the delta to re-prompt for. While an async store hydrates, undecided emits are held briefly and then delivered or dropped according to the stored decisions, so a returning user's denial is never raced.

Full documentation is on its way. The API surface is small; the source and its specs read well in the meantime.
