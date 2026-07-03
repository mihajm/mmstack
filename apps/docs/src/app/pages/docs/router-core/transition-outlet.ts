import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-router-core-transition-outlet',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Transition outlet"
      pkg="@mmstack/router-core"
      lead="Every navigation with a plain router-outlet unmounts the current page and renders the next one in its loading state, so you flash a screen of spinners on each click. This outlet holds the current page on screen until the incoming one has its data, then swaps both in a single frame."
    >
      <p>
        The flash is baked into how the default outlet works. A route change
        destroys the old component immediately and mounts the new one, which
        then starts fetching, so there is always a beat where the page is empty
        or full of skeletons. <code>TransitionRouterOutlet</code> changes the
        timing. The current route stays mounted and visible while the incoming
        route mounts hidden and its data settles; only then do the two swap. It
        is the routing application of the same transition-scope machinery behind
        <a mmLink="/docs/primitives/transitions">&#64;mmstack/primitives</a>,
        which covers the same idea for tabs, switches, and any non-router view.
      </p>

      <docs-section title="mm-transition-outlet" id="transition-outlet">
        <p>
          <code>&lt;mm-transition-outlet /&gt;</code> is a drop-in replacement
          for <code>&lt;router-outlet /&gt;</code>. Swap the selector in your
          shell and you are done, no other config required. Under the hood it
          provides its own transition scope, and the incoming route's resources
          register into that scope so the outlet can tell when the route is
          actually ready.
        </p>
        <docs-code [code]="outlet" lang="ts" />
        <p>
          A resource joins the scope by registering. With
          <code>&#64;mmstack/resource</code> that is the <code>register</code>
          option; for a hand-rolled <code>ResourceRef</code> it is
          <code>registerResource()</code>. Once registered, the outlet waits on
          it, which is how it knows the difference between a route that is done
          and one that is still fetching.
        </p>
        <docs-code [code]="register" lang="ts" />
      </docs-section>

      <docs-section title="How it behaves" id="behavior">
        <ul>
          <li>
            <strong>First navigation mounts immediately.</strong> There is no
            previous view to hold, so the first paint is instant. From then on
            the outgoing route holds until the incoming one settles, then swaps
            and is destroyed.
          </li>
          <li>
            <strong>Settle means went in flight, then drained.</strong> The
            outlet waits for the incoming route's registered resources to start
            loading and then finish. A route that registers nothing, or errors
            out, swaps via a microtask fallback, so a data-less or failing route
            can never hang the hold.
          </li>
          <li>
            <strong>Composes with guards and resolvers.</strong> A denied
            <code>canActivate</code> leaves the current route untouched, nothing
            held, nothing leaked. A pending <code>resolve</code> holds at the
            router level first, then the outlet holds through the data load. It
            works nested inside a parent route's outlet too.
          </li>
          <li>
            <strong>Interruptions re-target the hold.</strong> Navigate again
            before the incoming route settles and the half-loaded view is
            destroyed; the stable view you were on stays visible until the new
            destination settles. You never get stranded on a torn intermediate
            state.
          </li>
          <li>
            <strong>Per-view isolation.</strong> The swap waits on the incoming
            view's resources only, so background work left running on the
            outgoing view, a <code>keepPrevious</code> poll for instance, cannot
            delay the swap.
          </li>
        </ul>
        <p>
          If a particular route should show its own skeleton instead of being
          held, set
          <code>data: {{ '{' }} immediateTransition: true {{ '}' }}</code> on
          it. It swaps in immediately, even while loading, and opts out of the
          hold for that route alone.
        </p>
      </docs-section>

      <docs-section title="View transitions" id="view-transitions">
        <p>
          The swap can be wrapped in the browser's View Transitions API, so the
          old view cross-fades into the new one according to your
          <code>::view-transition-*</code> CSS. It is feature-detected, so a
          browser without <code>document.startViewTransition</code> simply gets
          the instant swap. If you only want it on one outlet, set the attribute.
        </p>
        <docs-code [code]="viewTransitionAttr" lang="html" />
        <p>
          To use it alongside Angular's own router view transitions, wrap
          Angular's option with <code>mmRouterViewTransitions()</code> and no
          attribute is needed. The wrapper exists to fix a timing mismatch:
          Angular fires its transition at route activation, but under this outlet
          activation is visually inert, since the incoming view mounts hidden and
          the real visual change happens later at the swap. So the wrapper skips
          Angular's inert transition on held routes and fires the real one at the
          swap, while non-held routes transition normally. Set
          <code>[viewTransition]="false"</code> on an outlet to opt it out even
          when router view transitions are enabled app-wide.
        </p>
        <docs-code [code]="viewTransitionProvide" lang="ts" />
      </docs-section>

      <docs-section title="holdThroughNavigation" id="hold-through-navigation">
        <p>
          The outlet holds the previous <em>view</em> when you navigate between
          two different routes. But some resources persist across a navigation
          and have no view swap to hide behind: an app-shell or layout resource
          that lives above the outlet, or a route reused on a param change
          (<code>/users/1</code> to <code>/users/2</code>, same component). Those
          just refetch in place and flash to loading. This is the signal-level
          answer to that case.
        </p>
        <p>
          <code>holdThroughNavigation</code> wraps any resource,
          <code>&#64;mmstack/resource</code>'s <code>queryResource</code>,
          Angular's <code>httpResource</code>, or a plain <code>resource()</code>,
          and returns a stabilized <code>Resource</code> whose state cannot flash
          during a navigation.
        </p>
        <docs-code [code]="hold" lang="ts" />
        <ul>
          <li>
            <strong>During a navigation</strong> the whole snapshot (value,
            status, error, loading) is frozen at the pre-navigation state, so a
            refetch the navigation triggers shows no torn or loading state.
          </li>
          <li>
            <strong>On success or skip</strong> it reveals, and it is
            settle-aware: the last settled snapshot is held through the first
            load cycle the navigation triggers, then revealed when it lands.
            Later reloads pass through live until the next navigation, so a
            manual <code>reload()</code> still shows its indicator.
          </li>
          <li>
            <strong>On a true rollback</strong> (a <code>NavigationError</code>,
            or a <code>NavigationCancel</code> that is not a redirect or
            superseded) it holds the pre-navigation snapshot until the resource
            stops loading, so a cancelled refetch reveals the route you stayed
            on, never the one you did not reach.
          </li>
        </ul>
        <p>
          What you get back is a read-only <code>Resource</code> plus
          <code>reload()</code>, a drop-in anywhere a resource is read.
        </p>
      </docs-section>

      <docs-section title="Flash-free route-data param navigation" id="hold-route-data">
        <p>
          This composition earns its own note because it fills a real gap. On a
          reused route, <code>/users/1</code> to <code>/users/2</code>, the
          component stays mounted and only the param changes. There is no view
          swap, so the transition outlet has nothing to hold. The route's data
          just refetches in place and flashes to loading, exactly the case the
          outlet alone cannot cover.
        </p>
        <p>
          Because <a mmLink="/docs/router-core/route-data">route data</a> hands
          you the resource ref directly, you can wrap it. Feed
          <code>injectRouteData</code> through <code>holdThroughNavigation</code>
          and the same instance the route started now holds its state across the
          param navigation instead of flashing.
        </p>
        <docs-code [code]="holdRouteData" lang="ts" />
      </docs-section>

      <docs-section title="Three tools, three scopes" id="three-tools">
        <p>
          These stack, and each holds a different thing. The
          <a mmLink="/docs/router-core/transition-outlet#transition-outlet">transition outlet</a>
          holds the outgoing <em>view</em> across a cross-route navigation.
          <code>holdThroughNavigation</code> holds a persisted
          <em>resource</em>'s state across the navigation lifecycle, rollback
          included, for the cases with no view swap. And a
          <a mmLink="/docs/primitives/transitions">transition scope</a> holds a
          <em>value</em> while its registered resources load. Reach for the one
          whose unit matches what would otherwise flash.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class TransitionOutletDoc {
  protected readonly outlet = `import { Component } from '@angular/core';
import { TransitionRouterOutlet } from '@mmstack/router-core';

@Component({
  selector: 'app-shell',
  imports: [TransitionRouterOutlet],
  template: \`<mm-transition-outlet />\`,
})
export class AppShell {}`;

  protected readonly register = `// the incoming route registers its data so the outlet knows when to swap
@Component({ selector: 'user-page', template: \`{{ user.value()?.name }}\` })
export class UserPage {
  readonly user = queryResource<User>(() => \`/api/users/\${this.id()}\`, {
    register: 'indicator',
  });
}`;

  protected readonly viewTransitionAttr = `<mm-transition-outlet viewTransition />`;

  protected readonly viewTransitionProvide = `import { provideRouter, withViewTransitions } from '@angular/router';
import { mmRouterViewTransitions } from '@mmstack/router-core';

provideRouter(routes, withViewTransitions(mmRouterViewTransitions()));`;

  protected readonly hold = `import { holdThroughNavigation } from '@mmstack/router-core';

@Component({ selector: 'user-page', template: \`{{ user.value()?.name }}\` })
export class UserPage {
  private readonly id = injectParam('id'); // your param signal
  // a reused route on param change refetches in place, stabilize it
  readonly user = holdThroughNavigation(
    queryResource<User>(() => \`/api/users/\${this.id()}\`),
  );
}`;

  protected readonly holdRouteData = `import { holdThroughNavigation, injectRouteData } from '@mmstack/router-core';

@Component({ selector: 'user-page', template: \`{{ user.value()?.name }}\` })
export class UserPage {
  // same instance the route started, now held across /users/1 → /users/2
  readonly user = holdThroughNavigation(injectRouteData(USER));
}`;
}
