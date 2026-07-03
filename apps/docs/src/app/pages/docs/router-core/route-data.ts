import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-router-core-route-data',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Route-level data"
      pkg="@mmstack/router-core"
      lead="Fetching at construction time or ngOnInit means the component mounts, then constructs, then asks for data, three round trips before the request even leaves. Route-level data moves the fetch to the resolve phase: the request is in flight before the component exists, and the component just reads the result."
    >
      <p>
        There is an old tension in Angular routing. Fetch in the component and
        you get a waterfall, the view has to exist before the request starts.
        Fetch in a resolver and the router blocks the whole navigation on it, so
        the page freezes until the slowest resolver finishes. Route-level data
        sidesteps both. The factory fires at the resolve phase, so the request
        starts early, but it does not block: the request runs while the
        <a mmLink="/docs/router-core/transition-outlet">transition outlet</a>
        keeps the previous view on screen. The component reads a resource that
        is already loading by the time it mounts.
      </p>

      <docs-section title="The three pieces" id="defining">
        <p>
          You declare route data with three symbols that fit together. A typed
          <code>routeDataKey</code> names the slot and carries its type. Then
          <code>provideRouteData(key)</code> goes in the route's
          <code>providers</code>, setting up the per-route transition scope and
          a memoization slot. And
          <code>createRouteData(key, factory)</code> goes in the route's
          <code>resolve</code> map, which is what actually fires the factory.
          The component reads it back with <code>injectRouteData(key)</code>,
          getting the very same instance the route already started.
        </p>
        <docs-code [code]="define" lang="ts" />
        <p>
          The component side is a single line. No <code>ngOnInit</code>, no
          <code>ActivatedRoute.data</code> subscription, no local state to hold
          the result: it is the same resource ref the route created, so reading
          <code>user.value()</code> reads a fetch that has been running since
          before this component existed.
        </p>
        <docs-code [code]="consume" lang="ts" />
      </docs-section>

      <docs-section title="How it behaves" id="behavior">
        <ul>
          <li>
            <strong>Fires before the component.</strong> The factory runs at the
            resolve phase, so the request is in flight by the time the component
            mounts (hidden, under the transition outlet). Sibling and nested
            route data fire in the same activation pass, so a matched chain
            loads in parallel rather than in a waterfall.
          </li>
          <li>
            <strong>Reactive params, defined once.</strong>
            <code>ctx.params()</code> and <code>ctx.queryParams()</code> are
            live signals that update on param or query changes without leaning
            on the route's <code>runGuardsAndResolvers</code>. You write the
            factory once and a query-param change refetches on its own.
            <code>ctx.param('id')</code> is the single-param sugar: a memoized
            signal that throws a dev-mode error if the name is not on the
            matched route, so a typo is a loud failure instead of a silent
            <code>undefined</code>.
          </li>
          <li>
            <strong>Memoized.</strong> The factory runs once per route
            activation. A resolver that re-runs reuses the same instance. The
            data lives as long as the route and is destroyed with it.
          </li>
          <li>
            <strong>Coordinates with the outlet.</strong>
            <code>register: 'suspend'</code> makes the transition outlet hold
            the previous view until the data settles;
            <code>register: 'indicator'</code> drives a busy indicator without
            blocking the swap. Both give the route its own transition scope, so
            it is isolated from other routes' loading.
          </li>
          <li>
            <strong>No outlet required.</strong> Without a transition outlet the
            data still fires and is readable; you just do not get the held
            transition on top of it.
          </li>
          <li>
            <strong>Refresh from the component.</strong> The slot is the
            resource ref itself, so
            <code>injectRouteData(USER).reload()</code> is your pull-to-refresh.
            No extra API to learn.
          </li>
        </ul>
      </docs-section>

      <docs-section
        title="Recipe: kill the resolver dilemma"
        id="recipe-dilemma"
      >
        <p>
          A classic Angular resolver blocks the navigation: click the link, the
          URL does not change, the app appears to freeze, and only when the
          fetch resolves does the new page appear. To avoid the freeze people
          skip resolvers and fetch in the component, which brings back the
          waterfall and a page full of skeletons. Neither feels good.
        </p>
        <p>
          Route-level data plus the transition outlet gives you the third
          option. The pieces below are the same as the setup above, the point is
          the behavior they combine into. On the route,
          <code>register: 'suspend'</code> is what tells the outlet to wait for
          this data.
        </p>
        <docs-code [code]="dilemmaRoute" lang="ts" />
        <p>
          In the shell, the only change is the outlet selector. It reads that
          registered resource and holds the previous page until the fetch lands.
        </p>
        <docs-code [code]="dilemmaShell" lang="ts" />
        <p>
          Click the link and this is what the user sees: the URL updates
          immediately (navigation is not blocked), the previous page stays fully
          interactive on screen, and the fetch runs in the background. The
          moment the data lands, the new page swaps in complete, with data
          already present. No freeze, no skeleton, no flash of spinners. If you
          would rather show a skeleton on a particular route, set
          <code>data: {{ '{' }} immediateTransition: true {{ '}' }}</code> on it
          and it swaps in immediately with its own loading state instead.
        </p>
      </docs-section>

      <docs-section title="Handling errors" id="errors">
        <p>
          There are two levers, and they compose. Pass <code>onError</code> when
          you want route-level policy: redirect somewhere, toast and stay, log
          it. It fires once per transition into an error state (first load,
          reloads, param refetches) and never for a speculative prefetch error,
          so a failed hover-warm cannot trip your redirect.
        </p>
        <docs-code [code]="onError" lang="ts" />
        <p>
          Leave <code>onError</code> off and the default takes over: the outlet
          swaps on settle-by-error and the component renders the slot's
          <code>error()</code>, the familiar in-view error boundary. Use the
          boundary for recoverable, in-place errors; use <code>onError</code>
          when the error means the route itself is not a place the user should
          be.
        </p>
      </docs-section>

      <docs-section title="Prefetch on hover" id="prefetch">
        <p>
          Opt in with <code>withRouteData()</code> and the same
          <a mmLink="/docs/router-core/preloading"><code>mmLink</code></a>
          hover that warms a lazy chunk also warms the route's data. On hover or
          visibility the factory runs with params parsed straight from the link
          URL, filling your resource cache so the eventual click reads it warm
          and deduped. It is the classic prefetch-on-intent pattern wired to the
          links you already have.
        </p>
        <docs-code [code]="prefetch" lang="ts" />
        <ul>
          <li>
            <strong>Needs a cache to pay off.</strong> The warm writes to
            whatever shared cache your factory's resource uses, for example
            <code>&#64;mmstack/resource</code>'s
            <code>provideQueryCache()</code>. Without a shared cache, the hover
            fetch has nowhere to live and the navigation cannot reuse it.
          </li>
          <li>
            <strong>Two hovers for lazy routes.</strong> The data factory is not
            visible until its chunk loads, so the first hover warms the code and
            the second warms the data. Eager routes warm data on the first
            hover.
          </li>
          <li>
            On the prefetch path <code>ctx.isPrefetch</code> is
            <code>true</code> and params come from the hovered URL, so a factory
            can branch on it if a speculative fetch should behave differently.
          </li>
        </ul>
        <p>
          One edge to know: on a reused route (<code>/users/1</code> to
          <code>/users/2</code>) the resource refetches in place and there is no
          view swap for the outlet to hold. Wrap it with
          <a mmLink="/docs/router-core/transition-outlet"
            ><code>holdThroughNavigation</code></a
          >
          for a flash-free, rollback-safe transition on the param change.
        </p>
      </docs-section>

      <docs-section title="Prefetch any resolver" id="with-prefetch">
        <p>
          <code>createRouteData</code> is not the only thing the hover pipeline
          can warm. You often have work that a hover should start speculatively
          but that is not a route-data resource: warming an i18n namespace,
          priming a dataset, seeding a cache. <code>withPrefetch</code> is the
          escape hatch. It tags any Angular <code>ResolveFn</code> so the same
          <code>withRouteData()</code> pipeline runs a speculative
          <code>prefetch(ctx)</code> on hover, while navigation runs the wrapped
          resolver unchanged.
        </p>
        <docs-code [code]="withPrefetchEx" lang="ts" />
        <p>
          The prefetch runs in the same throwaway root-parented injector as a
          route-data factory, with <code>ctx.isPrefetch</code> true and params
          extracted from the hovered URL, so anything it writes lands in your
          shared cache for the eventual click to reuse. Runs are deduped per
          link URL plus <code>description</code>. Reach for it when the
          speculative work is idempotent and cache-shaped, the kind of thing a
          hover can safely start and a click can safely repeat. Resolvers made
          by <code>createRouteData</code> are already tagged, so do not wrap
          those.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class RouteDataDoc {
  protected readonly define = `import {
  routeDataKey,
  provideRouteData,
  createRouteData,
} from '@mmstack/router-core';
import { queryResource, type QueryResourceRef } from '@mmstack/resource';

const USER = routeDataKey<QueryResourceRef<User | undefined>>('user');

export const routes: Routes = [
  {
    path: 'users/:id',
    loadComponent: () => import('./user.page').then((m) => m.UserPage),
    providers: [provideRouteData(USER)],
    resolve: {
      user: createRouteData(USER, (ctx) =>
        queryResource(() => \`/api/users/\${ctx.param('id')()}\`, {
          defaultValue: undefined,
          register: 'suspend', // the outlet holds until this settles
          cache: { staleTime: 30_000 }, // enables prefetch-on-hover
        }),
      ),
    },
  },
];`;

  protected readonly consume = `import { injectRouteData } from '@mmstack/router-core';

@Component({ selector: 'user-page', template: \`{{ user.value()?.name }}\` })
export class UserPage {
  // the same instance the route already started, already in flight
  readonly user = injectRouteData(USER);
}`;

  protected readonly dilemmaRoute = `// register: 'suspend' is the whole trick: the outlet waits for this
resolve: {
  user: createRouteData(USER, (ctx) =>
    queryResource(() => \`/api/users/\${ctx.param('id')()}\`, {
      defaultValue: undefined,
      register: 'suspend',
    }),
  ),
}`;

  protected readonly dilemmaShell = `@Component({
  selector: 'app-shell',
  imports: [TransitionRouterOutlet],
  template: \`<mm-transition-outlet />\`, // holds the old page until data lands
})
export class AppShell {}`;

  protected readonly onError = `createRouteData(USER, factory, {
  // redirect, toast-and-stay, log. Fires per transition into error
  // (first load, reloads, param re-fetches); never for prefetch errors.
  onError: (err, ctx) => ctx.injector.get(Router).navigateByUrl('/not-found'),
});`;

  protected readonly prefetch = `import { provideRouter, withPreloading } from '@angular/router';
import { PreloadStrategy, withRouteData } from '@mmstack/router-core';

bootstrapApplication(App, {
  providers: [
    provideRouter(routes, withPreloading(PreloadStrategy)),
    withRouteData(), // hovering an mmLink now warms route data, not just code
  ],
});`;

  protected readonly withPrefetchEx = `import { withPrefetch } from '@mmstack/router-core';

// canonical use: warm a translate namespace on hover
resolve: {
  i18n: withPrefetch(quoteNs.resolveNamespaceTranslation, {
    description: 'quote-i18n',
    // runs speculatively on hover; params come from the link URL
    prefetch: (ctx) => quoteNs.warmNamespaceTranslation(ctx.params()['locale']),
  }),
}`;
}
