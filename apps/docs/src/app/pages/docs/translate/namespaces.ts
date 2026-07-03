import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-translate-namespaces',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Namespaces"
      pkg="@mmstack/translate"
      lead="A namespace is one feature's set of translations. You define the default locale as a TypeScript const, then register that plus a loader per other locale so each language loads on demand."
    >
      <p>
        Grouping strings by feature (a <code>quote</code> namespace, a
        <code>userProfile</code> namespace, a <code>common</code> one) is what
        makes lazy loading work: a route only pulls in the translations it
        needs, and the default locale for one feature is not tied to another's.
        The shape of the default-locale object is also the source of truth for
        type checking, so every other locale is validated against it.
      </p>

      <docs-section title="Defining a namespace" id="create-namespace">
        <p>
          Write the default-locale translations as a plain nested object and
          pass them to <code>createNamespace</code> with a name. Values are ICU
          messages, so a placeholder like <code>{{ '{' }} name {{ '}' }}</code>
          declares a parameter, and <code>plural</code> or <code>select</code>
          arms work as usual. The nested shape becomes the set of valid keys,
          and each message's placeholders become that key's required parameters.
        </p>
        <docs-code [code]="create" lang="ts" label="quote.namespace.ts" />
        <p>
          The three exports at the bottom each have a job. The
          <code>default</code> export is the compiled translation the loader
          picks up. <code>QuoteLocale</code> is the type you hand to the pipe
          and directive later (see
          <a mmLink="/docs/translate/reading">Reading translations</a>). And
          <code>createQuoteTranslation</code> is the factory every other locale
          is authored through, which is what enforces the shape.
        </p>
      </docs-section>

      <docs-section title="Recipe: add a new locale" id="add-locale">
        <p>
          Adding French to an app that already speaks English and Slovenian is
          two edits. First, a new file authored through the factory. Because
          <code>createQuoteTranslation</code> is typed to the default shape, a
          missing key, an extra key, or a dropped placeholder is a compile
          error, so you cannot ship a half-translated file by accident. The
          placeholders have to match, but the surrounding words do not, and ICU
          arms can differ per language (French, like Slovenian, has its own
          plural categories).
        </p>
        <docs-code [code]="other" lang="ts" label="quote-fr.translation.ts" />
        <p>
          Second, register the loader (the next section covers the call). That
          is the whole change; nothing in the components that read
          <code>quote.*</code> keys has to move.
        </p>
      </docs-section>

      <docs-section title="Registering for lazy loading" id="register-namespace">
        <p>
          <code>registerNamespace</code> takes the default-locale loader and a
          map of the other locales, each a
          <code>() =&gt; Promise&lt;...&gt;</code> factory. It returns a
          <code>[injectT, resolveTranslations]</code> tuple. Tuple destructuring
          lets each call site pick its own names, which reads better once you
          have more than one namespace in play.
        </p>
        <docs-code [code]="register" lang="ts" label="quote.t.ts" />
        <p>
          A loader can return a compiled translation directly, or an ES module
          that exposes one as <code>default</code> or as a named
          <code>translation</code> export. The library unwraps all three, so a
          bare dynamic <code>import()</code> is the shortest form and the one to
          reach for. The explicit <code>.then((m) =&gt; m.default)</code> shape
          stays useful when one module re-exports several namespaces.
        </p>
      </docs-section>

      <docs-section title="Recipe: lazy-load via a route resolver" id="resolver">
        <p>
          The second element of the tuple is a route resolver. Wire it into the
          route that owns the feature and the matching locale chunk loads before
          the component activates, so the view never renders a missing key or a
          flash of the fallback language. Only the active locale's chunk loads,
          not all of them.
        </p>
        <docs-code [code]="route" lang="ts" label="quote.routes.ts" />
        <p>
          This is the standard way to load a feature's strings. If you want the
          chunk to warm on link hover instead of at navigation, the
          <a mmLink="/docs/router-core">&#64;mmstack/router-core</a> prefetch
          integration pairs with the resolver so a later navigation resolves
          instantly.
        </p>
      </docs-section>

      <docs-section title="Recipe: share Save and Cancel across features" id="shared">
        <p>
          Strings like Save, Cancel, Yes, and No belong in one place, not copied
          into every feature. Define them once in a shared namespace and export
          its <code>createMergedNamespace</code> factory. Any namespace built
          through that factory can read the common keys type-safely alongside
          its own.
        </p>
        <docs-code [code]="shared" lang="ts" label="common.namespace.ts" />
        <p>
          A feature then builds on it with <code>createAppNamespace</code> in
          place of <code>createNamespace</code>. Its injected <code>t</code> now
          resolves both <code>quote.pageTitle</code> and <code>common.save</code>,
          both fully typed.
        </p>
        <docs-code [code]="merged" lang="ts" label="quote.namespace.ts" />
        <p>
          Register the common namespace's resolver at the top level of your
          route tree so the shared strings load before any feature that reads
          them. The tooling knows about this too: exported common keys live in
          their own file with no duplication, so
          <a mmLink="/docs/translate/tooling"><code>mmtranslate</code></a>
          round-trips them once.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class NamespacesDoc {
  protected readonly create = `import { createNamespace } from '@mmstack/translate';

const ns = createNamespace('quote', {
  pageTitle: 'Famous Quotes',
  greeting: 'Hello {name}!',
  detail: {
    authorLabel: 'Author',
  },
  errors: {
    minLength: 'Quote must be at least {min} characters long.',
  },
  stats: '{count, plural, one {# quote} other {# quotes}} available',
});

export default ns.translation;
export type QuoteLocale = (typeof ns)['translation'];
export const createQuoteTranslation = ns.createTranslation;`;

  protected readonly other = `import { createQuoteTranslation } from './quote.namespace';

// The shape is checked against the default locale: a missing key, an extra
// key, or a dropped {name}/{min}/{count} placeholder is a compile error.
export default createQuoteTranslation('fr-FR', {
  pageTitle: 'Citations Célèbres',
  greeting: 'Bonjour {name} !',
  detail: {
    authorLabel: 'Auteur',
  },
  errors: {
    minLength: 'La citation doit comporter au moins {min} caractères.',
  },
  stats: '{count, plural, one {# citation} other {# citations}} disponibles',
});`;

  protected readonly register = `import { registerNamespace } from '@mmstack/translate';

export const [injectQuoteT, resolveQuoteTranslations] = registerNamespace(
  // default locale, also the fallback
  () => import('./quote.namespace'),
  {
    // other locales, each a () => Promise<...> factory
    'sl-SI': () => import('./quote-sl.translation'),
    'fr-FR': () => import('./quote-fr.translation'), // the new one
  },
);`;

  protected readonly route = `import { type Routes } from '@angular/router';
import { resolveQuoteTranslations } from './quote.t';

export const QUOTE_ROUTES: Routes = [
  {
    path: '',
    component: QuoteComponent,
    resolve: {
      // loads the active locale's chunk before the component activates
      translations: resolveQuoteTranslations,
    },
  },
];`;

  protected readonly shared = `import { createNamespace } from '@mmstack/translate';

const ns = createNamespace('common', {
  yes: 'Yes',
  no: 'No',
  save: 'Save',
  cancel: 'Cancel',
});

export default ns.translation;
export type CommonLocale = (typeof ns)['translation'];
export const createCommonTranslation = ns.createTranslation;

// other namespaces build on this to reach 'common.*' keys type-safely
export const createAppNamespace = ns.createMergedNamespace;`;

  protected readonly merged = `import { createAppNamespace } from '@org/common';

const ns = createAppNamespace('quote', {
  pageTitle: 'Famous Quotes',
  // ...quote's own keys
});

// t() now resolves both 'quote.pageTitle' and 'common.save'
export default ns.translation;`;
}
