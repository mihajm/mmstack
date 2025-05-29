# @mmstack/primitives

A collection of utility functions and primitives designed to enhance development with Angular Signals, providing helpful patterns and inspired by features from other reactive libraries. All value helpers also use pure derivations (no effects/RxJS).

[![npm version](https://badge.fury.io/js/%40mmstack%2Fprimitives.svg)](https://badge.fury.io/js/%40mmstack%2Fprimitives)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/primitives/LICENSE)

## Installation

```bash
npm install @mmstack/primitives
```

## Primitives

This library provides the following primitives:

- `debounced` - Creates a writable signal whose value updates are debounced after set/update.
- `mutable` - A signal variant allowing in-place mutations while triggering updates.
- `stored` - Creates a signal synchronized with persistent storage (e.g., localStorage).
- `mapArray` - Maps a reactive array efficently into an array of stable derivations.
- `toWritable` - Converts a read-only signal to writable using custom write logic.
- `derived` - Creates a signal with two-way binding to a source signal.

---

### debounced

Creates a WritableSignal where the propagation of its value (after calls to .set() or .update()) is delayed. The publicly readable signal value updates only after a specified time (ms) has passed without further set/update calls. It also includes an .original property, which is a Signal reflecting the value immediately after set/update is called.

```typescript
import { Component, signal, effect } from '@angular/core';
import { debounced, debounce } from '@mmstack/primitives';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-debounced',
  template: `<input [(ngModel)]="searchTerm" />`,
})
export class SearchComponent {
  searchTerm = debounced('', { ms: 300 }); // Debounce for 300ms

  constructor() {
    effect(() => {
      // Runs 300ms after the user stops typing
      console.log('Perform search for:', this.searchTerm());
    });
    effect(() => {
      // Runs immediately on input change
      console.log('Input value:', this.searchTerm.original());
    });
  }
}
```

You can also debounce an existing signal:

```typescript
import { debounce } from '@mmstack/primitives';

const query = signal('');
const debouncedQuery = debounce(query, { ms: 300 });
```

### mutable

Creates a MutableSignal, a signal variant designed for scenarios where you want to perform in-place mutations on objects or arrays held within the signal, while still ensuring Angular's change detection is correctly triggered. It provides .mutate() and .inline() methods alongside the standard .set() and .update(). Please note that any computeds, which resolve non-primitive values from a mutable require equals to be set to false.

```typescript
import { Component, computed, effect } from '@angular/core';
import { mutable } from '@mmstack/primitives';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-mutable',
  template: ` <button (click)="incrementAge()">inc</button> `,
})
export class SearchComponent {
  user = mutable({ name: { first: 'John', last: 'Doe' }, age: 30 });

  constructor() {
    effect(() => {
      // Runs every time user is mutated
      console.log(this.user());
    });

    const age = computed(() => this.user().age);

    effect(() => {
      // Runs every time age changes
      console.log(age());
    });

    const name = computed(() => this.user().name);
    effect(() => {
      // Doesnt run if user changes, unless name is destructured
      console.log(name());
    });

    const name2 = computed(() => this.user().name, {
      equal: () => false,
    });

    effect(() => {
      // Runs every time user changes (even if name did not change)
      console.log(name2());
    });
  }

  incrementAge() {
    user.mutate((prev) => {
      prev.age++;
      return prev;
    });
  }

  incrementInline() {
    user.inline((prev) => {
      prev.age++;
    });
  }
}
```

### stored

Creates a WritableSignal whose state is automatically synchronized with persistent storage (like localStorage or sessionStorage), providing a fallback value when no data is found or fails to parse.

It handles Server-Side Rendering (SSR) gracefully, allows dynamic storage keys, custom serialization/deserialization, custom storage providers, and optional synchronization across browser tabs via the storage event. It returns a StoredSignal<T> which includes a .clear() method and a reactive .key signal.

```typescript
import { Component, effect, signal } from '@angular/core';
import { stored } from '@mmstack/primitives';
// import { FormsModule } from '@angular/forms'; // Needed for ngModel

@Component({
  selector: 'app-theme-selector',
  standalone: true,
  // imports: [FormsModule], // Import if using ngModel
  template: `
    Theme:
    <select [value]="theme()" (change)="theme.set($event.target.value)">
      <option value="light">Light</option>
      <option value="dark">Dark</option>
      <option value="system">System</option>
    </select>
    <button (click)="theme.clear()">Reset Theme</button>
    <p>Using storage key: {{ theme.key() }}</p>
  `,
})
export class ThemeSelectorComponent {
  // Persist theme preference in localStorage, default to 'system'
  theme = stored<'light' | 'dark' | 'system'>('system', {
    key: 'user-theme',
    syncTabs: true, // Sync theme choice across tabs
  });

  constructor() {
    effect(() => {
      console.log(`Theme set to: ${this.theme()}`);
      // Logic to apply theme (e.g., add class to body)
      document.body.className = `theme-${this.theme()}`;
    });
  }
}
```

### mapArray

Reactive map helper that stabilizes a source array Signal by length. It provides stability by giving the mapping function a stable Signal<T> for each item based on its index. Sub signals are not re-created, rather they propagate value updates through. This is particularly useful for rendering lists (@for) as it minimizes DOM changes when array items change identity but represent the same conceptual entity.

```typescript
import { Component, signal } from '@angular/core';
import { mapArray } from '@mmstack/primitives';

@Component({
  selector: 'app-map-demo',
  template: `
    <ul>
      @for (item of displayItems(); track item) {
        <li>{{ item() }}</li>
      }
    </ul>
    <button (click)="addItem()">Add</button>
    <button (click)="updateFirst()">Update First</button>
  `,
})
export class ListComponent {
  sourceItems = signal([
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
  ]);

  readonly displayItems = mapArray(this.sourceItems, (child, index) => computed(() => `Item ${index}: ${child().name}`));

  addItem() {
    this.sourceItems.update((items) => [...items, { id: Date.now(), name: String.fromCharCode(67 + items.length - 2) }]);
  }

  updateFirst() {
    this.sourceItems.update((items) => {
      items[0] = { ...items[0], name: items[0].name + '+' };
      return [...items]; // New array, but mapArray keeps stable signals
    });
  }
}
```

### toWritable

A utility function that converts a read-only Signal into a WritableSignal by allowing you to provide custom implementations for the .set() and .update() methods. This is useful for creating controlled write access to signals that are naturally read-only (like those created by computed). This is used under the hood in derived.

```typescript
import { Component, signal, effect } from '@angular/core';
import { toWritable } from '@mmstack/primitives';

const user = signal({ name: 'John' });

const name = toWritable(
  computed(() => user().name),
  (name) => user.update((prev) => ({ ...prev, name })),
); // WritableSignal<string> bound to user signal
```

### derived

Creates a WritableSignal that represents a part of another source WritableSignal (e.g., an object property or an array element), enabling two-way data binding. Changes to the source update the derived signal, and changes to the derived signal (via .set() or .update()) update the source signal accordingly.

```typescript
const user = signal({ name: 'John' });

const name = derived(user, 'name'); // WritableSignal<string>, which updates user signal & reacts to changes in the name property

// Full syntax example
const name2 = derived(user, {
  from: (u) => u.name,
  onChange: (name) => user.update((prev) => ({ ...prev, name })),
});
```
