import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-telemetry-overview',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Telemetry"
      experimental
      pkg="@mmstack/telemetry-core"
      lead="Headless, signals-native telemetry for Angular. One facade for spans, events, errors, metrics, and logs, sent to capability-based sinks. Context propagation is explicit and zone-free, and with no configuration the injected facade is a noop that costs effectively nothing."
    >
      <p>
        Angular has been zoneless by default since v21. OpenTelemetry's browser
        context propagation still relies on zone.js, which also breaks on native
        <code>async/await</code>, and there is no built-in zoneless context
        manager and no official Angular instrumentation. If you want real traces
        in a modern Angular app, ambient context is a dead end.
      </p>
      <p>
        This suite answers that with explicit context. Spans parent through
        values you already hold: a handle you pass, an
        <code>HttpContext</code> on a request, the injector tree for component
        lineage. It is a telemetry library first, not an OpenTelemetry library.
        The trace representation is OTLP shaped, so export and cross-vendor
        correlation come for free, but events, errors, metrics, and logs stay
        first-class instead of being forced through a trace model.
      </p>

      <docs-code [code]="install" lang="bash" />

      <docs-section title="Setup" id="setup">
        <p>
          <code>provideTelemetry</code> is opt-in. With no valid sink the
          injected <code>TELEMETRY</code> is a noop, so an app that ships no
          telemetry config pays nothing. Add an adapter for your backend (see
          <a mmLink="/docs/telemetry/adapters">Adapters</a>) and the interceptor
          for automatic HTTP spans.
        </p>
        <docs-code [code]="setup" lang="ts" />
      </docs-section>

      <docs-section title="The facade" id="facade">
        <p>
          Inject <code>TELEMETRY</code> and call <code>span</code>,
          <code>event</code>, <code>error</code>, <code>metric</code>, or
          <code>log</code>. Anything emitted inside a <code>span</code> body
          carries that span's <code>trace_id</code> and <code>span_id</code>
          automatically, through a synchronous active-span stack. A nested
          <code>span</code> joins the active trace; pass
          <code>{{ '{' }} parent: null {{ '}' }}</code> to start a fresh root.
        </p>
        <docs-code [code]="facade" lang="ts" />
        <p>
          Emits are attributes-first:
          <code>event(name, attrs?, opt?)</code>, and the same shape for
          <code>error</code>, <code>metric</code>, and <code>log</code>. The
          optional last argument carries the consent category and an explicit
          parent span.
        </p>
      </docs-section>

      <docs-section title="Capability sinks" id="sinks">
        <p>
          A sink implements only what it supports:
          <code>SpanSink</code>, <code>EventSink</code>,
          <code>ErrorSink</code>, <code>MetricSink</code>,
          <code>LogSink</code>, <code>IdentitySink</code>. The facade routes each emit to the sinks that
          can handle it and shares one trace context across all of them, so a
          PostHog event and a Sentry error both correlate to the same OTLP
          trace. A sink declares readiness as a signal, so while it initializes
          the facade buffers, then flushes in order once it is ready, or drops
          the buffer after a timeout so a broken sink cannot grow memory.
        </p>
        <p>
          For tests, <code>memorySink()</code> records everything a real sink
          would receive, so you can assert your instrumentation with plain unit
          tests.
        </p>
      </docs-section>

      <docs-section title="Identity and super-properties" id="identity">
        <p>
          <code>identify(userId, traits?)</code> associates subsequent telemetry
          with a user on every sink that has an identity concept (a PostHog
          person, a Sentry user), and <code>identify(null)</code> clears it on
          logout. It is a no-op on sinks without one (OTel has no user
          primitive; attribute users there with a global attribute instead), so
          the call is always safe.
        </p>
        <p>
          <code>setGlobalAttrs(attrs)</code> sets super-properties: attributes
          merged into every subsequent emit (event, error, metric, log, and
          span), so you set context like the active tenant or tool once rather
          than on every call. Calls accumulate; a key set to
          <code>undefined</code> removes it. Traits and global attributes both
          run through your <code>AttributePolicy</code>.
        </p>
        <docs-code [code]="identity" lang="ts" />
      </docs-section>

      <docs-section title="HTTP spans" id="http">
        <p>
          <code>telemetryInterceptor</code> records a span per request: method,
          host and path, status, and duration. It never records the query
          string or the body. By default each request span is its own flat
          trace. To nest a request under a caller span, stamp the active span
          onto the request with <code>withTelemetryParent</code>.
        </p>
        <docs-code [code]="http" lang="ts" />
      </docs-section>

      <docs-section title="Signal causality" id="tracedSignal">
        <p>
          <code>tracedSignal</code> records the span active at each write, so a
          downstream reactive consumer (a refetch, a derived recompute) can
          attribute itself to the interaction that caused it. Capture is
          synchronous: a write after an <code>await</code> does not attribute,
          and reading <code>causedBy()</code> never creates a reactive
          dependency.
        </p>
        <docs-code [code]="tracedSignal" lang="ts" />
      </docs-section>

      <docs-section title="Privacy is a mechanism, not a policy" id="privacy">
        <p>
          The core sends the attributes you pass. Policy is yours, per sink: an
          <code>AttributePolicy</code> transforms attributes before a sink
          receives them, with builders to compose (<code>allowOnly</code>,
          <code>deny</code>, <code>redactKeys</code>, <code>hashKeys</code>,
          <code>compose</code>). Send rich attributes to your own sink and a
          redacted subset to a vendor. The one place the library forms its own
          attributes, the HTTP interceptor, defaults conservatively, and your
          policy still applies on top.
        </p>
        <docs-code [code]="policy" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class TelemetryOverview {
  protected readonly install = `npm install @mmstack/telemetry-core`;

  protected readonly setup = `import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideTelemetry, telemetryInterceptor } from '@mmstack/telemetry-core';
import { otelSink } from '@mmstack/telemetry-otel';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([telemetryInterceptor])),
    provideTelemetry({
      sinks: [otelSink({ endpoint: 'https://collector.example.com' })],
    }),
  ],
};`;

  protected readonly facade = `import { inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TELEMETRY, withTelemetryParent } from '@mmstack/telemetry-core';

export class CheckoutComponent {
  private readonly telemetry = inject(TELEMETRY);
  private readonly http = inject(HttpClient);

  submit() {
    // the body returns a promise, so the span stays open until it settles
    return this.telemetry.span('checkout', async (span) => {
      this.telemetry.event('checkout.started', { plan: 'pro' });
      await firstValueFrom(
        this.http.post('/api/orders', body, { context: withTelemetryParent(span) }),
      );
    });
  }
}`;

  protected readonly identity = `const telemetry = inject(TELEMETRY);

// on login: attaches to the PostHog person, the Sentry user, …
telemetry.identify('user-42', { plan: 'pro' });

// super-properties ride on every subsequent emit, no repetition
telemetry.setGlobalAttrs({ tenant: 'acme', tool: 'etl' });
telemetry.event('export.started'); // carries tenant + tool automatically

telemetry.setGlobalAttrs({ tool: undefined }); // remove one
telemetry.identify(null); // logout`;

  protected readonly http = `// nests the request span under the active caller span
this.http.post('/api/orders', body, {
  context: withTelemetryParent(span),
});`;

  protected readonly tracedSignal = `import { tracedSignal } from '@mmstack/telemetry-core';

const quantity = tracedSignal(1);

telemetry.span('add-item', () => quantity.update((q) => q + 1));
quantity.causedBy(); // the 'add-item' span`;

  protected readonly policy = `import { allowOnly, provideTelemetry } from '@mmstack/telemetry-core';

provideTelemetry({
  sinks: [vendorSink, internalSink],
  policy: (attrs, meta) =>
    meta.sink === 'vendor' ? allowOnly(['plan', 'step'])(attrs, meta) : attrs,
});`;
}
