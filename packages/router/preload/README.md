# @mmstack/router-preload

Core utilities and Signal-based primitives for enhancing development with `@angular/router`. This library provides helpers for common routing tasks and reactive integration with router state.

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
