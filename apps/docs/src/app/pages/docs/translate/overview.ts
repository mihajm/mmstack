import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-translate-overview',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Translate"
      pkg="@mmstack/translate"
      lead="Internationalization that lives with your features instead of in one app-level bundle. Type-safe, signal-based, and built for monorepos, though it works in a single app too."
    >
      <docs-code [code]="install" lang="bash" />
      <p>
        The usual Angular i18n setup keeps every string in one catalog the whole
        app loads up front. That grows into a bottleneck, and in a monorepo it
        means unrelated teams editing the same file. This library takes a
        different path, and three things make it worth a look.
      </p>

      <docs-section title="Translations live with the feature" id="feature-level">
        <p>
          A namespace belongs to the feature or library that uses it, not to the
          app. In a monorepo, the <code>quote</code> library ships its own
          <code>quote</code> namespace and its own locale files, and nothing
          else needs to know they exist. You register a namespace with a lazy
          loader, so its translations arrive with the route that needs them
          rather than in the initial bundle.
        </p>
        <p>
          Nothing here assumes a monorepo. A single app groups its own strings
          the same way, one namespace per feature area, and gets the same
          on-demand loading. See
          <a mmLink="/docs/translate/namespaces">Namespaces</a> for the loading
          model.
        </p>
      </docs-section>

      <docs-section title="A wrong key is a build error" id="type-safe">
        <p>
          Translations are plain TypeScript, not JSON or XLIFF. A namespace is a
          <code>const</code> of ICU messages, and the compiler reads its shape:
          the nested keys become the valid keys, and each message's placeholders
          become the required parameters. So
          <code>t('quote.greeting', {{ '{' }} name {{ '}' }})</code> is checked
          like any other typed call. Rename a key and every call site fails to
          compile. Drop a required argument and the call fails. You find these at
          build time, not from a user.
        </p>
      </docs-section>

      <docs-section title="It is all signals" id="signals">
        <p>
          Everything you read is a signal: <code>t()</code>, the formatters, and
          the active locale. So the same call works in a template, a
          <code>computed</code>, or an <code>effect</code>, and it updates on its
          own when the locale changes, with no pipe and no subscription.
        </p>
        <docs-code [code]="templateEx" lang="html" />
        <p>
          Calling <code>t()</code> in a template stays cheap even with object
          parameters. Angular hands the same parameter object back across
          renders that don't change it, and the store keys its cached signals by
          that object through a <code>WeakMap</code>, so a render reuses one
          fine-grained signal rather than re-creating it or diffing the params.
        </p>
      </docs-section>

      <docs-section title="What it looks like" id="taste">
        <p>
          One file defines the strings, one registers them, and a component
          reads them. This is the whole loop.
        </p>
        <docs-code [code]="taste" lang="ts" />
        <p>
          The key on the component is autocompleted from the namespace, and the
          <code>{{ '{' }} min {{ '}' }}</code> argument is required because the
          ICU message declares it.
        </p>
      </docs-section>

      <docs-section title="Where to go next" id="pick">
        <table class="doc-table">
          <thead>
            <tr>
              <th>You want to</th>
              <th>Read</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Wire up locales (one build for all, or one per language)</td>
              <td>
                <a mmLink="/docs/translate/configuration">Configuration</a>
              </td>
            </tr>
            <tr>
              <td>Define translations and register them for lazy loading</td>
              <td><a mmLink="/docs/translate/namespaces">Namespaces</a></td>
            </tr>
            <tr>
              <td>Read a key in code or a template, switch language at runtime</td>
              <td>
                <a mmLink="/docs/translate/reading">Reading translations</a>
              </td>
            </tr>
            <tr>
              <td>Format a price, a date, or a relative time like "3 days ago"</td>
              <td><a mmLink="/docs/translate/formatters">Formatters</a></td>
            </tr>
            <tr>
              <td>Round-trip JSON with translators and gate CI on shape</td>
              <td><a mmLink="/docs/translate/tooling">Tooling</a></td>
            </tr>
          </tbody>
        </table>
      </docs-section>
    </docs-page>
  `,
})
export class TranslateOverview {
  protected readonly install = 'npm install @mmstack/translate @formatjs/intl';

  protected readonly templateEx = `@Component({
  template: \`<h1>{{ t('quote.pageTitle') }}</h1>\`,
})
export class QuoteComponent {
  protected readonly t = injectQuoteT();
  // the heading re-renders on its own when the locale changes
}`;

  protected readonly taste = `// quote.namespace.ts: the strings
const ns = createNamespace('quote', {
  pageTitle: 'Famous Quotes',
  errors: { minLength: 'Must be at least {min} characters.' },
});

// quote.t.ts: register it, get a typed t() and a route resolver
export const [injectQuoteT, resolveQuoteTranslations] = registerNamespace(
  () => import('./quote.namespace'),
  { 'sl-SI': () => import('./quote-sl.translation') },
);

// quote.component.ts: read it
export class QuoteComponent {
  protected readonly t = injectQuoteT();
  readonly title = this.t('quote.pageTitle');                     // ok
  readonly hint = this.t('quote.errors.minLength', { min: '5' }); // min required
}`;
}
