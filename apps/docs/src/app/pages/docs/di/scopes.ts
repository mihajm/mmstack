import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-di-scopes',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Scopes and singletons"
      pkg="@mmstack/di"
      lead="Factory-built singletons: one per app, one per component subtree, or a plain value or factory provider. Plus a way to keep inject() working in async callbacks."
    >
      <docs-section title="rootInjectable" id="root-injectable">
        <p>
          <code>rootInjectable</code> builds an app-wide singleton from a
          factory, without writing a class. It returns an inject function; the
          instance is created lazily on first use and shared for the rest of the
          application. The factory receives the <code>Injector</code>, and since
          it is a token factory it stays SSR-safe: each server request gets its
          own instance.
        </p>
        <docs-code [code]="root" lang="ts" />
      </docs-section>

      <docs-section title="createScope" id="create-scope">
        <p>
          <code>createScope</code> gives a family of factory-built singletons
          scoped to a component subtree. It returns a
          <code>[register, provide]</code> pair. Provide the scope at a
          component, register item factories once, and every consumer under that
          boundary shares one instance. Two sibling boundaries get their own
          sets, and instances are destroyed with the provider.
        </p>
        <docs-code [code]="scope" lang="ts" />
        <p>
          The provide function takes <code>overrides</code>, pairs of
          <code>[injectFn, replacementFactory]</code> that swap a registration
          at that boundary only. Dependents pick up the override transitively,
          which is handy in tests and stories.
        </p>
      </docs-section>

      <docs-section title="provideAs" id="provide-as">
        <p>
          <code>provideAs</code> builds a <code>useValue</code> or
          <code>useFactory</code> provider depending on what you hand it. A
          function becomes a factory, anything else a value.
        </p>
        <docs-code [code]="provideAs" lang="ts" />
      </docs-section>

      <docs-section title="createRunInInjectionContext" id="run-in-context">
        <p>
          Some callbacks run outside Angular's injection context, like an
          external library's event listener, so <code>inject()</code> throws
          there. <code>createRunInInjectionContext</code> captures the context
          up front and returns a runner that restores it later.
        </p>
        <docs-code [code]="runInContext" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class DiScopes {
  protected readonly root = `import { rootInjectable } from '@mmstack/di';

const injectClock = rootInjectable(() => ({ now: () => Date.now() }));

// anywhere in the app, always the same instance
const clock = injectClock();`;

  protected readonly scope = `import { createScope } from '@mmstack/di';

const [register, provideFeatureScope] = createScope('FeatureScope');

// register an item factory (runs in the injection context)
const useFeatureItem = register(() => {
  const dep = inject(SomeDependency);
  return { id: crypto.randomUUID(), doWork: () => dep.work() };
});

@Component({
  providers: [provideFeatureScope()], // one set of instances per boundary
})
class Feature {}

// in any child of that boundary:
readonly item = useFeatureItem(); // same instance for this boundary`;

  protected readonly provideAs = `import { provideAs } from '@mmstack/di';

providers: [
  provideAs(CONFIG, { baseUrl: '/api' }),        // useValue
  provideAs(CLOCK, () => ({ now: () => Date.now() })), // useFactory
];`;

  protected readonly runInContext = `import { createRunInInjectionContext } from '@mmstack/di';

private runInContext = createRunInInjectionContext();

ngOnInit() {
  externalLib.on('open', () => {
    this.runInContext(() => {
      const dialog = inject(DialogService); // works inside the callback
      dialog.open();
    });
  });
}`;
}
