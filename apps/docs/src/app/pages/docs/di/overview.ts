import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-di-overview',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="DI"
      pkg="@mmstack/di"
      lead="Angular's dependency injection with the sharp edges filed off. Typed token-and-provider pairs instead of InjectionToken boilerplate, services that lazy-load their own code chunk, and factory-built singletons. Each is a thin named helper over the DI you already use."
    >
      <docs-code [code]="install" lang="bash" />
      <p>
        These sit on top of Angular's own DI rather than replacing it. If
        <code>inject()</code> or <code>providedIn: 'root'</code> already fits,
        use those. Reach for these when the boilerplate or the timing gets in
        the way.
      </p>

      <docs-section title="Picking one" id="picking">
        <table class="doc-table">
          <thead>
            <tr>
              <th>You want to</th>
              <th>Reach for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>A typed token with a provide/inject pair, no boilerplate</td>
              <td><a mmLink="/docs/di/injectable"><code>injectable</code></a></td>
            </tr>
            <tr>
              <td>Defer constructing an already-bundled service until first use</td>
              <td><a mmLink="/docs/di/lazy-async"><code>injectLazy</code></a></td>
            </tr>
            <tr>
              <td>Lazy-load the code for a non-root service, or support v19 to v21</td>
              <td><a mmLink="/docs/di/lazy-async"><code>injectAsync</code></a></td>
            </tr>
            <tr>
              <td>Declare a lazy dependency in providers, inject it deep below</td>
              <td><a mmLink="/docs/di/lazy-async"><code>provideLazy</code></a></td>
            </tr>
            <tr>
              <td>A factory-built app-wide singleton</td>
              <td><a mmLink="/docs/di/scopes"><code>rootInjectable</code></a></td>
            </tr>
            <tr>
              <td>Factory-built singletons scoped to a component subtree</td>
              <td><a mmLink="/docs/di/scopes"><code>createScope</code></a></td>
            </tr>
            <tr>
              <td>Run <code>inject()</code> later, in a callback that lost context</td>
              <td>
                <a mmLink="/docs/di/scopes"><code>createRunInInjectionContext</code></a>
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          On Angular v22 and up, if the service you want to lazy-load is
          auto-provided (<code>providedIn: 'root'</code> or <code>&#64;Service()</code>),
          Angular's own <code>injectAsync</code> is all you need. This library's
          version is for the cases the built-in cannot cover.
        </p>
      </docs-section>

      <docs-section title="A note on SSR" id="ssr">
        <p>
          The fallbacks on <code>injectable</code> and
          <code>rootInjectable</code> singletons are token factories, which
          Angular caches per root injector. Every server request gets its own
          root injector, so each request builds its own instance. You can define
          these at module scope without state leaking between requests, tests,
          or multiple apps on a page.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class DiOverview {
  protected readonly install = 'npm install @mmstack/di';
}
