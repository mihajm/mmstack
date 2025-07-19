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
- `throttled` - Creates a writable signal whose value updates are rate-limited.
- `mutable` - A signal variant allowing in-place mutations while triggering updates.
- `stored` - Creates a signal synchronized with persistent storage (e.g., localStorage).
- `withHistory` - Enhances a signal with a complete undo/redo history stack.
- `mapArray` - Maps a reactive array efficently into an array of stable derivations.
- `toWritable` - Converts a read-only signal to writable using custom write logic.
- `derived` - Creates a signal with two-way binding to a source signal.
- `sensor` - A facade function to create various reactive sensor signals (e.g., mouse position, network status, page visibility, dark mode preference)." (This was the suggestion from before; it just reads a little smoother and more accurately reflects what the facade creates directly).
- `until` - Creates a Promise that resolves when a signal's value meets a specific condition.
- `mediaQuery` - A generic primitive that tracks a CSS media query (forms the basis for `prefersDarkMode` and `prefersReducedMotion`).
- `elementVisibility` - Tracks if an element is intersecting the viewport using IntersectionObserver.

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

### throttled

Creates a WritableSignal whose value is rate-limited. It ensures that the public-facing signal only updates at most once per specified time interval (ms). It uses a trailing-edge strategy, meaning it updates with the most recent value at the end of the interval. This is useful for handling high-frequency events like scrolling or mouse movement without overwhelming your application's reactivity.

```typescript
import { Component, signal, effect } from '@angular/core';
import { throttled } from '@mmstack/primitives';
import { JsonPipe } from '@angular/common';

@Component({
  selector: 'app-throttle-demo',
  standalone: true,
  imports: [JsonPipe],
  template: `
    <div (mousemove)="onMouseMove($event)" style="width: 300px; height: 200px; border: 1px solid black; padding: 10px; user-select: none;">Move mouse here to see updates...</div>
    <p><b>Original Position:</b> {{ position.original() | json }}</p>
    <p><b>Throttled Position:</b> {{ position() | json }}</p>
  `,
})
export class ThrottleDemoComponent {
  // Throttle updates to at most once every 200ms
  position = throttled({ x: 0, y: 0 }, { ms: 200 });

  constructor() {
    // This effect runs on every single mouse move event.
    effect(() => {
      // console.log('Original value updated:', this.position.original());
    });
    // This effect will only run at most every 200ms.
    effect(() => {
      console.log('Throttled value updated:', this.position());
    });
  }

  onMouseMove(event: MouseEvent) {
    this.position.set({ x: event.offsetX, y: event.offsetY });
  }
}
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
import { mapArray, mutable } from '@mmstack/primitives';

@Component({
  selector: 'app-map-demo',
  template: `
    <ul>
      @for (item of displayItems(); track item) {
        <li>{{ item() }}</li>
        @if ($first) {
            <button (click)="updateFirst(item)">Update First</button>
        }
      }
    </ul>
    <button (click)="addItem()">Add</button>
  `,
})
export class ListComponent {
  readonly sourceItems = signal([
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

  // since the underlying source is a signal we can also create updaters in the mapper
  readonly updatableItems = mapArray(this.sourceItems, (child, index) => {

    return {
      value: computed(() => `Item ${index}: ${child().name}`))
      updateName: () => child.update((cur) => ({...cur, name: cur.name + '+'}))
    };
  });


  // since the underlying source is a WritableSignal we can also create updaters in the mapper
  readonly writableItems = mapArray(this.sourceItems, (child, index) => {

    return {
      value: computed(() => `Item ${index}: ${child().name}`))
      updateName: () => child.update((cur) => ({...cur, name: cur.name + '+'}))
    };
  });

  // if the source is a mutable signal we can even update them inline
  readonly sourceItems = mutable([
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
  ]);

  readonly mutableItems = mapArray(this.sourceItems, (child, index) => {

    return {
      value: computed(() => `Item ${index}: ${child().name}`))
      updateName: () => child.inline((cur) => {
        cur.name += '+';
      })
    };
  });
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

### withHistory

Enhances any WritableSignal with a complete undo/redo history stack. This is useful for building user-friendly editors, forms, or any feature where reverting changes is necessary. It provides .undo(), .redo(), and .clear() methods, along with reactive boolean signals like .canUndo and .canRedo to easily enable or disable UI controls.

```typescript
import { FormsModule } from '@angular/forms';
import { JsonPipe } from '@angular/common';
import { withHistory } from '@mmstack/primitives';
import { Component, signal, effect } from '@angular/core';

