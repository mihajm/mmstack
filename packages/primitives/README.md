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

- [Writable signal variants](#writable-signal-variants) — `mutable`, `derived`, `store` / `mutableStore`, `forkStore`, `toWritable`
- [Timing & propagation](#timing--propagation) — `debounced`, `throttled`, `until`
- [Reactive collections](#reactive-collections) — `indexArray`, `keyArray`, `mapObject`
- [Effects](#effects) — `nestedEffect`
- [Concurrency & transitions](#concurrency--transitions) — `keepPrevious`, keep-alive (`MmActivity`), `pausable*`, Suspense (`mm-suspense`), `startTransition` / `startTransaction`, `holdUntilReady`
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

Pass `vivify` on the key/index form to create a missing container when writing through a `null`/`undefined` source — instead of throwing (mutable / array) or dropping the write. Choose `'object'`, `'array'`, `'auto'` (an array for index keys, an object otherwise), or a `() => container` factory; it defaults to off.

```typescript
const user = signal<{ name: string } | null>(null);
derived(user, 'name', { vivify: 'object' }).set('Ada');
// user() === { name: 'Ada' }
```

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

**Autovivification (opt-in).** By default, a write through a `null`/`undefined` path is dropped. Pass `vivify` to create the missing intermediate containers instead:

```typescript
const form = store(
  { user: null as { address?: { city: string } } | null },
  { vivify: 'auto' },
);

form.user.address.city.set('NYC');
// form() === { user: { address: { city: 'NYC' } } }
```

Each level's shape is resolved from what's known: a value that is currently an object/array re-creates as that same shape (resolved per path and cached, so it survives the value later being nulled), while genuinely-unknown levels follow your option — `'auto'` (an array for index keys, an object otherwise), `'object'`, `'array'`, or a `() => container` factory. `false` (the default) keeps writes through `null` as no-ops. Adding a key that simply wasn't present on an existing object always works and needs no `vivify`.

Top-level array support isn't exposed yet — use `indexArray` / `keyArray` for those.

### `extend` (scoped overlay)

`store.extend(seed)` (on any store kind) creates a **scoped overlay** — a child store that **shares** the parent's signals for inherited keys (the same `WritableSignal`: writes go through to the parent and parent changes flow down) while keeping the seed and any new keys in a **local layer** that never propagates upward. No diffing, no syncing — local keys simply aren't wired to the parent.

```typescript
const app = store({ user: { name: 'Alice' }, theme: 'dark' });

const scope = app.extend({ draft: '' }); // inherits user + theme, adds a local draft

scope.user === app.user; // true — the same signal (shared, two-way)
scope.user.name.set('Bob'); // writes through to the parent
scope.draft.set('hello'); // local only — `app` never gains `draft`
scope(); // { user: { name: 'Bob' }, theme: 'dark', draft: 'hello' }
```

Resolution per key is **local → parent → local**: a seed key (or one set on the scope before it exists on the parent) is local and _shadows_ the parent — and keeps shadowing even if the parent later grows that key; a key that exists only on the parent writes through to it; a brand-new key lands locally. `scope()` is the merged view (local shadowing), and `Object.keys(scope)` / `key in scope` are the union of both layers. `extend` composes — `a.extend(x).extend(y)` chains parents.

The seed may also be a **signal** of the matching kind, so an existing (externally-owned, reactive) signal becomes the local layer:

```typescript
const draft = signal({ title: '' });
const scope = app.extend(draft); // writes to scope.title flow out to `draft`, and back in
```

A few release notes:

- The local layer is a plain store (vivify off). Inherited paths vivify when the _parent_ was created with `vivify`; to autovivify local keys, seed with a vivify-enabled store — `app.extend(store(seed, { vivify: 'auto' }))`.
- Reserved names — `extend`, `asReadonlyStore`, and the signal methods (`set` / `update` / `mutate` / `inline` / `asReadonly`) — shadow same-named data keys, as on any store.
- `scope.asReadonlyStore()` returns a read-only **snapshot view** of the merge (reactive reads, no writes); it does not share sub-store identity.

### `forkStore`

`forkStore(base)` creates an **isolated, writable overlay** on a base store. Writes stay _local_ to the fork (the base is untouched); paths the fork hasn't edited read through to the base. `commit()` flushes the fork's value onto the base; `discard()` drops the staged writes. Use it for drafts, edit-and-cancel dialogs, and optimistic branches — anywhere you want a throwaway, structurally-shared copy you can keep or roll back.

```typescript
import { store, forkStore } from '@mmstack/primitives';

const base = store({ user: { name: 'Alice', age: 30 }, theme: 'dark' });

const draft = forkStore(base);
draft.store.user.name.set('Bob'); // local only — base still reads 'Alice'
base.user.name(); // 'Alice'

draft.commit(); // flush the edits onto the base
base.user.name(); // 'Bob'
// draft.discard();    // …or throw the edits away
```

The fork is a full store (`draft.store.user.name(...)`, `extend`, deep reads/writes — everything `store` gives you). It's built on `linkedSignal`: it holds local writes until the **base changes underneath it**, then runs a `strategy` to reconcile:

- **`'fine'`** (default for immutable stores) — per-path 3-way merge: keep the paths the fork edited, take the base's live values for the paths it didn't. Survives concurrent base changes. Relies on copy-on-write reference identity, so it's **unsupported on a mutable base** (in-place mutation defeats it — `fork` warns and falls back to `'coarse'`).
- **`'coarse'`** — any base change resets the whole fork. Cheapest; correct when the base is held for the fork's lifetime (e.g. a transition). The default for a mutable base.
- **a `ReconcileFn<T>`** — `(ancestor, mine, theirs) => merged`, for bring-your-own merge (array-by-id, Immer patches, CRDT-ish).

> Pass the same `vivify` / `noUnionLeaves` the base was created with — fork config isn't inherited (it's closed over inside the base), so mismatched config gives the fork different write semantics.

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

## Concurrency & transitions

The Angular signal-native equivalent of React's `<Suspense>`, `useTransition`, `useOptimistic`, or `<Activity>` — nor Vue's `<keep-alive>`. This is that vocabulary, expressed with Angular signals: keep a stale value on screen while the next one loads, hold a whole subtree until its data settles, pause a hidden tab's background work, freeze the display through a multi-resource update and reveal it in one frame. It's mostly built on `linkedSignal` (the one primitive that hands a computation its own previous output), so the value-holding pieces add no `effect()` and no zone churn.

The pieces compose, but each stands alone — reach for only what you need. `@mmstack/resource` and `@mmstack/router-core` plug into the same machinery (a resource opts into the nearest scope with its `register` option; `<mm-transition-outlet>` turns navigation into a transition).

### `keepPrevious`

The foundation of stale-while-revalidate. Wraps a signal so it **holds its last defined value whenever the source becomes `undefined`** — surfacing the previous result instead of flashing empty during a reload.

```typescript
import { keepPrevious } from '@mmstack/primitives';

const held = keepPrevious(resource.value); // drops to undefined mid-reload → keeps last value
```

If the source is writable, `set` / `update` / `asReadonly` (and `mutate` / `inline` / `from` for mutable / derived sources) are forwarded through, so it stays a drop-in replacement. `@mmstack/resource` uses it under the hood for its `keepPrevious` option.

### Keep-alive — `MmActivity` / `injectPaused` / `providePaused`

`*mmActivity="visible"` is the Angular analog of React's `<Activity>` / Vue's `<keep-alive>`: the wrapped subtree is **mounted once and kept**. When the condition is false it's hidden (`display:none`) and its change detection is paused — preserving state (scroll, inputs, a `<video>`'s position, loaded data); when true it's shown and CD resumes. It's never destroyed until the directive is.

```html
<section *mmActivity="tab() === 'editor'">
  <!-- heavy stateful editor — kept alive across tab switches -->
</section>
```

It also provides a **paused context** (= the negation of `visible`) to the subtree. Read it with `injectPaused()` (a `Signal<boolean>`, `true` while hidden); descendants use it to pause effect-driven work. CD-detach pauses _pull-based_ work for free (templates and the computeds they read), but **not** effects or RxJS timers — so polling and `effect()`s inside a hidden tab keep running unless you gate them on `injectPaused()` (or use the pausable primitives / a `PAUSED`-aware resource, which do it for you). `providePaused(signal)` sets up your own boundary; on the server nothing is ever paused (the full tree renders).

### Pausable primitives — `pausableSignal` / `pausableComputed` / `pausableEffect`

Signal/computed/effect that suspend their work while paused. By default they read the ambient paused context (so dropping them inside an `*mmActivity` subtree just works); pass `pause: () => boolean` (a `Signal<boolean>` counts) for an explicit source, or `pause: false` to opt out — which returns the **bare primitive with zero overhead** (no wrapper allocated).

```typescript
import {
  pausableSignal,
  pausableComputed,
  pausableEffect,
} from '@mmstack/primitives';

const scroll = pausableSignal(0); // while paused: reads hold; writes land and surface on resume
const total = pausableComputed(() => expensiveDerive(data())); // holds + does NOT recompute while paused
pausableEffect(() => poll(url())); // body skipped while paused; deps collapse so a change can't wake it
```

While paused each one **collapses its dependency set to just the pause predicate**, so an upstream change can't trigger work; on resume it re-tracks and re-runs / recomputes with the latest values. SSR never pauses.

### Suspense — `<mm-suspense>` and the transition scope

A **transition scope** is a per-boundary registry of resources whose async state a boundary coordinates. `<mm-suspense>` provides its own scope, so resources created in its subtree register into it automatically (via `@mmstack/resource`'s `register` option, or `registerResource(ref)` for a hand-rolled `ResourceRef`):

```html
<mm-suspense>
  <user-profile />
  <!-- its queries register here -->
  <span placeholder>Loading…</span>
  <!-- shown on FIRST load only -->
  <span busy>Updating…</span>
  <!-- shown during a reload, content stays mounted -->
</mm-suspense>
```

- **First load** (no value yet) → show the `[placeholder]`.
- **Reload** (a value is already held via `keepPrevious`) → keep the real content mounted, set `aria-busy`, and optionally show the `[busy]` slot — no flash back to the placeholder.

`type` selects what "not ready" means: `'value'` (default — suspend until a first value lands, then hold through reloads) or `'loading'` (strict — suspend on every in-flight load). When you register a resource you choose whether it `suspends` (blocks first paint — for code/data the subtree can't render without) or only drives the indicator (`suspends: false` — in-region data that should hold-stale, not blank the boundary).

> **Where the resource must live.** Registration resolves the scope _up_ the injector tree, and `<mm-suspense>` provides its scope to its **content children** — so a resource is captured only when it's created _inside_ the boundary (e.g. a component projected between the tags). A query declared on the component that _renders_ `<mm-suspense>` sits above it and won't be seen.

**Single-component variant.** When you'd rather keep the boundary and the resource on the **same** component, provide the scope on that component and use `<mm-unscoped-suspense>`, which **reads an ambient scope** instead of opening its own. Now the scope is an ancestor of both the resource and the boundary:

```typescript
import { Component } from '@angular/core';
import {
  UnscopedSuspenseBoundary,
  provideTransitionScope,
} from '@mmstack/primitives';
import { queryResource } from '@mmstack/resource';

@Component({
  selector: 'user-profile',
  imports: [UnscopedSuspenseBoundary],
  providers: [provideTransitionScope()], // the scope lives on THIS component…
  template: `
    <mm-unscoped-suspense>
      <span placeholder>Loading…</span>
      {{ user.value()?.name }}
    </mm-unscoped-suspense>
  `,
})
export class UserProfile {
  // …so this query registers into it, and the boundary below reads the same scope.
  readonly user = queryResource<User>(() => '/api/users/me', {
    register: { suspends: true },
  });
}
```

This is also the pattern for coordinating resources registered _above_ a boundary (e.g. an app-builder page whose connectors register at a higher injector): the outer `provideTransitionScope()` is the shared scope, and any number of `<mm-unscoped-suspense>` boundaries observe it.

### `injectStartTransition`

The analog of React's `useTransition`. `startTransition(fn)` runs your state mutations (which commit immediately); any resource that reloads as a result **holds its value and reveals together once everything settles** — so a multi-resource update lands as one consistent frame instead of a torn mix of new and stale. The returned handle gives you a unified `pending` signal and a `done` promise for imperative coordination (disable a button, await completion).

```typescript
const startTransition = injectStartTransition();

const t = startTransition(() => filters.set(next)); // queries refetch, view holds stale meanwhile
button.disabled = t.pending();
await t.done; // resolves once everything has settled
```

### `injectStartTransaction`

A transactional generalization of the above. `startTransaction(fn)` **holds the display** at its pre-transaction value while the transaction is in flight, records the writes in an undo log, then either commits on settle or rolls them back via `abort()`. The writes land on _live_ state immediately (so derived signals and connector requests see the new values and refetch) — only the _display_ is frozen, then revealed atomically when everything settles.

```typescript
const startTransaction = injectStartTransaction();

const t = startTransaction(() => applyBulkEdit()); // live state updates; the displayed grid stays put
// later: t.abort()  → roll the writes back and release the hold
await t.done; // committed, display revealed in one frame
```

### `holdUntilReady`

The **structural** counterpart to `keepPrevious`: where that holds a _value_ through a reload, this holds a _structure_ through a swap. Given a `target` signal and a `ready` predicate, it keeps yielding the previous value until `ready()` is true, then swaps to the current target. Mount the incoming structure off to the side so its resources can settle and flip `ready`, keep showing the held one meanwhile, and let the old one go once `ready` releases the swap. (`@mmstack/router-core`'s `<mm-transition-outlet>` is this pattern applied to routes.)

```typescript
import { holdUntilReady } from '@mmstack/primitives';

const shown = holdUntilReady(targetView, () => !scope.pending());
```

### Putting it together

A filterable list that suspends on first load, holds its rows through every filter change, and never flashes empty — combining the Suspense boundary, `keepPrevious`, and a transition. The data comes from [`@mmstack/resource`](https://www.npmjs.com/package/@mmstack/resource), whose `register` option drops a query into the nearest scope.

The list lives **inside** the boundary (so its query and `startTransition` resolve the boundary's scope); the boundary itself is a thin wrapper above it:

```typescript
import { Component, signal } from '@angular/core';
import { SuspenseBoundary, injectStartTransition } from '@mmstack/primitives';
import { queryResource } from '@mmstack/resource';

@Component({
  selector: 'user-list',
  template: `
    <input [value]="search()" (input)="filter($any($event.target).value)" />
    <ul>
      @for (u of users.value() ?? []; track u.id) {
        <li>{{ u.name }}</li>
      }
    </ul>
  `,
})
export class UserList {
  private readonly startTransition = injectStartTransition();
  protected readonly search = signal('');

  // `register: { suspends: true }` → this query blocks the boundary's first paint.
  // `keepPrevious` holds the rows through every refetch, so a filter change never
  // re-suspends — it just flips the boundary to its [busy] state.
  protected readonly users = queryResource<User[]>(
    () => ({ url: '/api/users', params: { q: this.search() } }),
    { register: { suspends: true }, keepPrevious: true },
  );

  protected filter(q: string) {
    // One pending/done for the whole update (await it, disable a control…).
    // With several registered resources, they hold and reveal together — one frame.
    this.startTransition(() => this.search.set(q));
  }
}

@Component({
  selector: 'users-page',
  imports: [SuspenseBoundary, UserList],
  template: `
    <mm-suspense>
      <!-- genuine first load -->
      <span placeholder>Loading users…</span>
      <!-- a filter change: rows stay, just flagged busy -->
      <span busy>Updating…</span>
      <user-list />
    </mm-suspense>
  `,
})
export class UsersPage {}
```

What each layer does here:

- **first load** → `<mm-suspense>` shows `Loading users…` (the registered query has no value yet, and it `suspends`);
- **a filter change** → `keepPrevious` holds the current rows, the boundary sets `aria-busy` and reveals the `[busy]` slot, and `startTransition` hands you one `pending` / `done` for the operation;
- nothing ever flashes empty between states.

Scale the same machinery outward:

- wrap the page in **`<mm-transition-outlet>`** ([`@mmstack/router-core`](https://www.npmjs.com/package/@mmstack/router-core)) and navigation gets the same hold-and-swap — the old route stays until the incoming route's registered resources settle;
- put a heavy panel behind **`*mmActivity`** to keep it alive across tab switches, and its `pausable*` / `PAUSED`-aware resources go quiet while it's hidden;
- need an edit-and-cancel form over that data? **`forkStore`** gives you the throwaway draft.

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
