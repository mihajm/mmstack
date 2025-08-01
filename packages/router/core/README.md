# @mmstack/router-core

Core utilities and Signal-based primitives for enhancing development with `@angular/router`. This library provides helpers for common routing tasks, reactive integration with router state, and intelligent module preloading.

Part of the `@mmstack` ecosystem, designed to complement [@mmstack/primitives](https://www.npmjs.com/package/@mmstack/primitives).

[![npm version](https://badge.fury.io/js/%40mmstack%2Frouter-core.svg)](https://badge.fury.io/js/%40mmstack%2Frouter-core)

## Installation

```bash
npm install @mmstack/router-core
```

## Signal Utilities

This library includes helpers to interact with router state reactively using Angular Signals.

---

### queryParam

Creates a WritableSignal that synchronizes with a specific URL query parameter, enabling two-way binding between the signal's state and the URL.

- Reading the signal returns the parameter's current value (string) or null if absent.
- Setting the signal to a string updates the URL parameter.
- Setting the signal to null removes the parameter from the URL.
- Reacts to external navigation changes affecting the parameter.
- Supports static or dynamic (function/signal) keys.

```typescript
@Component({
  selector: 'app-search-page',
  standalone: true,
  imports: [FormsModule],
  template: `
    <label>
      Search:
      <input [(ngModel)]="searchTerm" placeholder="Enter search term..." />
    </label>
    <button (click)="searchTerm.set(null)" [disabled]="!searchTerm()">Clear</button>
    <p>Current search: {{ searchTerm() ?? 'None' }}</p>
  `,
})
export class SearchPageComponent {
  // Two-way bind the 'q' query parameter (?q=...)
  protected readonly searchTerm = queryParam('q');

  constructor() {
    effect(() => {
      const currentTerm = this.searchTerm();
      console.log('Search term changed:', currentTerm);
      // Trigger API call, update results, etc. based on currentTerm
    });
  }
}
```

### url

Creates a read-only Signal that tracks the current router URL string.

- Updates after each successful navigation.
- Reflects the URL after any redirects (urlAfterRedirects).
- Initializes with the router's current URL synchronously.

```typescript
import { Component, effect } from '@angular/core';
import { url } from '@mmstack/router-core';

@Component({
  selector: 'app-header',
  standalone: true,
  template: `<nav>Current Path: {{ currentUrl() }}</nav>`,
})
export class HeaderComponent {
  protected readonly currentUrl = url();
}
```

## Preloading Utilities

---

Enhance your application's performance by preloading Angular modules. This library provides a flexible directive and a smart preloading strategy to load modules just before they are needed.

### PreloadStrategy

This is a custom Angular PreloadingStrategy that works in tandem with the mmstack `Link` (via an internal `PreloadService`) to intelligently preload lazy-loaded modules.

**Features**:

- Listens for preload requests triggered by the `Link` directive.
- Uses advanced path matching to identify the correct route to preload, even with route parameters and matrix parameters.
- Avoids preloading if the connection is slow (e.g., '2g' effective type) or if the user has data-saving enabled in their browser.
- Respects a `data: { preload: false }` flag in route configurations to explicitly disable preloading for specific routes.
- Prevents redundant preloading attempts for the same route path.

To enable this preloading strategy, you need to provide it in your application's main routing configuration.

```typescript
import { PreloadStrategy } from '@mmstack/router-core';
import { ApplicationConfig } from '@angular/core';
import { provideRouter, withPreloading } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    //...other providers
    provideRouter(routes, withPreloading(PreloadStrategy)),
  ],
};
```

### Link (mmLink)

The `Link` directive (used with the `mmLink` attribute) is an enhancement for Angular's standard `RouterLink` directive. It adds the capability to preload the JavaScript modules associated with the linked route, based on user interaction or visibility. Other than the added `preloadOn` input & `preloading` output it directly proxies `RouterLink`.

- `preloadOn`: `input<'hover' | 'visible' | null>()` [default: 'hover'] specifies when to preload, `null` disables preloading
- `preloading` - `output<void>()` fires when route is registered for preloading (before load)

To use it simply replace any exiting routerLinks that you would like to enable preloading on with the mmLink, you can keep all existing inputs the same. And add the mmstack `PreloadStrategy` in your configuration

```typescript
import { Link } from '@mmstack/router-core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-navigation',
  standalone: true,
  imports: [Link, RouterLink],
  template: `
    <nav>
      <!-- preload on hover -->
      <a [mmLink]="['/features']" preloadOn="hover">Features</a>
      <!-- preload on visible -->
      <a [mmLink]="['/pricing']" preloadOn="visible">Pricing</a>
      <!-- no preload -->
      <a [mmLink]="['/contact']" [preloadOn]="null">Contact</a>
      <!-- preload on hover -->
      <a [mmLink]="['/about']">About</a>
      <!-- no preload, or just use [preloadOn]="null" -->
      <a [routerLink]="['/terms']">Terms & Conditions</a>
    </nav>
  `,
})
export class NavigationComponent {}
```

## Headless breadcrumb utilities

This library includes a signal-based, headless toolkit for generating and managing breadcrumbs in your Angular application. It provides the logic to derive breadcrumb data from your routes, allowing you to easily build a completely custom breadcrumb UI component & let the library worry about active routes :)

### Consuming breadcrumbs

The primary way to access the breadcrumb data is via the `injectBreadcrumbs` function. It returns a `Signal<Breadcrumb[]>` that updates automatically as navigation changes. Each `Breadcrumb` object in the array contains reactive signals for its `label`, `link`, `ariaLabel`, and a static id for iteration purposes.

```typescript
import { Component } from '@angular/core';
import { injectBreadcrumbs } from '@mmstack/router-core'; // Adjust path if needed

@Component({
  selector: 'app-breadcrumbs',
  standalone: true,
  template: `
    <nav aria-label="breadcrumb">
      <ol>
        @for (crumb of breadcrumbs(); track crumb.id) {
          <li>
            <a [href]="crumb.link()" [attr.aria-label]="crumb.ariaLabel()">{{ crumb.label() }}</a>
          </li>
        }
      </ol>
    </nav>
  `,
})
export class CustomBreadcrumbsComponent {
  protected readonly breadcrumbs = injectBreadcrumbs();
}
```

### Registering custom breadcrumbs

For routes where automatic breadcrumb generation isn't sufficient or when you need more control, you can manually define breadcrumbs using the `createBreadcrumb` route resolver.

This function allows you to specify the label (static or dynamic via a function) and other properties for a breadcrumb associated with a particular route.
You can use injection in the factory function, as you would with any resolver, making translations or subscribing to dynamic data a breaze! :)

```typescript
import { Routes } from '@angular/router';
import { createBreadcrumb } from '@mmstack/router-core';
import { HomeComponent } from './home.component';
import { UserProfileComponent } from './user-profile.component';
import { UserStore } from './user.store';
import { inject } from '@angular/core';
import { AdminComponent } from './admin.component';

export const appRoutes: Routes = [
  {
    path: 'home',
    component: HomeComponent,
    resolve: {
      // Simple static breadcrumb
      breadcrumb: createBreadcrumb(() => ({
        label: 'Home',
      })),
    },
  },
  {
    path: 'admin',
    component: AdminComponent,
    data: {
      skipBreadcrumb: true, // opt out of auto-generation for this specific route
    },
  },
  {
    path: 'users/:userId',
    component: UserProfileComponent,
    resolve: {
      breadcrumb: createBreadcrumb(() => {
        const userStore = inject(UserStore);
        return {
          label: () => `Profile: ${userStore.currentUser().name}` ?? 'Loading...',
          ariaLabel: () => `View profile for ${userStore.currentUser().name ?? 'user'}`,
        };
      }),
    },
  },
];
```

### Configuration [optional]

The breadcrumb system can be configured globally using `provideBreadcrumbConfig`. This allows you to, for example, set the system to 'manual' mode (disabling all automatic generation) or provide a custom function for generating breadcrumb labels.

```typescript
import { provideRouter } from '@angular/router';
import { provideBreadcrumbConfig, BreadcrumbConfig, ResolvedLeafRoute } from '@mmstack/router-core'; // Adjust path
import { appRoutes } from './app.routes';
import { ApplicationConfig } from '@angular/core';

// Example: Custom label generation strategy
const customLabelStrategy = () => {
  // you can inject root injectable services/stores here.
  return (leaf: ResolvedLeafRoute): string => {
    return leaf.route.data?.['navTitle'] || leaf.route.title || 'Default Title';
  };
};
export const appConfig: ApplicationConfig = {
  providers: [
    // ...rest
    provideBreadcrumbConfig({
      // generation: 'manual' // When set to 'manual' the system only uses explicitly defined breadcrumbs
      generation: customLabelStrategy, // Or provide a custom generation function
    }),
  ],
};
```

## Title utilities

This library provides a helper function, `createTitle`, to set the document title dynamically from within your route configuration. It integrates seamlessly with Angular's built-in `title` property on routes, allowing for both static and signal-based reactive titles.

By default, the system will use a title defined on a route's `data` or `title` property. createTitle enhances this by allowing titles to be derived from reactive state.

### Using `createTitle`

The `createTitle` function is a route resolver that returns a title string. You use it directly in the `title` property of a route definition. It can accept a function that returns a static string or a function that returns a dynamic string (which will be converted to a `signal`).

```typescript
import { Routes } from '@angular/router';
import { createTitle } from '@mmstack/router-core';
import { inject } from '@angular/core';
import { ProductStore } from './product.store';

export const appRoutes: Routes = [
  {
    path: 'about',
    // Example 1: Static title
    resolve: {
      title: createTitle(() => 'About Us'), // static
    },
    loadComponent: () => import('./about.component').then((m) => m.AboutComponent),
  },
  {
    path: 'products/:id',
    // Example 2: Dynamic, signal-based title from a store
    resolve: {
      title: createTitle(() => {
        const productStore = inject(ProductStore);
        // The inner function creates a computed signal under the hood
        return () => `Product: ${productStore.product().name ?? 'Loading...'}`;
      }),
    },
    loadComponent: () => import('./product-detail.component').then((m) => m.ProductComponent),
  },
];
```

### Configuration [optional]

You can provide a global configuration to prepend or append text to all titles using provideTitleConfig.

```typescript
import { provideRouter } from '@angular/router';
import { provideTitleConfig } from '@mmstack/router-core';
import { appRoutes } from './app.routes';
import { ApplicationConfig } from '@angular/core';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(appRoutes),
    provideTitleConfig({
      // Prefix can be a static string...
      // prefix: 'My Awesome App | '

      // ...or a function for more control over the format
      prefix: (title) => (title ? `${title} - MyApp` : 'MyApp'),
    }),
  ],
};
```