@Component({
  selector: 'app-history-demo',
  standalone: true,
  imports: [FormsModule, JsonPipe],
  template: `
    <h4>Simple Text Editor</h4>
    <textarea [(ngModel)]="text" rows="4" cols="50"></textarea>
    <div class="buttons" style="margin-top: 8px; display: flex; gap: 8px;">
      <button (click)="text.undo()" [disabled]="!text.canUndo()">Undo</button>
      <button (click)="text.redo()" [disabled]="!text.canRedo()">Redo</button>
      <button (click)="text.clear()" [disabled]="!text.canClear()">Clear History</button>
    </div>
    <p>History Stack:</p>
    <pre>{{ text.history() | json }}</pre>
  `,
})
export class HistoryDemoComponent {
  // Create a signal and immediately enhance it with history capabilities.
  text = withHistory(signal('Hello, type something!'), { maxSize: 10 });

  constructor() {
    // You can react to history changes as well
    effect(() => {
      console.log('History stack changed:', this.text.history());
    });
  }
}
```

### sensor

### sensor

The `sensor()` facade provides a unified way to create various reactive sensor signals that track browser events, states, and user preferences. You specify the type of sensor you want (e.g., `'mousePosition'`, `'networkStatus'`, `'windowSize'`, `'dark-mode'`), and it returns the corresponding signal, often with specific properties or methods. These primitives are generally SSR-safe and handle their own event listener cleanup.

You can either use the `sensor('sensorType', options)` facade or import the specific sensor functions directly if you prefer.

**Facade Usage Example:**

```typescript
import { sensor } from '@mmstack/primitives';
import { effect } from '@angular/core';

const network = sensor('networkStatus');
const mouse = sensor('mousePosition', { throttle: 50, coordinateSpace: 'page' });
const winSize = sensor('windowSize', { throttle: 150 });
const isDark = sensor('dark-mode');

effect(() => console.log('Online:', network().isOnline));
effect(() => console.log('Mouse X:', mouse().x));
effect(() => console.log('Window Width:', winSize().width));
effect(() => console.log('Dark Mode Preferred:', isDark()));
```

Individual sensors available through the facade or direct import:

#### mousePosition

Tracks the mouse cursor's position. By default, updates are throttled to 100ms. It provides the main throttled signal and an .unthrottled property to access the raw updates.

Key Options: target, coordinateSpace ('client' or 'page'), touch (boolean), throttle (ms).

```typescript
import { Component, effect } from '@angular/core';
import { sensor } from '@mmstack/primitives'; // Or import { mousePosition }
import { JsonPipe } from '@angular/common';

@Component({
  selector: 'app-mouse-tracker',
  standalone: true,
  imports: [JsonPipe],
  template: `
    <div (mousemove)="onMouseMove($event)" style="width: 300px; height: 200px; border: 1px solid black; padding: 10px; user-select: none;">Move mouse here...</div>
    <p><b>Throttled Position:</b> {{ mousePos() | json }}</p>
    <p><b>Unthrottled Position:</b> {{ mousePos.unthrottled() | json }}</p>
  `,
})
export class MouseTrackerComponent {
  // Using the facade
  readonly mousePos = sensor('mousePosition', { coordinateSpace: 'page', throttle: 200 });
  // Or direct import:
  // readonly mousePos = mousePosition({ coordinateSpace: 'page', throttle: 200 });

  // Note: The (mousemove) event here is just to show the example area works.
  // The mousePosition sensor binds its own listeners based on the target option.
  onMouseMove(event: MouseEvent) {
    // No need to call set, mousePosition handles it.
  }

