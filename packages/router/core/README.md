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

## Table of contents

- [Reactive router state](#reactive-router-state)
  - [`url`](#url)
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

### `queryParam`

A `WritableSignal` that two-way binds with a URL query parameter.

- Reading returns the current value (or `null` if absent).
- Setting to a string updates the URL.
- Setting to `null` removes the parameter.
- Reacts to external navigation changes.
- Uses `queryParamsHandling: 'merge'`, so unrelated params survive updates.

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
      breadcrumb: createBreadcrumb(() => {
        const userStore = inject(UserStore);
        return {
          label: () => userStore.currentUser().name ?? 'Loading...',
          ariaLabel: () =>
            `View profile for ${userStore.currentUser().name ?? 'user'}`,
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
- Skips preloading on slow connections (`effectiveType: '2g'`) or when the browser reports `saveData`.
- Respects `data: { preload: false }` on a route config to opt that route out.
- Deduplicates: each path is preloaded at most once.

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
    register: true,
  });
}
```

Behaviour:

- **First navigation** mounts immediately (nothing to hold). After that, the outgoing route holds until the incoming one settles, then swaps and is destroyed — navigation still respects "tree = f(URL)".
- **Settle = the incoming route's registered resources went in flight and then drained.** A route that registers nothing (or errors) swaps via a microtask fallback, so a data-less or failing route never hangs the hold.
- **Composes with guards and resolvers** — a denied `canActivate` leaves the current route untouched (nothing held or leaked); a pending `resolve` holds at the router level, then the outlet holds through the data load. Works when nested inside a parent route's outlet too.
- **`data: { immediateTransition: true }`** on a route opts it out of the hold — it swaps in immediately, even while loading (handy for routes that should show their own skeleton).
