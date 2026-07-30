import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-router-core-overview',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="router-core"
      pkg="@mmstack/router-core"
      lead="Angular's router is solid, but reading its state means subscribing to observables, and every navigation flashes to loading. These helpers hand you router state as signals, drive titles and menus straight from your Routes, preload lazy chunks before the click, and hold the old view on screen until the new one is ready."
    >
      <docs-code [code]="install" lang="bash" />
      <p>
        Nothing here replaces the router. Your <code>Routes</code> config,
        guards, and resolvers stay exactly as they are. Every helper is opt-in,
        so you can pull in the reactive <code>url</code> signal on a Tuesday and
        never touch the rest, or wire up the transition outlet the week after.
        Pick what solves a problem you actually have.
      </p>

      <docs-section title="Start here" id="picking">
        <p>
          Each row is a thing you might be trying to do and where to go for it.
          If you are new, the reactive state helpers are the gentlest entry
          point; the transition outlet is the one people remember.
        </p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>You want to</th>
              <th>Reach for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Read the current URL or a query param as a signal</td>
              <td>
                <a mmLink="/docs/router-core/state"
                  ><code>url</code>, <code>queryParam</code></a
                >
              </td>
            </tr>
            <tr>
              <td>Recompute per navigation, even same-URL reloads</td>
              <td>
                <a mmLink="/docs/router-core/state"
                  ><code>navigationEndTick</code></a
                >
              </td>
            </tr>
            <tr>
              <td>Preload a lazy route's chunk on hover or visibility</td>
              <td>
                <a mmLink="/docs/router-core/preloading"
                  ><code>mmLink</code>, <code>PreloadStrategy</code></a
                >
              </td>
            </tr>
            <tr>
              <td>Preload imperatively, from an effect or a shortcut</td>
              <td>
                <a mmLink="/docs/router-core/preloading"
                  ><code>injectTriggerPreload</code></a
                >
              </td>
            </tr>
            <tr>
              <td>
                Fetch a route's data at the resolve phase, before the component
              </td>
              <td>
                <a mmLink="/docs/router-core/route-data"
                  ><code>createRouteData</code>, <code>injectRouteData</code></a
                >
              </td>
            </tr>
            <tr>
              <td>
                Hold the old view on screen until the new one's data settles
              </td>
              <td>
                <a mmLink="/docs/router-core/transition-outlet"
                  ><code>mm-transition-outlet</code></a
                >
              </td>
            </tr>
            <tr>
              <td>
                Stabilize a persisted resource so it never flashes
                mid-navigation
              </td>
              <td>
                <a mmLink="/docs/router-core/transition-outlet"
                  ><code>holdThroughNavigation</code></a
                >
              </td>
            </tr>
            <tr>
              <td>
                Run scroll, focus, or analytics work when the new route is
                actually on screen
              </td>
              <td>
                <a mmLink="/docs/router-core/visual-commit"
                  ><code>injectVisualCommit</code></a
                >
              </td>
            </tr>
            <tr>
              <td>
                Restore scroll and announce route changes after the swap
              </td>
              <td>
                <a mmLink="/docs/router-core/visual-commit"
                  ><code>provideTransitionScrollRestoration</code>,
                  <code>provideRouteA11y</code></a
                >
              </td>
            </tr>
            <tr>
              <td>Rebuild a lazy subtree or swap a route's definition at runtime</td>
              <td>
                <a mmLink="/docs/router-core/runtime-config"
                  ><code>injectRemountHandle</code>,
                  <code>mountSwitchRoute</code></a
                >
              </td>
            </tr>
            <tr>
              <td>
                Set the document title, breadcrumbs, or nav menus from routes
              </td>
              <td>
                <a mmLink="/docs/router-core/route-ui"
                  ><code>createTitle</code>, <code>createBreadcrumb</code>,
                  <code>createNavItems</code></a
                >
              </td>
            </tr>
          </tbody>
        </table>
      </docs-section>

      <docs-section title="Built for any resource" id="no-resource-dep">
        <p>
          The transition outlet and route-level data both build on the
          transition-scope primitive from
          <a mmLink="/docs/primitives/transitions">&#64;mmstack/primitives</a>.
          That primitive tracks readiness, not fetching, so
          <code>&#64;mmstack/router-core</code> never imports a resource
          library. Your factory is the one and only place a resource gets named.
        </p>
        <p>
          In practice that means you reach for
          <code>&#64;mmstack/resource</code>'s <code>queryResource</code>,
          Angular's own <code>httpResource</code>, or anything that hands back a
          <code>ResourceRef</code>, and the router pieces work the same way
          regardless. You are not locked into a data layer to use the routing
          layer.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class RouterCoreOverview {
  protected readonly install = 'npm install @mmstack/router-core';
}