  constructor() {
    effect(() => console.log('Throttled Mouse:', this.mousePos()));
    effect(() => console.log('Unthrottled Mouse:', this.mousePos.unthrottled()));
  }
}
```

#### networkStatus

Tracks the browser's online/offline status. The returned signal is a boolean (`true` for online) and has an attached `.since` signal indicating when the status last changed.

```typescript
import { Component, effect } from '@angular/core';
import { sensor } from '@mmstack/primitives'; // Or import { networkStatus }
import { DatePipe } from '@angular/common';

@Component({
  selector: 'app-network-info',
  standalone: true,
  imports: [DatePipe],
  template: `
    @if (netStatus()) {
      <p>✅ Online (Since: {{ netStatus.since() | date: 'short' }})</p>
    } @else {
      <p>❌ Offline (Since: {{ netStatus.since() | date: 'short' }})</p>
    }
  `,
})
export class NetworkInfoComponent {
  readonly netStatus = sensor('networkStatus');

  constructor() {
    effect(() => {
      console.log('Network online:', this.netStatus(), 'Since:', this.netStatus.since());
    });
  }
}
```

#### pageVisibility

Tracks the page's visibility state (e.g., 'visible', 'hidden') using the Page Visibility API.

```typescript
import { Component, effect } from '@angular/core';
import { sensor } from '@mmstack/primitives'; // Or import { pageVisibility }

@Component({
  selector: 'app-visibility-logger',
  standalone: true,
  template: `<p>Page is currently: {{ visibility() }}</p>`,
})
export class VisibilityLoggerComponent {
  readonly visibility = sensor('pageVisibility');

  constructor() {
    effect(() => {
      console.log('Page visibility changed to:', this.visibility());
      if (this.visibility() === 'hidden') {
        // Perform cleanup or pause tasks
      }
    });
  }
}
```

#### windowSize

Tracks the browser window's inner dimensions (width and height). Updates are throttled by default (100ms). It provides the main throttled signal and an .unthrottled property to access raw updates.

```typescript
import { Component, effect, computed } from '@angular/core';
import { sensor } from '@mmstack/primitives'; // Or import { windowSize }

@Component({
  selector: 'app-responsive-display',
  standalone: true,
  template: `
    <p>Current Window Size: {{ winSize().width }}px x {{ winSize().height }}px</p>
    <p>Unthrottled: W: {{ winSize.unthrottled().width }} H: {{ winSize.unthrottled().height }}</p>
    @if (isMobileDisplay()) {
      <p>Displaying mobile layout.</p>
    } @else {
      <p>Displaying desktop layout.</p>
    }
  `,
})
export class ResponsiveDisplayComponent {
  readonly winSize = sensor('windowSize', { throttle: 150 });
  // Or: readonly winSize = windowSize({ throttle: 150 });

  readonly isMobileDisplay = computed(() => this.winSize().width < 768);

  constructor() {
    effect(() => console.log('Window Size (Throttled):', this.winSize()));
  }
}
```

#### scrollPosition

Tracks the scroll position (x, y) of the window or a specified HTML element. Updates are throttled by default (100ms). It provides the main throttled signal and an .unthrottled property to access raw updates.

```typescript
import { Component, effect, ElementRef, viewChild } from '@angular/core';
import { sensor } from '@mmstack/primitives'; // Or import { scrollPosition }
import { JsonPipe } from '@angular/common';

@Component({
  selector: 'app-scroll-indicator',
  standalone: true,
  imports: [JsonPipe],
  template: `
    <div style="height: 100px; border-bottom: 2px solid red; position: fixed; top: 0; left: 0; width: 100%; background: white; z-index: 10;">
      Page Scroll Y: {{ pageScroll().y }}px
      <p>Unthrottled Y: {{ pageScroll.unthrottled().y }}</p>
    </div>
    <div #scrollableContent style="height: 2000px; padding-top: 120px;">Scroll down...</div>
  `,
})
export class ScrollIndicatorComponent {
  readonly pageScroll = sensor('scrollPosition', { throttle: 50 });
  // Or: readonly pageScroll = scrollPosition({ throttle: 50 });

