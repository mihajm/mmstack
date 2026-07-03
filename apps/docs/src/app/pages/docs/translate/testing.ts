import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-translate-testing',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Testing"
      pkg="@mmstack/translate"
      lead="Test a component that reads translations without loading real locale files. provideMockTranslations stands in for the whole translation store."
    >
      <docs-section title="Echo the keys" id="echo">
        <p>
          With no configuration, <code>provideMockTranslations()</code> makes
          every <code>t()</code> call return its key in dot notation. That is
          usually what you want in a unit test: you assert that the right key was
          rendered, not that a particular English string came back, so a copy
          change never breaks the spec.
        </p>
        <docs-code [code]="echo" lang="ts" />
      </docs-section>

      <docs-section title="Return real strings" id="strings">
        <p>
          When a test needs actual output, pass <code>translations</code> keyed
          by namespace. Add <code>formatValues: true</code> to run the ICU
          formatting over your parameters, so plural and select messages resolve
          the way they do at runtime.
        </p>
        <docs-code [code]="strings" lang="ts" />
        <p>
          Either way, no namespace loaders run and no locale files are fetched.
          The mock replaces the store, so a component under test reads
          translations synchronously.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class TranslateTestingDoc {
  protected readonly echo = `import { provideMockTranslations } from '@mmstack/translate';

TestBed.configureTestingModule({
  providers: [provideMockTranslations()],
});

// in the component, t('quote.pageTitle') now returns 'quote.pageTitle'
expect(el.textContent).toContain('quote.pageTitle');`;

  protected readonly strings = `import { provideMockTranslations } from '@mmstack/translate';

TestBed.configureTestingModule({
  providers: [
    provideMockTranslations({
      formatValues: true,
      translations: {
        quote: {
          pageTitle: 'Famous Quotes',
          count: '{n, plural, one {# quote} other {# quotes}}',
        },
      },
    }),
  ],
});`;
}
