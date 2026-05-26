# @mmstack/primitives

**Signal-native utilities for Angular — debounce, throttle, two-way derivations, deep stores, undo/redo, sensors, and more.**

[![npm version](https://badge.fury.io/js/%40mmstack%2Fprimitives.svg)](https://badge.fury.io/js/%40mmstack%2Fprimitives)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/primitives/LICENSE)

`@mmstack/primitives` is a low-level toolbox of Angular Signal primitives. Every value-producing helper is a pure derivation — no `effect()`, no RxJS bridges, no zone churn — so you can compose them freely inside `computed()` graphs without worrying about side-effect lifetimes. Effect-shaped helpers (`tabSync`, `nestedEffect`, sensors) clean up via `DestroyRef`.

## Install

```bash
npm install @mmstack/primitives
```

## Contents

- [Writable signal variants](#writable-signal-variants) — `mutable`, `derived`, `store` / `mutableStore`, `toWritable`
- [Timing & propagation](#timing--propagation) — `debounced`, `throttled`, `until`
- [Reactive collections](#reactive-collections) — `indexArray`, `keyArray`, `mapObject`
- [Effects](#effects) — `nestedEffect`
- [History & persistence](#history--persistence) — `withHistory`, `stored`, `tabSync`
- [Performance helpers](#performance-helpers) — `chunked`, `pooled` / `pooledArray` / `pooledMap` / `pooledSet`
- [Sensors](#sensors) — `sensor()` facade + browser-state signals
- [Pipelines](#pipelines) — `piped` / `pipeable`, operators (`select`, `map`, `filter`, `filterWith`, `distinct`, `combineWith`, `tap`, `startWith`, `pairwise`, `scan`)

## Writable signal variants

### `mutable`

A `WritableSignal` with `.mutate()` and `.inline()` for in-place updates. Cheaper than `update(prev => ({...prev, ...})) ` for large objects or arrays, while still notifying dependents.

```typescript
import { mutable } from '@mmstack/primitives';

const user = mutable({ name: 'John', age: 30 });

user.mutate((prev) => {
  prev.age++;
  return prev;
});

user.inline((prev) => {
  prev.age++;
}); // void return — same effect
```

> **Caveat:** A `computed()` that returns a non-primitive value derived from a mutable signal must declare `equal: false` (or `() => false`) — otherwise the reference-equality default suppresses the change notification. This is documented inline on `mutable` itself.

### `derived`

A two-way-bound slice of another `WritableSignal`. Writes to the derived signal update the source; changes to the source flow through. Use a key/index shorthand for object/array slices, or pass a `{ from, onChange }` pair for custom mappings.

```typescript
import { derived } from '@mmstack/primitives';

const user = signal({ name: 'John', age: 30 });

const name = derived(user, 'name'); // WritableSignal<string>
const list = signal([1, 2, 3]);
const second = derived(list, 1); // WritableSignal<number>

// Full custom mapping
const upper = derived(user, {
  from: (u) => u.name.toUpperCase(),
  onChange: (next) => user.update((u) => ({ ...u, name: next.toLowerCase() })),
});
```

When the source is a `MutableSignal`, the derived signal is also a `MutableSignal` — `derived(state, 'items').mutate(arr => { arr.push(...); return arr })` propagates correctly.

### `store` / `mutableStore`

Proxies an object (or signal of an object) into a tree of `WritableSignal`s — one per property, lazily created and cached via `WeakRef`. Arrays expose indices as signals plus a `.length` signal and `Symbol.iterator`. Mutability propagates: if the root is a `MutableSignal`, every child is too.

```typescript
import { store, mutableStore } from '@mmstack/primitives';

const state = store({
  user: { name: 'Alice', address: { city: 'NYC', zip: 10001 } },
  tags: ['admin', 'editor'],
});

state.user.address.city(); // Signal read: 'NYC'
state.user.address.zip.set(90210); // Two-way write into the source
state.tags[0](); // 'admin'
state.tags.length(); // 2 (reactive)

const settings = mutableStore({ notifications: { email: true } });
settings.notifications.mutate((n) => {
  n.email = false;
});
```

Top-level array support isn't exposed yet — use `indexArray` / `keyArray` for those.

### `toWritable`

Turn any read-only `Signal<T>` into a `WritableSignal<T>` by providing custom `set` / `update` implementations. Powers `derived` internally; use it directly when you have a `computed` you want to expose as writable.

```typescript
import { toWritable } from '@mmstack/primitives';

const user = signal({ name: 'John' });
const name = toWritable(
  computed(() => user().name),
  (next) => user.update((u) => ({ ...u, name: next })),
);
```

## Timing & propagation

### `debounced`

A `WritableSignal` that holds its read value `ms` milliseconds after the last write. The underlying source is exposed as `.original` for callers that want the immediate value.

```typescript
import { debounce, debounced } from '@mmstack/primitives';

const query = debounced('', { ms: 300 }); // create + debounce
const wrapped = debounce(signal(''), { ms: 300 }); // debounce an existing signal

effect(() => fetch(query())); // fires 300ms after typing stops
effect(() => preview(query.original())); // fires immediately
```

### `throttled`

Rate-limits read propagation to at most one value per `ms` window. Defaults to **trailing-edge only** (the latest write within the window lands at the end). Pass `leading: true` to emit the first write immediately, `trailing: false` to suppress the trailing fire.

```typescript
import { throttled } from '@mmstack/primitives';

// Trailing edge only — first write held until window closes (default)
const t = throttled(0, { ms: 200 });

// Lodash-style leading + trailing
const both = throttled(0, { ms: 200, leading: true, trailing: true });

// Leading edge only — fires immediately, ignores writes during cooldown
const lead = throttled(0, { ms: 200, leading: true, trailing: false });
```

Same `.original` escape hatch as `debounced`.

### `until`

Resolves a Promise when a signal value satisfies a predicate. Supports type-narrowing predicates, optional timeout, and auto-cancellation when the consuming context is destroyed.

```typescript
import { until } from '@mmstack/primitives';

const event = signal<Event | null>(null);

// Narrowing predicate — promise resolves with MouseEvent
const click = await until(
  event,
  (e): e is MouseEvent => e instanceof MouseEvent,
);

// With a timeout
await until(progress, (p) => p === 100, { timeout: 5_000 });
```

## Reactive collections

### `indexArray` / `keyArray`

Map a source array signal into a stable array of derived values. `indexArray` stabilizes by **position** — each index gets a writable signal whose value is the item at that index. `keyArray` stabilizes by **identity** (via an optional `key` selector) — moving an item preserves its mapped output and just updates the item's index signal.

Both pool their internal buffers, so reordering a 10k-item list is much cheaper than `.map()` of a `computed`.

```typescript
import { indexArray, keyArray, mutable } from '@mmstack/primitives';

const items = mutable([
  { id: 1, name: 'A' },
  { id: 2, name: 'B' },
]);

// Position-stable: `child` is a MutableSignal<{ id, name }> for the current index.
const labels = indexArray(items, (child, index) =>
  computed(() => `Item ${index}: ${child().name}`),
);

// Identity-stable: `child` is the item value, `index` is a Signal<number>.
const keyed = keyArray(
  items,
  (child, index) => computed(() => `${index()}: ${child.name}`),
  { key: (item) => item.id },
);
```

`indexArray` is the cheaper default. Reach for `keyArray` only when DOM/instance reuse across reorders matters — `<for>` blocks rendering heavy components, charts, drag-and-drop reordering, etc.

### `mapObject`

The object equivalent of `keyArray`: map `Record<K, V>` into `Record<K, U>` with referential stability for unchanged keys. The mapping function receives the key and a writable signal slice (if the source is writable).

```typescript
import { mapObject } from '@mmstack/primitives';

const settings = signal<Record<string, boolean>>({
  wifi: true,
  bluetooth: false,
});

const controls = mapObject(
  settings,
  (key, value) => ({
    label: key.toUpperCase(),
    isActive: value, // WritableSignal<boolean>
    toggle: () => value.update((v) => !v),
  }),
  { onDestroy: (entry) => console.log(`Removed ${entry.label}`) },
);
```

## Effects

### `nestedEffect`

A SolidJS-style hierarchical effect: a `nestedEffect` created inside another `nestedEffect` is automatically destroyed and recreated when the parent re-runs. The outer effect only tracks the dependencies you read in _its_ body; the inner effect's deps are tracked only while it's alive.

```typescript
import { nestedEffect } from '@mmstack/primitives';

// `coldGuard` changes rarely, `hotSignal` fires often.
nestedEffect(() => {
  if (coldGuard()) {
    nestedEffect(() => {
      // Only tracks `hotSignal` while coldGuard is true.
      console.log(hotSignal());
    });
  }
});
```

Composes with `indexArray` to give each mapped item its own effect that's automatically torn down when the item is removed — see the doc comments on `nestedEffect` for the pattern.

## History & persistence

### `withHistory`

Wrap any `WritableSignal` (or pass an initial value) into one with `.undo()`, `.redo()`, `.clear()`, `.canUndo`, `.canRedo`, `.canClear`, and a reactive `.history` stack. `maxSize` bounds both the undo and redo stacks, with `cleanupStrategy: 'shift' | 'halve'`.

```typescript
import { withHistory } from '@mmstack/primitives';

const text = withHistory('Hello', { maxSize: 10, cleanupStrategy: 'halve' });

text.set('Hello world');
text.undo(); // back to 'Hello'
text.redo(); // forward to 'Hello world'
text.canUndo(); // Signal<boolean>
```

### `stored`

A `WritableSignal` whose value is synchronized with `localStorage` (or any compatible adapter). SSR-safe, supports dynamic keys, custom serialization, cross-tab sync via the `storage` event, and per-key cleanup strategies. The returned signal carries a `.clear()` method and a reactive `.key` signal.

```typescript
import { stored } from '@mmstack/primitives';

const theme = stored<'light' | 'dark' | 'system'>('system', {
  key: 'app-theme',
  syncTabs: true,
});

theme.set('dark');
theme.clear(); // restores fallback
```

### `tabSync`

Mirrors a `WritableSignal` across browser tabs via `BroadcastChannel`. Used internally by `@mmstack/resource`'s cache invalidation. Provide an explicit `id` in production — the auto-generated stack-frame ID is fine for prototyping but unstable across minified builds.

```typescript
import { tabSync } from '@mmstack/primitives';

const cart = tabSync(signal([]), { id: 'shopping-cart' });
```

## Performance helpers

### `chunked`

Time-slices a large array into progressive emissions to keep the main thread responsive. Emits the first `chunkSize` items immediately, then schedules the next batch on the next animation frame, microtask, or after a `ms` delay. Resets when the source array changes.

```typescript
import { chunked } from '@mmstack/primitives';

const visible = chunked(allItems, { chunkSize: 100, delay: 'frame' });
```

### `pooled` / `pooledArray` / `pooledMap` / `pooledSet`

Double-buffered object pools for high-frequency `computed` outputs. After a brief warmup, recomputation reaches **zero allocations**: two buffers swap on every read, with `reset` called on the dirty one before `computation` writes into it.

```typescript
import { pooledArray, pooledMap } from '@mmstack/primitives';

// Reuses one array across reads — no GC churn even at 60fps.
const activeIds = pooledArray<number[]>((buf) => {
  for (const item of items()) if (item.active) buf.push(item.id);
  return buf;
});

const byId = pooledMap<Map<number, Item>>((buf) => {
  for (const item of items()) buf.set(item.id, item);
  return buf;
});
```

> **Retention contract:** the returned value is only valid until the next read. Do not store it in component state, async closures, or anywhere outside the current reactive tick — the container is recycled and `reset`, mutating any reference you still hold.

For custom buffer types (typed arrays, structs) drop down to `pooled` directly. Complementary to `linkedSignal` (which carries previous _state_ forward) and `chunked` (which time-slices large outputs).

## Sensors

The `sensor()` facade creates browser-state signals with consistent SSR fallbacks and `DestroyRef`-driven cleanup. Each sensor is also available as a standalone function if you'd rather skip the facade.

```typescript
import { sensor } from '@mmstack/primitives';

const network = sensor('networkStatus'); // Signal<boolean> + .since
const isDark = sensor('dark-mode'); // Signal<boolean>
const winSize = sensor('windowSize', { throttle: 150 });
const mouse = sensor('mousePosition', {
  coordinateSpace: 'page',
  throttle: 50,
});
```

`sensors(['networkStatus', 'windowSize'])` returns a record of all requested sensors in one call.

### Available sensors

| Type                | Standalone fn                | Returns                                                | Notes                                                                      |
| ------------------- | ---------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `networkStatus`     | `networkStatus()`            | `Signal<boolean>` + `.since`                           | Online/offline. `since` is `Signal<Date>` of last transition.              |
| `pageVisibility`    | `pageVisibility()`           | `Signal<DocumentVisibilityState>`                      | `'visible' \| 'hidden' \| 'prerender'`.                                    |
| `mediaQuery`        | `mediaQuery(q)`              | `Signal<boolean>`                                      | Generic CSS media-query tracker.                                           |
| `dark-mode`         | `prefersDarkMode()`          | `Signal<boolean>`                                      | Shorthand for `(prefers-color-scheme: dark)`.                              |
| `reduced-motion`    | `prefersReducedMotion()`     | `Signal<boolean>`                                      | Shorthand for `(prefers-reduced-motion: reduce)`.                          |
| `windowSize`        | `windowSize()`               | `Signal<{ width, height }>` + `.unthrottled`           | Throttled to 100ms by default.                                             |
| `scrollPosition`    | `scrollPosition()`           | `Signal<{ x, y }>` + `.unthrottled`                    | Window or element scroll, throttled 100ms.                                 |
| `mousePosition`     | `mousePosition()`            | `Signal<{ x, y }>` + `.unthrottled`                    | Throttled 100ms. `coordinateSpace: 'client' \| 'page'`, optional `touch`.  |
| `elementVisibility` | `elementVisibility(target?)` | `Signal<IntersectionObserverEntry?>` + `.visible`      | IntersectionObserver-based, `.visible` is a boolean shorthand.             |
| `elementSize`       | `elementSize(target?)`       | `Signal<{ width, height }?>`                           | ResizeObserver-based. Defaults to `border-box`.                            |
| `geolocation`       | `geolocation(opt?)`          | `Signal<GeolocationPosition?>` + `.error` + `.loading` | One-shot by default; pass `watch: true` for `watchPosition`.               |
| `clipboard`         | `clipboard()`                | `Signal<string>` + `.copy(v)` + `.isSupported`         | Mirrors clipboard contents; `.copy` writes through and updates the signal. |
| `orientation`       | `orientation()`              | `Signal<{ angle, type }>`                              | Tracks `screen.orientation`.                                               |
| `batteryStatus`     | `batteryStatus()`            | `Signal<BatteryStatus \| null>`                        | `null` until `navigator.getBattery()` resolves, or forever if unsupported. |
| `idle`              | `idle({ ms })`               | `Signal<boolean>` + `.since`                           | Flips to `true` after `ms` of inactivity. Configurable activity events.    |
| `focusWithin`       | `focusWithin(target?)`       | `Signal<boolean>`                                      | Mirrors the `:focus-within` CSS pseudo-class.                              |

Element-targeting sensors (`elementSize`, `elementVisibility`, `focusWithin`) default `target` to `inject(ElementRef)` so they're drop-in inside a component.

### `signalFromEvent`

A generic EventTarget → Signal helper. Not surfaced through the `sensor()` facade (it needs positional arguments rather than an options bag), but it's how most of the sensors above are shaped under the hood.

```typescript
import { signalFromEvent } from '@mmstack/primitives';

// Raw event signal
const lastClick = signalFromEvent<MouseEvent>(document, 'click', null);

// Projecting overload — pluck just the data you want
const lastPoint = signalFromEvent<MouseEvent, { x: number; y: number }>(
  document,
  'mousemove',
  { x: 0, y: 0 },
  (e) => ({ x: e.clientX, y: e.clientY }),
);
```

The `target` accepts a static `EventTarget`, an `ElementRef`, or a `Signal` resolving to either — when the signal flips, the listener is moved automatically.

### Sensor example

```typescript
import { Component } from '@angular/core';
import { sensor } from '@mmstack/primitives';

@Component({
  selector: 'app-network-badge',
  template: `
    @if (network()) {
      <span class="online"
        >Online since {{ network.since() | date: 'short' }}</span
      >
    } @else {
      <span class="offline"
        >Offline since {{ network.since() | date: 'short' }}</span
      >
    }
  `,
})
export class NetworkBadgeComponent {
  protected readonly network = sensor('networkStatus');
}
```

## Pipelines

### `piped` and `pipeable`

Adds a chainable, fully typed `.pipe(...)` and `.map(...)` to any signal. `piped(initial)` creates a writable signal already wrapped; `pipeable(existing)` retrofits the API onto a signal you already have.

```typescript
import { piped, pipeable, map, distinct, scan } from '@mmstack/primitives';

const count = piped(1);

// .map composes value -> value transforms inline
const label = count.map(
  (n) => n * 2,
  (n) => `#${n}`,
);

// .pipe composes operators (signal -> signal)
const total = pipeable(signal(10)).pipe(
  map((n) => n * 3),
  distinct(),
  scan((acc, n) => acc + n, 0),
);
```

### Operators

All operators are `(src: Signal<I>) => Signal<O>` and compose via `.pipe(...)`.

| Operator                         | Shape                      | Notes                                                                   |
| -------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `select(fn, opt?)`               | `(I) => O`                 | Projection with optional equality. Identical to `map` + `distinct`.     |
| `map(fn)`                        | `(I) => O`                 | Pure transform.                                                         |
| `distinct(equal?)`               | `T -> T`                   | Suppress emissions when `equal(prev, next)` returns `true`.             |
| `combineWith(other, fn)`         | `(A, B) => R`              | Project two signals together.                                           |
| `filter(predicate)`              | `T -> T \| undefined`      | Keeps last passing value; returns `undefined` until the first match.    |
| `filterWith(predicate, initial)` | `T -> T`                   | Same as `filter` but emits `initial` before the first match.            |
| `tap(fn, injector?)`             | `T -> T`                   | Runs a side effect via `effect()`; pass an `Injector` when out of DI.   |
| `startWith(initial)`             | `T -> T \| U`              | Emits `initial` first, then mirrors source.                             |
| `pairwise()`                     | `T -> [T \| undefined, T]` | Emits `[prev, curr]` pairs (prev is `undefined` on the first emission). |
| `scan(reducer, seed)`            | `(R, T) => R`              | Reduce-like accumulator across emissions.                               |

## License

MIT © [Miha Mulec](https://github.com/mihajm)