  constructor() {
    effect(() => {
      // Example: Change header style based on scroll
      console.log('Page scroll Y (Throttled):', this.pageScroll().y);
    });
  }
}
```

#### mediaQuery, prefersDarkMode() & prefersReducedMotion()

A generic mediaQuery primitive, you can use directly for any CSS media query. Two specific versions have been created for `prefersDarkMode()` & `prefersReducedMotion()`.
Reacts to changes in preferences & exposes a `Signal<boolean>`.

```typescript
import { Component, effect } from '@angular/core';
import { mediaQuery, prefersDarkMode, prefersReducedMotion } from '@mmstack/primitives'; // Direct import

@Component({
  selector: 'app-layout-checker',
  standalone: true,
  template: `
    @if (isLargeScreen()) {
      <p>Using large screen layout.</p>
    } @else {
      <p>Using small screen layout.</p>
    }
  `,
})
export class LayoutCheckerComponent {
  readonly isLargeScreen = mediaQuery('(min-width: 1280px)');
  readonly prefersDark = prefersDarkMode(); // is just a pre-defined mediaQuery signal
  readonly prefersReducedMotion = prefersReducedMotion(); // is just a pre-defined mediaQuery signal
  constructor() {
    effect(() => {
      console.log('Is large screen:', this.isLargeScreen());
    });
  }
}
```

### until

The `until` primitive provides a powerful way to bridge Angular's reactive signals with imperative, Promise-based asynchronous code. It returns a Promise that resolves when the value of a given signal satisfies a specified predicate function.

This is particularly useful for:

- Orchestrating complex sequences of operations (e.g., waiting for data to load or for a user action to complete before proceeding).
- Writing tests where you need to await a certain state before making assertions.
- Integrating with other Promise-based APIs.

It also supports optional timeouts and automatic cancellation via DestroyRef if the consuming context (like a component) is destroyed before the condition is met.

```typescript
import { signal } from '@angular/core';
import { until } from '@mmstack/primitives';

it('should reject on timeout if the condition is not met in time', async () => {
  const count = signal(0);
  const timeoutDuration = 500;

  const untilPromise = until(count, (value) => value >= 10, { timeout: timeoutDuration });

  // Simulate a change that doesn't meet the condition
  setTimeout(() => count.set(1), 10);

  await expect(untilPromise).toThrow(`until: Timeout after ${timeoutDuration}ms.`);
});
```

### elementVisibility

Tracks if a target DOM element is intersecting with the viewport (or a specified root element) using the `IntersectionObserver` API. This is highly performant for use cases like lazy-loading content or triggering animations when elements scroll into view.

It can observe a static `ElementRef`/`Element` or a `Signal` that resolves to one, allowing for dynamic targets. The returned signal emits the full `IntersectionObserverEntry` object (or `undefined`) & exposes a sub-signal `.visible` which is just a boolean signal for ease of use

```typescript
import { Component, effect, ElementRef, viewChild, computed } from '@angular/core';
import { elementVisibility } from '@mmstack/primitives';

@Component({
  selector: 'app-lazy-load-item',
  standalone: true,
  template: `
    <div #itemToObserve style="height: 300px; margin-top: 100vh; border: 2px solid green;">
      @if (intersectionEntry.visible()) {
        <p>This content was lazy-loaded because it became visible!</p>
      } @else {
        <p>Item is off-screen. Scroll down to load it.</p>
      }
    </div>
  `,
})
export class LazyLoadItemComponent {
  readonly itemRef = viewChild.required<ElementRef<HTMLDivElement>>('itemToObserve', {
    read: ElementRef,
  });

  // Observe the element, get the full IntersectionObserverEntry
  readonly intersectionEntry = elementVisibility(this.itemRef);

  constructor() {
    effect(() => {
      if (this.intersectionEntry.visible()) {
        console.log('Item is now visible!', this.intersectionEntry());
      } else {
        console.log('Item is no longer visible or not yet visible.');
      }
    });
  }
}
```
