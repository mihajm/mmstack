import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-observability',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Observability"
      pkg="@mmstack/primitives"
      lead="An optional listener seam on the concurrency layer. Install a listener and you receive events as transition scopes coordinate pending, suspense, and transaction windows. Install nothing and the taps compile to no-ops, so there is no cost when it is off."
    >
      <p>
        Component devtools tell you what re-rendered. They cannot easily tell you
        why a boundary was pending or how long a transaction held. A
        <a mmLink="/docs/primitives/transitions">transition scope</a> knows both,
        because it is the thing coordinating the async state, so it is the right
        place to observe from.
      </p>

      <docs-section title="The listener" id="listener">
        <p>
          <code>ConcurrencyInstrumentation</code> is a set of optional hooks.
          The window-shaped ones (<code>pendingStart</code>/<code>pendingEnd</code>,
          <code>transactionStart</code>/<code>transactionEnd</code>) return a
          handle passed back to their end, and carry a timestamp. That shape is
          deliberately the same as a telemetry span, so forwarding to
          <code>&#64;mmstack/telemetry-core</code> is a direct mapping. The
          event-shaped ones report resource registration and abort.
        </p>
        <docs-code [code]="provide" lang="ts" />
      </docs-section>

      <docs-section title="DevTools performance tracks" id="perf">
        <p>
          <code>perfCustomTracks()</code> is a ready listener that writes a
          <code>performance.measure</code> for each pending and transaction
          window onto a custom track in the Chrome DevTools Performance panel. It
          has no dependencies and no backend, so it is a dev-only way to see
          reactive coordination on the same timeline as everything else the
          browser records.
        </p>
        <docs-code [code]="perf" lang="ts" />
      </docs-section>

      <docs-section title="Forwarding to telemetry" id="telemetry">
        <p>
          Because the window hooks are span-shaped, a listener that binds them to
          an injected <code>TELEMETRY</code> facade is a few lines. Every event
          can carry a category, so consent gates the whole subsystem with one
          requirement.
        </p>
        <docs-code [code]="forward" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class ObservabilityDoc {
  protected readonly provide = `import {
  provideConcurrencyInstrumentation,
  type ConcurrencyInstrumentation,
} from '@mmstack/primitives';

const listener: ConcurrencyInstrumentation = {
  pendingStart: (e) => ({ scope: e.scope, at: e.at }),
  pendingEnd: (handle, e) => report(handle, e.at),
  resourceRegistered: (e) => count(e.scope, +1),
  abortPending: (e) => log('aborted', e.aborted, 'in', e.scope),
};

// at the app or a boundary
providers: [provideConcurrencyInstrumentation(listener)];`;

  protected readonly perf = `import { perfCustomTracks, provideConcurrencyInstrumentation } from '@mmstack/primitives';

providers: [provideConcurrencyInstrumentation(perfCustomTracks())];
// pending and transaction windows now appear on an "mmstack" track in the
// DevTools Performance panel`;

  protected readonly forward = `import { inject } from '@angular/core';
import { TELEMETRY } from '@mmstack/telemetry-core';
import {
  CONCURRENCY_INSTRUMENTATION,
  type ConcurrencyInstrumentation,
} from '@mmstack/primitives';

// resolve the facade once at provide time, then close over it in the hooks
export const provideConcurrencyTelemetry = () => ({
  provide: CONCURRENCY_INSTRUMENTATION,
  useFactory: (): ConcurrencyInstrumentation => {
    const telemetry = inject(TELEMETRY);
    return {
      pendingStart: (e) =>
        telemetry.startSpan('mm.pending', { attrs: { scope: e.scope }, category: 'perf' }),
      pendingEnd: (span) => (span as { end(): void }).end(),
    };
  },
});`;
}
