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

This is a custom Angular PreloadingStrategy that works in tandem with the mmstack `LinkDirective` (via an internal `PreloadService`) to intelligently preload lazy-loaded modules.

**Features**:

- Listens for preload requests triggered by the `LinkDirective`.
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

### LinkDirective (mmLink)

The `LinkDirective` (used with the `mmLink` attribute) is an enhancement for Angular's standard `RouterLink` directive. It adds the capability to preload the JavaScript modules associated with the linked route, based on user interaction or visibility. Other than the added `preloadOn` input & `preloading` output it directly proxies `RouterLink`.

- `preloadOn`: `input<'hover' | 'visible' | null>()` [default: 'hover'] specifies when to preload, `null` disables preloading
- `preloading` - `output<void>()` fires when route is registered for preloading (before load)

To use it simply replace any exiting routerLinks that you would like to enable preloading on with the mmLink, you can keep all existing inputs the same. And add the mmstack `PreloadStrategy` in your configuration

```typescript
import { LinkDirective } from '@mmstack/router-core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-navigation',
  standalone: true,
  imports: [LinkDirective, RouterLink],
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
