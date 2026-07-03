import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-router-core-state',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Reactive router state"
      pkg="@mmstack/router-core"
      lead="The router already knows the current URL and query params. Getting at them from a component usually means subscribing to an observable, unsubscribing, and mirroring the value into local state. These helpers hand you the same information as plain signals instead."
    >
      <p>
        If your component derives something from the URL, a filter read from
        <code>?q=</code>, a page number, the active tab, you have probably
        written the subscribe-store-unsubscribe dance more than once. A signal
        removes all of it: read it in a computed, read it in a template, and it
        stays current on its own. That is the whole idea here. Three helpers,
        each one a signal over a piece of router state.
      </p>

      <docs-section title="url" id="url">
        <p>
          <code>url</code> is the simplest of the three: a read-only signal that
          holds the current router URL. It updates after every successful
          navigation and reflects the URL after redirects, so what you read is
          where you actually are. It also initializes synchronously with the
          router's current URL, which means you can read it in a computed or a
          template on first render without guarding for an empty value.
        </p>
        <docs-code [code]="urlSnippet" lang="ts" />
        <p>
          Reach for it whenever a component needs to react to the current path,
          highlighting a nav item, showing a different header per section,
          without threading <code>ActivatedRoute</code> subscriptions through
          the component.
        </p>
      </docs-section>

      <docs-section title="navigationEndTick" id="navigation-end-tick">
        <p>
          Some navigations do not change the URL string. Landing on
          <code>/</code> for the first time, an
          <code>onSameUrlNavigation: 'reload'</code>, a redirect that lands you
          back where you were: in all of these the router navigated, but a
          signal over the URL string sees no change and does not fire. If you
          are deriving something from a router-state snapshot, that stale read
          is a real bug.
        </p>
        <p>
          <code>navigationEndTick</code> is a counter that increments on every
          successful navigation, same-URL ones included. Read it inside a
          computed and that computed recomputes once per navigation regardless
          of whether the URL text moved. It is the reliable key for anything
          you pull off <code>router.routerState.snapshot</code>.
        </p>
        <docs-code [code]="tick" lang="ts" />
      </docs-section>

      <docs-section title="queryParam" id="query-param">
        <p>
          <code>queryParam</code> is the read-and-write one. It returns a
          <code>WritableSignal</code> bound to a single URL query parameter.
          Reading gives the current value, or <code>null</code> when the param
          is absent. Setting a value writes it into the URL; setting
          <code>null</code> removes it. It reacts to external navigation too, so
          if the URL changes from a link or a back button, the signal updates
          to match.
        </p>
        <docs-code [code]="queryParam" lang="ts" />
        <p>
          Writes use <code>queryParamsHandling: 'merge'</code>, so setting one
          param leaves the others untouched. There is one sharp edge worth
          knowing: each <code>set()</code> navigates immediately, rebuilding
          from the pre-navigation URL. Write two params in the same tick and the
          second overwrites the first, because it never saw the first write.
          Pass <code>batch: true</code> when you intend to update several params
          together and want a single navigation that keeps all of them.
        </p>
      </docs-section>

      <docs-section title="Typed and tuned params" id="typed">
        <p>
          URL params are always strings, but you rarely want them as strings.
          The second argument to <code>queryParam</code> lets you type and tune
          the signal. Provide both <code>parse</code> and <code>serialize</code>
          and the signal becomes a <code>WritableSignal&lt;T | null&gt;</code>:
          <code>parse</code> runs on a present param, an absent one reads as
          <code>null</code> without calling <code>parse</code>, and a
          <code>serialize</code> that returns <code>null</code> drops the param
          from the URL. That last detail is how you keep default values out of
          the URL, page 1 does not need to show up as <code>?page=1</code>.
        </p>
        <docs-code [code]="typed" lang="ts" />
        <p>
          The remaining options handle write behavior.
          <code>replaceUrl</code> writes without pushing a history entry, which
          is the right call for a type-ahead box you do not want cluttering the
          back button. <code>debounce</code> delays writes by a number of
          milliseconds while reads stay instant, so the input feels live but the
          URL only updates when the user pauses. And <code>route</code> binds
          the signal to a specific <code>ActivatedRoute</code> instead of the
          injected one, for the rare case where that matters.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class RouterStateDoc {
  protected readonly urlSnippet = `import { Component } from '@angular/core';
import { url } from '@mmstack/router-core';

@Component({
  selector: 'app-header',
  template: \`<nav>Current path: {{ currentUrl() }}</nav>\`,
})
export class HeaderComponent {
  protected readonly currentUrl = url();
}`;

  protected readonly tick = `const tick = navigationEndTick(inject(Router));

const leaf = computed(() => {
  tick(); // recompute per navigation, even same-URL reloads
  let r = router.routerState.snapshot.root;
  while (r.firstChild) r = r.firstChild;
  return r;
});`;

  protected readonly queryParam = `import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { queryParam } from '@mmstack/router-core';

@Component({
  selector: 'app-search-page',
  imports: [FormsModule],
  template: \`
    <input [(ngModel)]="searchTerm" placeholder="Search..." />
    <button (click)="searchTerm.set(null)" [disabled]="!searchTerm()">Clear</button>
    <p>Current search: {{ searchTerm() ?? 'None' }}</p>
  \`,
})
export class SearchPageComponent {
  protected readonly searchTerm = queryParam('q');
}`;

  protected readonly typed = `// number-typed page param
readonly page = queryParam<number>('page', {
  parse: (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  },
  serialize: (n) => (n <= 1 ? null : String(n)), // page 1 keeps the URL clean
});

// debounced type-ahead, no history spam while typing
readonly q = queryParam('q', { replaceUrl: true, debounce: 300 });`;
}
