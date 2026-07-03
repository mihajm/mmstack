import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-translate-configuration',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Configuration"
      pkg="@mmstack/translate"
      lead="Two modes: one build artifact per language, or a single build that loads languages at runtime."
    >
      <p>
        No need to worry, you can change this pretty easily if you ever change
        your mind. If you only ever ship one language, the default mode needs no
        configuration at all and you can skip most of this page.
      </p>

      <docs-section title="One build per language" id="multi-build">
        <p>
          The default mode behaves like <code>&#64;angular/localize</code>. It
          reads Angular's <code>LOCALE_ID</code> and expects a page reload to
          change language, which suits the traditional setup where each locale
          is its own build served from its own path. No provider from this
          library is required.
        </p>
        <docs-code
          [code]="multiBuild"
          lang="ts"
          label="app.config.ts (one build per language)"
        />
      </docs-section>

      <docs-section title="One build, languages at runtime" id="single-build">
        <p>
          <code>provideIntlConfig()</code> loads translations at runtime, so a
          single build serves every locale and the language can change without a
          reload. Name the default locale and list the ones you support. Reach
          for this when you want a language picker or a locale segment in the
          URL.
        </p>
        <docs-code
          [code]="singleBuild"
          lang="ts"
          label="app.config.ts (single build)"
        />
        <p>
          <code>supportedLocales</code> is the allowlist. A switch to a locale
          that is not on it is a no-op, so you cannot land in an unsupported
          state.
        </p>
      </docs-section>

      <docs-section title="Options" id="options">
        <p>
          Beyond the two required keys, <code>provideIntlConfig</code> takes a
          few optional ones:
        </p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>Option</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>localeParamName</code></td>
              <td>Drives the active locale from a route parameter.</td>
            </tr>
            <tr>
              <td><code>localeStorage</code></td>
              <td>
                Persists a user-picked locale across reloads. Mutually exclusive
                with <code>localeParamName</code>, since the URL would only
                fight it.
              </td>
            </tr>
            <tr>
              <td><code>preloadDefaultLocale</code></td>
              <td>
                Eagerly loads the default bundle so it is available as a
                synchronous fallback.
              </td>
            </tr>
            <tr>
              <td><code>releaseCachedSignals</code></td>
              <td>
                Holds cached translation signals weakly so they can be collected
                once the component that read them is destroyed. Off by default,
                since translation keys are a bounded set for most apps. Turn it
                on only for large apps under measured memory pressure, or ones
                that build keys dynamically.
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          The runtime switching side, including
          <code>injectDynamicLocale</code> and a language switcher, lives on the
          <a mmLink="/docs/translate/reading">Reading translations</a> page. To
          read the resolved configuration back,
          <code>injectDefaultLocale()</code> returns the active default and
          <code>injectSupportedLocales()</code> returns the allowlist (falling
          back to the default when none was set), which is handy for building a
          language picker from one source of truth.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class ConfigurationDoc {
  protected readonly multiBuild = `import { ApplicationConfig, LOCALE_ID } from '@angular/core';

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: LOCALE_ID, useValue: 'en-US' }, // set your locale
    // ...other providers
  ],
};`;

  protected readonly singleBuild = `import { ApplicationConfig, LOCALE_ID } from '@angular/core';
import { provideIntlConfig } from '@mmstack/translate';

export const appConfig: ApplicationConfig = {
  providers: [
    provideIntlConfig({
      defaultLocale: 'en-US',
      supportedLocales: ['en-US', 'sl-SI', 'de-DE', 'fr-FR'],
    }),
    // ...other providers
  ],
};`;
}
