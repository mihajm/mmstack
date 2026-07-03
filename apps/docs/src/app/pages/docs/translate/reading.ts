import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-translate-reading',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Reading translations"
      pkg="@mmstack/translate"
      lead="The injected t() function reads a typed key with typed params. It is safe to call in templates, gives you a Signal&lt;string&gt; on demand, and there is a pipe and a directive for the cases that want them."
    >
      <p>
        Everything on this page is checked against the namespace you injected
        from. The key is autocompleted, and if the ICU message declares
        placeholders, the params object is required and typed. Passing
        <code>count</code> as a string to a message that expects a number is a
        compile error, not a garbled plural at runtime.
      </p>

      <docs-section title="Calling t()" id="t">
        <p>
          <code>injectQuoteT()</code> returns your namespace's <code>t</code>.
          Call it with a key, plus a params object when the message declares
          placeholders. It returns a plain <code>string</code>, so you can hold
          the result in a field, use it in logic, or read it straight in a
          template.
        </p>
        <docs-code [code]="t" lang="ts" />
        <p>
          Calling <code>t()</code> directly in a template is fine even though it
          runs every change detection pass. The result is memoized internally:
          the ICU formatter only re-runs when the locale changes or when the
          params actually change, so repeated passes cost nothing. That holds
          for inline object literals too, because Angular hands back the same
          object reference across passes when the literal's inputs are
          unchanged.
        </p>
        <docs-code [code]="template" lang="html" />
      </docs-section>

      <docs-section title="Reactive reads with asSignal" id="as-signal">
        <p>
          <code>t.asSignal(key, () =&gt; params)</code> returns a
          <code>Signal&lt;string&gt;</code> that re-evaluates when the locale
          changes or when the signal-based params change, with structural
          equality short-circuiting recomputes. Reach for it in two cases: when
          you need an actual signal to hold in a class field (say, to pass to an
          <code>&#64;Input</code>), or when params come from a fresh object each
          read and you want the structural short-circuit.
        </p>
        <docs-code [code]="asSignal" lang="ts" />
        <p>
          For a variable-free key, or a key with inline params in a template,
          you do not need this; plain <code>t()</code> is already memoized.
        </p>
      </docs-section>

      <docs-section title="Directive and pipe" id="template-helpers">
        <p>
          Some templates read better with a pipe or a directive. Both exist, but
          they are abstract, so you subclass them once per namespace to bind
          them to your <code>QuoteLocale</code> type. After that they are
          type-safe for that namespace's keys and params.
        </p>
        <docs-code [code]="helpers" lang="ts" label="quote.helpers.ts" />
        <p>
          The pipe validates the key and its variables like <code>t()</code>
          does. The directive replaces the host element's text content, which is
          handy for a plain heading or label with no other markup inside it.
        </p>
        <docs-code [code]="helperUse" lang="html" />
      </docs-section>

      <docs-section title="Recipe: switch language at runtime" id="switch">
        <p>
          In single-build mode (see
          <a mmLink="/docs/translate">the overview</a>),
          <code>injectDynamicLocale()</code> returns a
          <code>WritableSignal&lt;string&gt;</code> with an attached
          <code>isLoading</code> signal. Setting it triggers loading of any
          missing namespace translations for the new locale, and setting it to a
          value outside <code>supportedLocales</code> is a no-op with a dev-mode
          warning. Everything that read <code>t()</code> updates on its own once
          the chunk lands.
        </p>
        <docs-code [code]="switcher" lang="ts" label="language-switcher.ts" />
        <p>
          Pair it with <code>localeStorage</code> in
          <code>provideIntlConfig</code> to persist the choice across reloads.
          One gotcha lives here: a pure pipe memoizes by input identity, so it
          does not re-run when only the locale changes. Pass
          <code>locale()</code> as a pipe argument so its input changes, or mark
          the pipe <code>pure: false</code> to opt out of memoization (slower,
          since it then runs every change detection cycle).
        </p>
        <docs-code [code]="purePipe" lang="html" />
        <p>
          The load behind a switch is a resource under the hood.
          <code>injectLocaleLoadState()</code> exposes its read surface
          (<code>status</code>, <code>isLoading</code>, <code>hasValue</code>)
          without the writable ref, which is what lets a locale switch drive a
          <a mmLink="/docs/primitives/transitions">transition</a>: register it
          into a scope and the swap to the new language happens in one frame
          instead of flashing a spinner.
        </p>
      </docs-section>

      <docs-section title="Gotcha: params inside plural arms" id="withparams">
        <p>
          Parameter inference is one level deep, as TS instantiation would get
          overly deep for the 1% neseting use-case otherwise. A placeholder
          inside a
          <code>plural</code>, <code>select</code>, or
          <code>selectordinal</code>
          arm is not picked up automatically, so
          <code>{{ '{' }} name {{ '}' }}</code> sitting inside a plural arm
          would go untyped. Wrap the message with <code>withParams</code> at
          definition time to declare the missing params explicitly.
        </p>
        <docs-code [code]="withParams" lang="ts" />
        <p>
          Declared params are merged with the auto-extracted ones. Other-locale
          files for a wrapped key do not repeat the wrapper; they accept a plain
          string. The trade-off is that wrapping opts that one key out of the
          per-arm placeholder strictness in non-default locales, so use it only
          where inference cannot reach.
        </p>
      </docs-section>

      <docs-section title="Escape hatches for dynamic keys" id="unsafe">
        <p>
          The typed <code>t()</code> is the path you want almost always. But
          some keys are only known at runtime: content authored in a CMS,
          strings shipped by a backend, a key computed from data. For those,
          <code>injectUnsafeT()</code> returns an untyped <code>t</code> where
          the key is <code>string</code> and params are a plain
          <code>Record</code>, with no per-key checking. It reads and reacts the
          same way, and carries the same <code>asSignal</code> companion. It
          also spans namespaces, so use it when a cross-namespace lookup would
          be awkward through the typed functions.
        </p>
        <docs-code [code]="unsafe" lang="ts" />
        <p>
          To feed it, <code>injectAddTranslations()</code> registers a flat
          per-locale map of keys under a namespace at runtime, which is how you
          land translations fetched after bootstrap. If the whole namespace is
          remote and its keys are unknown at compile time, declare it up front
          with <code>registerRemoteNamespace</code>: same loader shape as
          <a mmLink="/docs/translate/namespaces"
            ><code>registerNamespace</code></a
          >, but the resulting <code>t</code> is typed as
          <code>{{ '{' }}ns{{ '}' }}.string</code> with
          <code>Record</code> params. Anything added this way is invisible to
          the <a mmLink="/docs/translate/tooling">tooling</a>, which reads
          static source only.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class ReadingDoc {
  protected readonly t = `import { injectQuoteT } from './quote.t';

export class QuoteComponent {
  protected readonly t = injectQuoteT();

  // no params
  readonly title = this.t('quote.pageTitle');

  // typed params, checked against the ICU message
  readonly minLength = this.t('quote.errors.minLength', { min: '5' });
}`;

  protected readonly template = `<!-- both memoized; the ICU formatter only runs when values change -->
<h1>{{ t('quote.pageTitle') }}</h1>
<span>{{ t('quote.errors.minLength', { min: '5' }) }}</span>`;

  protected readonly asSignal = `import { signal } from '@angular/core';
import { injectQuoteT } from './quote.t';

export class QuoteComponent {
  protected readonly count = signal(0);
  protected readonly t = injectQuoteT();

  // Signal<string>, recomputes on locale change or when count changes
  protected readonly stats = this.t.asSignal('quote.stats', () => ({
    count: this.count(), // must match the ICU parameter (type: number)
  }));
}`;

  protected readonly helpers = `import { Pipe, Directive } from '@angular/core';
import { Translator, Translate } from '@mmstack/translate';
import { type QuoteLocale } from './quote.namespace';

@Pipe({ name: 'translate' })
export class QuoteTranslator extends Translator<QuoteLocale> {}

@Directive({ selector: '[translate]' })
export class QuoteTranslate<TInput extends string> extends Translate<
  TInput,
  QuoteLocale
> {}`;

  protected readonly helperUse = `<!-- pipe validates key and variables -->
<span>{{ 'quote.errors.minLength' | translate: { min: '5' } }}</span>

<!-- directive replaces the element text content -->
<h1 translate="quote.pageTitle"></h1>
<span [translate]="['quote.errors.minLength', { min: '5' }]"></span>`;

  protected readonly switcher = `import { Component } from '@angular/core';
import { injectDynamicLocale } from '@mmstack/translate';

@Component({
  selector: 'app-language-switcher',
  template: \`
    <select [value]="locale()" (change)="onChange($event)">
      <option value="en-US">English</option>
      <option value="sl-SI">Slovenščina</option>
      <option value="fr-FR">Français</option>
    </select>
    @if (locale.isLoading()) {
      <span>Loading…</span>
    }
  \`,
})
export class LanguageSwitcher {
  protected readonly locale = injectDynamicLocale();

  protected onChange(event: Event) {
    this.locale.set((event.target as HTMLSelectElement).value);
  }
}`;

  protected readonly purePipe = `<!-- pass locale() so the pure pipe's input identity changes -->
{{ 'common.yes' | translate: locale() }}`;

  protected readonly unsafe = `import { injectUnsafeT, injectAddTranslations } from '@mmstack/translate';

export class CmsComponent {
  private readonly t = injectUnsafeT();
  private readonly add = injectAddTranslations();

  async ngOnInit() {
    const strings = await fetch('/api/i18n/banner').then((r) => r.json());
    // register a flat per-locale map under a namespace at runtime
    this.add('cms', {
      'en-US': strings.en,
      'sl-SI': strings.sl,
    });
  }

  // untyped: key is a string, params a plain record
  readonly title = this.t('cms.banner.title', { campaign: 'Summer' });
}`;

  protected readonly withParams = `import { createNamespace, withParams } from '@mmstack/translate';

const ns = createNamespace('quote', {
  // 'count' is auto-extracted; 'name' lives inside the plural arms, so declare it
  stats: withParams<{ name: string }>(
    '{count, plural, one {1 quote from {name}} other {# quotes from {name}}}',
  ),
});

// t inferred as: ('quote.stats', { count: number; name: string }) => string
t('quote.stats', { count: 3, name: 'Alice' });`;
}
