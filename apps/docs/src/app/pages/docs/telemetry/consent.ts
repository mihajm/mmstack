import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-telemetry-consent',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Consent"
      pkg="@mmstack/telemetry-core"
      lead="Headless and reactive. Declare what the app wants to track, tag emits with a category, and the facade gates delivery on the decisions. No UI ships here: a signal tells you exactly what to prompt for."
    >
      <docs-section title="Declaring requirements" id="requirements">
        <p>
          Pass a <code>consent</code> config to <code>provideTelemetry</code>.
          Each requirement names a category and, optionally, the sink it applies
          to. An emit opts into a category through the last argument.
        </p>
        <docs-code [code]="setup" lang="ts" />
      </docs-section>

      <docs-section title="Prompting and deciding" id="deciding">
        <p>
          <code>pending()</code> is exactly the set of requirements without a
          decision yet, so it is what you render a prompt for.
          <code>decide(id, granted)</code> records an answer, and (with a store)
          persists it. Because requirements can be a signal, when a new section
          of the app needs new tracking, <code>pending()</code> becomes just the
          delta, and you re-prompt for only the new items.
        </p>
        <docs-code [code]="prompt" lang="ts" />
      </docs-section>

      <docs-section title="How gating works" id="gating">
        <p>
          The default mode is <code>'required'</code>: a categorized emit needs
          an explicit grant, and an undecided or undeclared category is dropped.
          You cannot track something you did not ask consent for. Set
          <code>mode: 'implicit'</code> to flip that to opt-out. Uncategorized
          emits are never gated.
        </p>
        <p>
          While an async store hydrates a returning visitor's decisions, an
          undecided emit is held briefly and then delivered or dropped according
          to what was stored, so a stored denial is never raced by an early
          emit.
        </p>
      </docs-section>

      <docs-section title="Persistence" id="persistence">
        <p>
          <code>localStorageConsentStore()</code> persists decisions in the
          browser and is a noop on the server. The <code>ConsentStore</code>
          interface allows an async <code>get</code>/<code>set</code>, so a
          server-side store works the same way.
        </p>
        <docs-code [code]="store" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class TelemetryConsent {
  protected readonly setup = `import { provideTelemetry } from '@mmstack/telemetry-core';
import { posthogSink } from '@mmstack/telemetry-posthog';

provideTelemetry({
  sinks: [posthogSink({ posthog })],
  consent: {
    requirements: [
      { id: 'analytics', category: 'analytics', purpose: 'Anonymous product analytics' },
    ],
  },
});

telemetry.event('checkout', { plan: 'pro' }, { category: 'analytics' });`;

  protected readonly prompt = `// in your consent prompt component
const pending = telemetry.pending();  // requirements still needing an answer

telemetry.decide('analytics', true);  // grant
telemetry.decide('analytics', false); // deny`;

  protected readonly store = `import { localStorageConsentStore, provideTelemetry } from '@mmstack/telemetry-core';

provideTelemetry({
  sinks: [posthogSink({ posthog })],
  consent: {
    requirements: [{ id: 'analytics', category: 'analytics', purpose: '...' }],
    store: localStorageConsentStore(),
  },
});`;
}
