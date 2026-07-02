# @mmstack/router-core

Signal-based primitives for `@angular/router` — reactive router state, resolver-driven UI (titles, breadcrumbs, headless nav menus), and on-demand module preloading.

Part of the `@mmstack` ecosystem, designed to complement [@mmstack/primitives](https://www.npmjs.com/package/@mmstack/primitives).

[![npm version](https://badge.fury.io/js/%40mmstack%2Frouter-core.svg)](https://badge.fury.io/js/%40mmstack%2Frouter-core)

## Installation

```bash
npm install @mmstack/router-core
```

## Features

- **Reactive router state** — read the current URL, path params, and query params as Angular Signals.
- **Resolver-driven UI** — declare your document title, breadcrumbs, and one or more nav menus from your `Routes` config; consume them reactively from any component.
- **Smart preloading** — a `RouterLink` replacement and `PreloadingStrategy` that preload lazy-loaded route modules on hover, visibility, or imperatively.
- **Transition navigation** — a drop-in `RouterOutlet` that keeps the current route on screen until the incoming route's data settles, then swaps in one frame.
- **Route-level data** — declare a route's data once; it fires at the resolve phase (before the component, in parallel across the matched chain), stays reactive to param/query changes, coordinates with the transition outlet, and can be warmed on `mmLink` hover.
- **Navigation hold** — stabilize a persisted/reused resource across navigation so it never flashes to loading mid-transition, and rolls back cleanly on a cancelled navigation.

## Table of contents

- [Reactive router state](#reactive-router-state)
  - [`url`](#url)
  - [`navigationEndTick`](#navigationendtick)
  - [`queryParam`](#queryparam)
- [Resolver-driven UI](#resolver-driven-ui)
  - [Title — `createTitle`](#title)
  - [Breadcrumbs — `createBreadcrumb` / `injectBreadcrumbs`](#breadcrumbs)
  - [Nav menus — `createNavItems` / `injectNavItems`](#nav-menus)
- [Preloading](#preloading)
  - [`PreloadStrategy`](#preloadstrategy)
  - [`Link` (`mmLink`)](#link-mmlink)
  - [`injectTriggerPreload`](#injecttriggerpreload)
- [Transition outlet](#transition-outlet)
  - [`TransitionRouterOutlet` (`mm-transition-outlet`)](#transitionrouteroutlet-mm-transition-outlet)
- [Route-level data](#route-level-data)
  - [`provideRouteData` / `createRouteData` / `injectRouteData`](#defining-route-data)
  - [Prefetch on hover — `withRouteData`](#prefetch-on-hover)
- [Navigation hold](#navigation-hold)
  - [`holdThroughNavigation`](#holdthroughnavigation)

---

## Reactive router state

Helpers that expose router state as Angular Signals — read them anywhere you'd read a signal (templates, computeds, effects).

### `url`

A read-only Signal tracking the current router URL.

- Updates after every successful navigation.
- Reflects the URL after redirects (`urlAfterRedirects`).
- Initializes synchronously with the router's current URL.

```typescript
import { Component } from '@angular/core';
import { url } from '@mmstack/router-core';

@Component({
  selector: 'app-header',
  template: `<nav>Current path: {{ currentUrl() }}</nav>`,
})
export class HeaderComponent {
  protected readonly currentUrl = url();
}
```

### `navigationEndTick`

A monotonically increasing counter signal that ticks on every **successful navigation** — including navigations whose resulting URL string equals the previous one (initial landing on `/`, `onSameUrlNavigation: 'reload'`, redirects back to the same URL). Use it instead of the URL string to key recomputation of anything derived from router state snapshots.

```typescript
const tick = navigationEndTick(inject(Router));
const leaf = computed(() => {
  tick(); // recompute per navigation, even same-URL reloads
  let r = router.routerState.snapshot.root;
  while (r.firstChild) r = r.firstChild;
  return r;
});
```

### `queryParam`

A `WritableSignal` that two-way binds with a URL query parameter.

- Reading returns the current value (or `null` if absent).
- Setting updates the URL; setting `null` removes the parameter.
- Reacts to external navigation changes.
- Uses `queryParamsHandling: 'merge'`, so unrelated params survive updates.
- Each `set()` navigates immediately. Opt into `batch: true` to coalesce several same-tick writes into one navigation (otherwise each write rebuilds from the pre-navigation URL and only the last survives).

```typescript
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { queryParam } from '@mmstack/router-core';

@Component({
  selector: 'app-search-page',
  imports: [FormsModule],
  template: `
    <input [(ngModel)]="searchTerm" placeholder="Enter search term..." />
    <button (click)="searchTerm.set(null)" [disabled]="!searchTerm()">
      Clear
    </button>
    <p>Current search: {{ searchTerm() ?? 'None' }}</p>
  `,
})
export class SearchPageComponent {
  protected readonly searchTerm = queryParam('q');
}
```

#### Typed & tuned params

The second argument accepts options for typed params and write behavior:

- **`parse` / `serialize`** — convert between the URL string and a typed value. Provide both and the signal becomes `WritableSignal<T | null>` (`parse` runs on present params; an absent param reads as `null` directly; `serialize` returning `null` removes the param).
- **`replaceUrl`** — write without creating a history entry (right call for type-ahead search boxes). Under `batch`, a history entry is kept unless _every_ batched writer opted out.
- **`debounce`** — milliseconds to debounce writes (reads stay instant).
- **`batch`** — coalesce same-tick writes into a single navigation (default `false`; see above). Useful when resetting several params together.
- **`route`** — bind to a specific `ActivatedRoute` instead of the injected one.

```typescript
// number-typed page param
readonly page = queryParam<number>('page', {
  parse: (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  },
  serialize: (n) => (n <= 1 ? null : String(n)), // page 1 keeps the URL clean
});

// debounced type-ahead search, no history spam while typing
readonly q = queryParam('q', { replaceUrl: true, debounce: 300 });
```

---

## Resolver-driven UI

Three helpers (`createTitle`, `createBreadcrumb`, `createNavItems`) hook into Angular's route `resolve` map (or `title` map for titles) to populate the document title, a breadcrumb trail, and one or more nav menus from your `Routes` config. They share the same pattern: declare on the route, consume reactively from a component.

### Title

`createTitle` is a route resolver that sets the document title. Use it directly in the route's `title` property — it accepts static strings or signal-driven dynamic titles.

```typescript
import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { createTitle } from '@mmstack/router-core';
import { ProductStore } from './product.store';

export const appRoutes: Routes = [
  {
    path: 'about',
    title: createTitle('About Us'),
    loadComponent: () =>
      import('./about.component').then((m) => m.AboutComponent),
  },
  {
    path: 'users/:id',
    // factories receive the route's ActivatedRouteSnapshot
    title: createTitle((route) => `User ${route.params['id']}`),
    loadComponent: () =>
      import('./user.component').then((m) => m.UserComponent),
  },
  {
    path: 'products/:id',
    // Signal-driven title — the inner function becomes a computed under the hood.
    title: createTitle(() => {
      const products = inject(ProductStore);
      return () => `Product: ${products.product().name ?? 'Loading...'}`;
    }),
    loadComponent: () =>
      import('./product-detail.component').then((m) => m.ProductComponent),
  },
];
```

Title (and breadcrumb/nav) registrations made during a navigation are **staged** — they apply when the navigation commits (`NavigationEnd`) and are dropped if it's cancelled or errors, so a guard-rejected navigation can never flip the document title.

#### Configuration (optional)

`provideTitleConfig` customizes title formatting and fallbacks:

- **`prefix`** — `string | (title: string) => string`. Static prefix, or a full formatter for complete control over the result.
- **`keepLastKnownTitle`** (default `true`) — when navigating to a route that doesn't provide a title, hold the last route-driven title instead of clearing it.
- **`initialTitle`** — explicit fallback when no route title is active. If omitted, `TitleStore` captures `Title.getTitle()` once at construction (typically the `<title>` from `index.html`). Set this explicitly if you set the document title imperatively before the router has bootstrapped.

```typescript
import { provideRouter } from '@angular/router';
import { provideTitleConfig } from '@mmstack/router-core';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(appRoutes),
    provideTitleConfig({
      prefix: (title) => (title ? `${title} — MyApp` : 'MyApp'),
      initialTitle: 'MyApp',
    }),
  ],
};
```

### Breadcrumbs

A signal-based, headless breadcrumb toolkit. Breadcrumbs are auto-generated from route segments by default, with per-route overrides via `createBreadcrumb`. Consume the reactive list with `injectBreadcrumbs`.

```typescript
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { injectBreadcrumbs } from '@mmstack/router-core';

@Component({
  selector: 'app-breadcrumbs',
  imports: [RouterLink],
  template: `
    <nav aria-label="breadcrumb">
      <ol>
        @for (crumb of breadcrumbs(); track crumb.id) {
          <li>
            <a
              [routerLink]="crumb.link()"
              [attr.aria-label]="crumb.ariaLabel()"
            >
              {{ crumb.label() }}
            </a>
          </li>
        }
      </ol>
    </nav>
  `,
})
export class BreadcrumbsComponent {
  protected readonly breadcrumbs = injectBreadcrumbs();
}
```

> **Heads up:** `crumb.link()` is a serialized URL string. Bind it to `[routerLink]` (or `[mmLink]` if you want preloading) — `[href]` would trigger a full page reload.

#### Overriding a breadcrumb

When auto-generation isn't enough, register a custom breadcrumb in the route's `resolve` map. The factory runs in an injection context, so you can pull labels from stores, i18n services, etc.

```typescript
import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { createBreadcrumb } from '@mmstack/router-core';
import { UserStore } from './user.store';

export const appRoutes: Routes = [
  {
    path: 'home',
    component: HomeComponent,
    resolve: {
      // Shorthand for { label: 'Home' } — also accepts an options object or a factory returning either.
      breadcrumb: createBreadcrumb('Home'),
    },
  },
  {
    path: 'admin',
    component: AdminComponent,
    data: { skipBreadcrumb: true }, // opt out of auto-generation for this route
  },
  {
    path: 'users/:userId',
    component: UserProfileComponent,
    resolve: {
      // the factory receives the route's ActivatedRouteSnapshot
      breadcrumb: createBreadcrumb((route) => {
        const userStore = inject(UserStore);
        return {
          label: () =>
            userStore.user(route.params['userId'])()?.name ?? 'Loading...',
        };
      }),
    },
  },
];
```

#### Configuration (optional)

`provideBreadcrumbConfig` controls auto-generation behavior:

- **`generation: 'manual'`** — disable auto-generation entirely; only routes with `createBreadcrumb` produce breadcrumbs.
- **`generation: () => (leaf: ResolvedLeafRoute) => string`** — supply a custom label generator. The outer function runs in a root injection context, so you can inject stores or i18n services there.

```typescript
import {
  provideBreadcrumbConfig,
  type BreadcrumbConfig,
  type ResolvedLeafRoute,
} from '@mmstack/router-core';

const customStrategy: BreadcrumbConfig['generation'] = () => {
  return (leaf: ResolvedLeafRoute): string =>
    leaf.route.data?.['navTitle'] ?? leaf.route.title ?? 'Default';
};

export const appConfig: ApplicationConfig = {
  providers: [provideBreadcrumbConfig({ generation: customStrategy })],
};
```

### Nav menus

A headless, scope-aware navigation menu primitive. Routes declare nav items via `createNavItems`; components consume them via `injectNavItems()` as `Signal<NavItem[]>`. When multiple routes in the active chain register items for the same scope, the deepest active registration wins — navigating away restores the shallower one.

```typescript
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { injectNavItems } from '@mmstack/router-core';

@Component({
  selector: 'app-top-bar',
  imports: [RouterLink],
  template: `
    <nav>
      @for (item of items(); track item.id()) {
        <a
          [routerLink]="item.link()"
          [class.active]="item.active()"
          [attr.aria-disabled]="item.disabled()"
        >
          {{ item.label() }}
        </a>
      }
    </nav>
  `,
})
export class TopBar {
  protected readonly items = injectNavItems();
}
```

> **Heads up:** `item.link()` is a serialized URL string. Bind it to `[routerLink]` (or `[mmLink]` for preloading) — `[href]` would cause a full page reload.

#### Registering items

Items are declared in a route's `resolve` map. Links resolve **relative to the route the resolver is attached to**, matching Angular's `routerLink` convention — a leading slash makes a link absolute.

```typescript
import { Routes } from '@angular/router';
import { createNavItems } from '@mmstack/router-core';

export const appRoutes: Routes = [
  {
    path: '',
    resolve: {
      // Root menu — visible on every page unless a deeper route overrides.
      // Absolute paths work fine for top-level app menus:
      nav: createNavItems([
        { label: 'Home', link: '/' },
        { label: 'Products', link: '/products' },
        { label: 'About', link: '/about' },
      ]),
    },
    children: [
      {
        path: 'products',
        loadComponent: () =>
          import('./products.component').then((m) => m.ProductsComponent),
        resolve: {
          // Inside /products, the menu changes — root menu is shadowed until we navigate away.
          // Relative links work too — these resolve against /products:
          nav: createNavItems([
            { label: 'All', link: '/products' },
            { label: 'Featured', link: 'featured' }, // → /products/featured
            { label: 'Categories', link: 'categories' }, // → /products/categories
          ]),
        },
      },
    ],
  },
];
```

`NavItem.active` is computed against the current URL with `subsetMatchOptions` defaults (prefix-match paths, subset query params, ignore matrix/fragment). Override per-item with `activeMatch: Partial<IsActiveMatchOptions>` or globally with `provideNavConfig({ activeMatch })`.

#### Link resolution rules

| Input                | Resolved to (when the resolver route is mounted at `/myLib`) |
| -------------------- | ------------------------------------------------------------ |
| `'a'` or `'a/b'`     | `/myLib/a`, `/myLib/a/b`                                     |
| `['a', 'b']`         | `/myLib/a/b`                                                 |
| `'/elsewhere'`       | `/elsewhere` (absolute escape)                               |
| `['/fooBar', 'baz']` | `/fooBar/baz` (absolute escape)                              |
| `UrlTree`            | passed through unchanged                                     |

Relative-by-default makes nav items portable across mount points — particularly useful for **nx feature libraries** that export `Routes` without knowing where the consuming app will mount them:

```typescript
// libs/my-feature/src/lib/routes.ts
export const myFeatureRoutes: Routes = [
  {
    path: '',
    component: MyFeatureShellComponent,
    resolve: {
      nav: createNavItems([
        { label: 'Overview', link: 'overview' }, // → ${mount}/overview
        { label: 'Settings', link: 'settings' }, // → ${mount}/settings
      ]),
    },
    children: [
      { path: 'overview', component: OverviewComponent },
      { path: 'settings', component: SettingsComponent },
    ],
  },
];

// apps/host/src/app/app.routes.ts — the consumer picks the mount path.
export const appRoutes: Routes = [
  {
    path: 'my-feature',
    loadChildren: () =>
      import('@org/my-feature').then((m) => m.myFeatureRoutes),
  },
  // Same lib, same nav items, different mount — links resolve correctly:
  {
    path: 'admin/tools',
    loadChildren: () =>
      import('@org/my-feature').then((m) => m.myFeatureRoutes),
  },
];
```

#### Named scopes

Pass `{ name }` when a route declares more than one menu (e.g. top bar + side bar). The `resolve` key is just a unique handle Angular requires; the store keys on `name`.

```typescript
resolve: {
  mainNav: createNavItems([...primary], { name: 'main' }),
  sideNav: createNavItems([...secondary], { name: 'side' }),
}

// consumers
@Component({ ... }) class TopBar  { items = injectNavItems('main'); }
@Component({ ... }) class SideBar { items = injectNavItems('side'); }
```

#### Children, hidden, disabled

Items can declare `children` for nested menus. By default a parent is active when its own link matches OR any descendant is active — useful for grouping headers with no own link. Setting `activeMatch` explicitly disables the OR; pass `matchesWhenChildActive: true` to re-enable it.

`hidden` filters the item (and its subtree) out of the consumer-facing array. `disabled` is preserved on the item and cascades to descendants — useful for permission-gated subtrees:

```typescript
createNavItems(() => [
  {
    label: 'Admin',
    link: 'admin',
    hidden: () => !permissions.isAdmin(), // signal-driven
    children: [
      { label: 'Users', link: 'admin/users' },
      { label: 'Settings', link: 'admin/settings' },
    ],
  },
]);
```

#### Default (fallback) items

Routes register items on-demand, so any URL with no registration in its active chain renders an empty menu. `provideNavConfig({ defaults })` declares fallback items rendered on those URLs — handy for landing pages, error routes, or app shells where a few items should always be visible:

```typescript
provideNavConfig({
  defaults: [
    { label: 'Home', link: '/' },
    { label: 'Docs', link: '/docs' },
  ],
}),
```

Relative `link`s on defaults resolve from `/` (the router root), so `link: 'home'` becomes `/home`. Absolute links and `UrlTree`s pass through unchanged.

Named scopes are supported via the record form:

```typescript
provideNavConfig({
  defaults: {
    '': [{ label: 'Home', link: '/' }],          // default scope
    main: [{ label: 'Home', link: '/' }],         // injectNavItems('main')
    side: () => [{ label: 'Settings', link: '/settings' }], // factory
  },
}),
```

Shadowing follows the usual deepest-wins rule — any active route that calls `createNavItems` (including `createNavItems([])` to render an explicitly empty menu) replaces the defaults for that scope.

#### Typed metadata

`CreateNavItem` and `NavItem` carry a `TMeta` generic so consumers can attach app-specific fields (icons, badges, etc.) without the library imposing a shape:

```typescript
type NavMeta = { icon: string };

createNavItems<NavMeta>([{ label: 'Home', link: '/', meta: { icon: 'home' } }]);

// in the component
items = injectNavItems<NavMeta>();
// items()[0].meta().icon → 'home'
```

---

## Preloading

Two complementary primitives speed up lazy-loaded routes: a `PreloadingStrategy` that listens for preload requests, and a `RouterLink` replacement that issues them on hover or visibility. An imperative escape hatch (`injectTriggerPreload`) covers the cases where the directive isn't a fit.

### `PreloadStrategy`

A custom `PreloadingStrategy` that defers preloading until something asks for a specific route. It pairs with the `Link` (`mmLink`) directive or `injectTriggerPreload` — neither preloads anything on its own.

- Listens for preload requests triggered by `Link` / `injectTriggerPreload`.
- Path-matches the requested URL against the route config (supports route params, matrix params, and wildcards).
- Skips preloading on slow connections (`effectiveType: '2g'`) or when the browser reports `saveData` — evaluated at request time, so conditions improving later aren't locked out.
- Respects `data: { preload: false }` on a route config to opt that route out.
- `data: { preloadDelay: 150 }` debounces hover-intent — the load starts that many ms after the first request, so accidental pointer flybys don't fetch chunks.
- Deduplicates: each path is preloaded at most once (failed loads may retry on the next request).

Provide it alongside `provideRouter`:

```typescript
import { PreloadStrategy } from '@mmstack/router-core';
import { provideRouter, withPreloading } from '@angular/router';

export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes, withPreloading(PreloadStrategy))],
};
```

### `Link` (`mmLink`)

The `Link` directive (used as `mmLink`) wraps Angular's `RouterLink` and adds preloading. All standard `routerLink` inputs (`queryParams`, `fragment`, `state`, `relativeTo`, etc.) are proxied through unchanged.

- **`preloadOn`** — `input<'hover' | 'visible' | null>()` (default: `'hover'`). `null` disables preloading.
- **`preloading`** — `output<void>()` fires when the route is queued for preload (before the JS actually loads).
- **`useMouseDown`** — navigate on mousedown instead of click (shaves ~50–100ms off perceived latency). The press's own click event is swallowed, so the navigation runs exactly once; keyboard activation still works.
- **`beforeNavigate`** — `input<() => void>()` hook invoked just before an SPA navigation triggered by this link. Modified/middle clicks and `target="_blank"` links are left to the browser and skip the hook.

App-wide defaults for `preloadOn` / `useMouseDown` can be set once via `provideMMLinkDefaultConfig({ ... })`.

Replace existing `routerLink`s with `mmLink` to opt them in:

```typescript
import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';

@Component({
  selector: 'app-navigation',
  imports: [Link],
  template: `
    <nav>
      <!-- preload on hover (default) -->
      <a [mmLink]="['/features']">Features</a>
      <!-- preload when scrolled into view -->
      <a [mmLink]="['/pricing']" preloadOn="visible">Pricing</a>
      <!-- no preload -->
      <a [mmLink]="['/contact']" [preloadOn]="null">Contact</a>
    </nav>
  `,
})
export class NavigationComponent {}
```

### `injectTriggerPreload`

When the directive isn't a fit — preloading from a signal effect, on a keyboard shortcut, when a command palette opens — `injectTriggerPreload()` returns a function that runs the same preload pipeline imperatively. Same `PreloadStrategy` requirement.

```typescript
import { Component, effect, signal } from '@angular/core';
import { injectTriggerPreload } from '@mmstack/router-core';

@Component({
  /* ... */
})
export class CommandPaletteComponent {
  private readonly triggerPreload = injectTriggerPreload();
  protected readonly highlighted = signal<string | null>(null);

  constructor() {
    effect(() => {
      const target = this.highlighted();
      if (target) this.triggerPreload(target);
    });
  }
}
```

---

## Transition outlet

By default a route change unmounts the current view immediately and the incoming view renders in its loading state — a flash of spinners on every navigation. `TransitionRouterOutlet` turns navigation into a **transition**: the current route stays mounted and visible while the incoming route mounts _hidden_ and its data settles, then both swap in one frame. It's the routing application of `@mmstack/primitives`' [`holdUntilReady`](https://www.npmjs.com/package/@mmstack/primitives#concurrency--transitions) / transition-scope machinery — the Angular take on a Suspense-driven route transition.

### `TransitionRouterOutlet` (`mm-transition-outlet`)

A drop-in replacement for `<router-outlet>`. It provides its own transition scope, so the incoming route's resources register **into it** (use `@mmstack/resource`'s `register` option, or `registerResource()` for a hand-rolled `ResourceRef`) and the outlet can tell when the route is ready.

```typescript
import { Component } from '@angular/core';
import { TransitionRouterOutlet } from '@mmstack/router-core';

@Component({
  selector: 'app-shell',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
export class AppShell {}
```

```typescript
// the incoming route registers its data so the outlet knows when to swap
@Component({ selector: 'user-page', template: `…{{ user.value()?.name }}` })
export class UserPage {
  readonly user = queryResource<User>(() => `/api/users/${this.id()}`, {
    register: 'indicator',
  });
}
```

Behaviour:

- **First navigation** mounts immediately (nothing to hold). After that, the outgoing route holds until the incoming one settles, then swaps and is destroyed — navigation still respects "tree = f(URL)".
- **Settle = the incoming route's registered resources went in flight and then drained.** A route that registers nothing (or errors) swaps via a microtask fallback, so a data-less or failing route never hangs the hold.
- **Composes with guards and resolvers** — a denied `canActivate` leaves the current route untouched (nothing held or leaked); a pending `resolve` holds at the router level, then the outlet holds through the data load. Works when nested inside a parent route's outlet too.
- **Interruptions re-target the hold** — navigating again before the incoming route settles destroys the half-loaded view; the stable view stays visible until the new destination settles.
- **Per-view isolation** — the swap waits on the _incoming_ view's resources only, so long-running background work (e.g. a `keepPrevious` poll) on the outgoing view can't delay it. Routes that opt into [route-level data](#route-level-data) get their own scope automatically (full isolation); others share the outlet's scope, with the swap attributed to the incoming view.
- **`data: { immediateTransition: true }`** on a route opts it out of the hold — it swaps in immediately, even while loading (handy for routes that should show their own skeleton).

#### View Transitions

The swap can be wrapped in the browser's [View Transitions API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) — the old view cross-fades (or whatever your `::view-transition-*` CSS says) into the new one. Feature-detected: browsers without `document.startViewTransition` fall back to the instant swap.

**Standalone** — just set the attribute:

```html
<mm-transition-outlet viewTransition />
```

**Alongside Angular's router view transitions** — wrap Angular's option with `mmRouterViewTransitions()` and it just works, no attribute needed:

```ts
import { provideRouter, withViewTransitions } from '@angular/router';
import { mmRouterViewTransitions } from '@mmstack/router-core';

provideRouter(routes, withViewTransitions(mmRouterViewTransitions()));
```

```html
<mm-transition-outlet />
```

Why the wrapper is needed: Angular fires its transition at route **activation**, but under this outlet activation is visually inert — the incoming view mounts _hidden_ and the real visual change happens later, at the **swap** (once the route's data settles). So for routes the outlet holds, Angular's activation-time transition would be an invisible no-op that just freezes the page for its duration. `mmRouterViewTransitions()` coordinates the two:

- **Non-held routes** (first navigation, `data.immediateTransition`, routes that load nothing) — Angular transitions them normally; the swap is synchronous with activation.
- **Held routes** — Angular's inert transition is skipped, and the outlet fires the real one at the swap. The same `::view-transition-*` CSS applies to both.

Your own `onViewTransitionCreated` / `skipInitialTransition` options are preserved (pass them to `mmRouterViewTransitions({ ... })`). To opt a specific outlet out even when router view transitions are enabled app-wide, set `[viewTransition]="false"`.

---

## Route-level data

Define a route's data **once, on the route**, and have it fire at the resolve phase — before the component constructs, in the route's injector, with the matched params in hand — instead of waiting for the component to mount and kick off a fetch. It's non-blocking (the request runs while the [transition outlet](#transition-outlet) holds the previous view), stays reactive to param/query changes, and the component just reads it.

It's built entirely on the transition-scope primitive, so `@mmstack/router-core` has **no dependency on a resource library**. Your factory is the only place a resource is named — use [`@mmstack/resource`](https://www.npmjs.com/package/@mmstack/resource)'s `queryResource` (or Angular's `httpResource` + `registerResource()`); anything that produces a `ResourceRef` works.

### Defining route data

Three pieces: a typed `routeDataKey`, `provideRouteData(key)` in the route's `providers` (provides the per-route transition scope + a memoization slot), and `createRouteData(key, factory)` in its `resolve` map (fires the factory). The component reads it with `injectRouteData(key)`.

```typescript
import {
  routeDataKey,
  provideRouteData,
  createRouteData,
  injectRouteData,
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
        queryResource(() => `/api/users/${ctx.params()['id']}`, {
          defaultValue: undefined,
          register: 'suspend', // the outlet holds the previous view until this settles
          cache: { staleTime: 30_000 }, // optional — enables prefetch-on-hover (below)
        }),
      ),
    },
  },
];
```

```typescript
@Component({ selector: 'user-page', template: `{{ user.value()?.name }}` })
export class UserPage {
  // the resource the route already started — reads the same instance, already in flight
  readonly user = injectRouteData(USER);
}
```

Behaviour:

- **Fires before the component** — the factory runs at the resolve phase, so the request is already in flight when the component mounts (which it does _hidden_, under the transition outlet). Sibling/nested route data fires in the same activation pass, so a matched chain loads in parallel.
- **Reactive params, define-once** — `ctx.params()` / `ctx.queryParams()` are live signals derived from router state on every navigation. They update on param/query changes **without** relying on the route's `runGuardsAndResolvers` — so you define the factory once and it keeps producing correct data (a query-param change refetches even though the resolver itself doesn't re-run).
- **Memoized** — the factory runs once per route activation; a re-running resolver reuses the same instance. The data lives as long as the route, and is destroyed with it.
- **Coordinates with the outlet** — `register: 'suspend'` makes the [`TransitionRouterOutlet`](#transition-outlet) hold the previous view until the data settles; `register: 'indicator'` drives the busy indicator without blocking the swap. Opting in also gives the route its own transition scope (per-view isolation).
- **No outlet required** — without a transition outlet the data still fires and is readable; you just don't get the held-transition behavior.

### Prefetch on hover

Opt in with `withRouteData()` and the same `mmLink` preload signal that loads a lazy chunk also **warms the route's data**: on hover/visibility, the factory runs with params parsed from the link URL, populating your resource cache so the eventual navigation reads it warm (deduped). It's the `preload="intent"` → `ensureQueryData` pattern, wired to your existing links.

```typescript
import { provideRouter, withPreloading } from '@angular/router';
import { PreloadStrategy, withRouteData } from '@mmstack/router-core';

bootstrapApplication(App, {
  providers: [
    provideRouter(routes, withPreloading(PreloadStrategy)),
    withRouteData(), // hovering an mmLink now warms route data, not just code
  ],
});
```

Notes:

- **Needs a cache to be useful.** Prefetch warms whatever shared cache your factory's resource writes to (e.g. `@mmstack/resource`'s `provideQueryCache()` at the app root). Without one, the hover fetch isn't reused by the navigation.
- **Two-phase for lazily code-split routes.** The route's data factory isn't visible until its chunk has loaded, so the **first** hover warms the code and a **subsequent** hover warms the data; eager (non-lazy) routes warm data on the first hover.
- On the prefetch path `ctx.isPrefetch` is `true` and params come from the hovered URL (there's no `ActivatedRoute` yet) — a factory can branch on it if needed.
- **Hovers are deduped per link — but failures re-arm.** A warm that resolves stays deduped; one that errors, times out (`timeout`, default 30s), or throws is forgotten so the next hover retries. A factory may also return an object of resources (`{ user, posts }`) — every member is watched and the warm scope stays alive until all of them settle.

> **Flash-free param navigation.** A route-data resource on a _reused_ route (e.g. `/users/1 → /users/2`) refetches in place — the outlet can't hold it (same component, no view swap). Wrap it with [`holdThroughNavigation`](#navigation-hold) for a flash-free, rollback-safe transition.

---

## Navigation hold

The [transition outlet](#transition-outlet) holds the previous _view_ when navigating between **different** routes. But a resource that **persists** across a navigation — an app-shell/layout resource, or a route reused on a param change — has no view swap to hold; it just refetches in place and flashes to loading. `holdThroughNavigation` is the signal-level answer to that.

### `holdThroughNavigation`

Wraps any resource (`@mmstack/resource`'s `queryResource`, Angular's `httpResource` or `resource()`) and returns a stabilized `Resource` whose state can't flash through mid-navigation:

```typescript
import { holdThroughNavigation } from '@mmstack/router-core';

@Component({ selector: 'user-page', template: `{{ user.value()?.name }}` })
export class UserPage {
  private readonly id = injectParam('id'); // your param signal
  // a reused route on param change refetches in place — stabilize it
  readonly user = holdThroughNavigation(
    queryResource<User>(() => `/api/users/${this.id()}`),
  );
}
```

Behaviour:

- **During a navigation** the whole snapshot (value / status / error / loading) is frozen at the pre-navigation state — a refetch the navigation triggers shows no torn or loading state.
- **On success or skip** (`NavigationEnd` / `NavigationSkipped`) it reveals — **settle-aware**: a navigation's refetch typically starts just _after_ `NavigationEnd` (live params tick on it), so the last settled snapshot is held through that first load cycle and revealed when it lands. Once the cycle completes, loads pass through live again (a later `reload()`'s indicator shows normally) until the next navigation.
- **On a true rollback** (`NavigationError`, or a `NavigationCancel` that isn't a redirect / superseded-by-a-new-navigation) it holds the pre-navigation snapshot until the resource stops loading — so a cancelled refetch settling back to the route you stayed on reveals cleanly, never the would-be state of the route you didn't reach.
- **Redirect / superseded cancels** stay frozen — a new navigation is already taking over and drives the next state, with no flicker in between.

The return value is a read-only `Resource` (`value()`, `status()`, `error()`, `isLoading()`, `hasValue()`) plus `reload()`, so it's a drop-in for templates and anywhere a `Resource` is read. It composes with route-level data — `holdThroughNavigation(injectRouteData(USER))` gives a route's data flash-free param navigation.

Three tools, three layers — reach for the one that matches:

| Tool | Holds | Trigger |
| --- | --- | --- |
| [`TransitionRouterOutlet`](#transition-outlet) | the outgoing **view** | cross-route navigation |
| `holdThroughNavigation` | a persisted **resource**'s state | navigation lifecycle (with rollback) |
| [`<mm-suspense>` / transition scope](https://www.npmjs.com/package/@mmstack/primitives#concurrency--transitions) `commit` | a value while **registered resources** load | scope `pending` |
