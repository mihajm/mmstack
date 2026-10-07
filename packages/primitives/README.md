# @mmstack/primitives

**Signal-native utilities for Angular — debounce, throttle, two-way derivations, deep stores, undo/redo, sensors, and more.**

[![npm version](https://badge.fury.io/js/%40mmstack%2Fprimitives.svg)](https://badge.fury.io/js/%40mmstack%2Fprimitives)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/primitives/LICENSE)

`@mmstack/primitives` is a low-level toolbox of Angular Signal primitives. Every value-producing helper is a pure derivation — no `effect()`, no RxJS bridges, no zone churn — so you can compose them freely inside `computed()` graphs without worrying about side-effect lifetimes. Effect-shaped helpers (`tabSync`, `nestedEffect`, sensors) clean up via `DestroyRef`.

## Install

```bash
npm install @mmstack/primitives
```

Everything that is not a directive or component is also exported from `@mmstack/primitives/core`. That entry has no Angular templates, so it loads in plain Node without the Angular compiler or linker. Reach for it in a worker, a relay, an agent process or any other headless consumer; `@mmstack/mesh` and `@mmstack/worker/host` already do. The root entry re-exports all of it, so browser code keeps importing `@mmstack/primitives`.

## Contents

- [Writable signal variants](#writable-signal-variants) — `mutable`, `derived`, `store` / `mutableStore`, `forkStore`, `toWritable`
- [Timing & propagation](#timing--propagation) — `debounced`, `throttled`, `until`
- [Reactive collections](#reactive-collections) — `indexArray`, `keyArray`, `mapObject`, `projection`
- [Effects](#effects) — `nestedEffect`
- [Concurrency & transitions](#concurrency--transitions) — `keepPrevious`, keep-alive (`MmActivity`), `pausable*` / `providePausableOptions`, Suspense & the census (`mm-suspense`, error slots, `mmRetryFailed`, `*mmSuspenseError`, retry rounds), hold-and-swap (`*mmTransition`), per-element morphs (`mmViewTransitionName`), async derivations (`latest` / `use` / `useAll`), `deferredValue`, `startTransition` / `startTransaction`, optimistic writes (`guessable`, `optimistic`, `optimisticStore`), `holdUntilReady`
- [History & persistence](#history--persistence) — `withHistory`, `storeHistory`, `stored`, `persistedStore`, `tabSync`, `opLog`
- [Sync & convergence](#sync--convergence) — `opSync`, `tabSync(store)`, merge policies (`lww`, `mergeThree`, `keyedArray`, `preserve`), `Conflicted`, keyed containers (`keyedContainer`, `wrappedContainer`, `orderedEntries`, `posBetween`), `rebaseOps`, `policyStrategy`, `syncedFork`
- [Async state values & sentinels](#async-state-values--sentinels) — `loading` / `error` / `done`, `joined` / `settle`, precedence & `joinAbsorbers`, strict sentinels, the `/algebra` kit
- [Observability](#observability) — `provideConcurrencyInstrumentation`, `perfCustomTracks`, failure / retry / dismiss hooks
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

**Union leaves (perf opt-in).** `noUnionLeaves: true` promises no node ever flips between a leaf and a sub-store, so each node's leaf-ness is resolved once on first access and cached instead of staying reactive. Off by default — leave it off if a value can switch between a primitive and an object/array.

**Unions are fully supported by default.** A node may flip between array ↔ record ↔ primitive ↔ `null` freely: routing (`keys`/iteration/prototype) follows the live kind, and a child signal you grabbed **before** a flip stays correct after it — reads resolve against the new shape (`undefined` through a `null` parent, no throw) and writes copy by the container's live shape, so writing through a pre-flip child never turns an array into a plain object.

> Reserved keys: `set`, `update`, `mutate`, `inline`, `asReadonly` (and `extend`, until its removal next minor) resolve to the signal's own methods, so record keys with those names aren't reachable as child stores — read them off the value (`s().set`) instead.

### `extendStore` (scoped overlay)

`extendStore(store, seed)` (on any store kind) creates a **scoped overlay** — a child store that **shares** the parent's signals for inherited keys (the same `WritableSignal`: writes go through to the parent and parent changes flow down) while keeping the seed and any new keys in a **local layer** that never propagates upward. No diffing, no syncing — local keys simply aren't wired to the parent.

```typescript
import { extendStore, store } from '@mmstack/primitives';

const app = store({ user: { name: 'Alice' }, theme: 'dark' });

const scope = extendStore(app, { draft: '' }); // inherits user + theme, adds a local draft

scope.user === app.user; // true — the same signal (shared, two-way)
scope.user.name.set('Bob'); // writes through to the parent
scope.draft.set('hello'); // local only — `app` never gains `draft`
scope(); // { user: { name: 'Bob' }, theme: 'dark', draft: 'hello' }
```

Resolution per key is **local → parent → local**: a seed key (or one set on the scope before it exists on the parent) is local and _shadows_ the parent — and keeps shadowing even if the parent later grows that key; a key that exists only on the parent writes through to it; a brand-new key lands locally. `scope()` is the merged view (local shadowing), and `Object.keys(scope)` / `key in scope` are the union of both layers. It composes — `extendStore(extendStore(app, x), y)` chains parents.

The seed may also be a **signal** of the matching kind, so an existing (externally-owned, reactive) signal becomes the local layer:

```typescript
const draft = signal({ title: '' });
const scope = extendStore(app, draft); // writes to scope.title flow out to `draft`, and back in
```

A few release notes:

- The scope inherits the parent's config (`vivify` / `noUnionLeaves`) and its injector-scoped proxy cache, so **both** inherited and local paths vivify when the parent was created with `vivify`. `extendStore` doesn't accept `vivify` / `noUnionLeaves` — they always come from the parent.
- Reserved names — `asReadonlyStore` and the signal methods (`set` / `update` / `mutate` / `inline` / `asReadonly`) — shadow same-named data keys, as on any store.
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

The fork is a full store (`draft.store.user.name(...)`, `extendStore`, deep reads/writes — everything `store` gives you). It's built on `linkedSignal`: it holds local writes until the **base changes underneath it**, then runs a `strategy` to reconcile:

- **`'fine'`** (default for immutable stores) — per-path 3-way merge: keep the paths the fork edited, take the base's live values for the paths it didn't. Survives concurrent base changes. Relies on copy-on-write reference identity, so it's **unsupported on a mutable base** (in-place mutation defeats it — `fork` warns and falls back to `'coarse'`).
- **`'coarse'`** — any base change resets the whole fork. Cheapest; correct when the base is held for the fork's lifetime (e.g. a transition). The default for a mutable base.
- **a `ReconcileFn<T>`** — `(ancestor, mine, theirs) => merged`, for bring-your-own merge (array-by-id, Immer patches, CRDT-ish).

> The fork inherits the base's `vivify` / `noUnionLeaves` and its injector-scoped proxy cache automatically, so its write semantics match the base. Pass them explicitly only to override (advanced).

When the base is a synced store, a fork is also how an agent proposes a change for review. Wire it with `syncedFork(sync, base)` (or `mesh.fork()` on a meshed store) so the commit cites what the fork observed: an edit that lands mid-review stays a concurrent value the merge policy decides, never silently overwritten by the approval. The agent writes to the fork, `ops()` is the staged change to render for a person, and `commit()` emits the approved change. See the `@mmstack/mesh` README for the pattern.

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

### `projection`

A derived **store**, the store-shaped counterpart to `computed`. Where `derived` slices one value out of a source and `indexArray` / `keyArray` map a list, `projection` derives a whole store subtree from a computation. `fn` receives a mutable draft seeded with the current value and either mutates it or returns new data; the result is reconciled against the previous value so unchanged object subtrees keep their reference and keyed array items keep their identity across recomputes. Reading through the returned store is per-leaf, so a `computed` over one field only recomputes when that field actually changes, even though the whole projection re-ran.

```typescript
import { projection } from '@mmstack/primitives';

const users = signal<User[]>([]);

// return form: derive a filtered collection, reconciled by id
const active = projection<User[]>(() => users().filter((u) => u.active), [], {
  key: 'id',
});

// mutate form: update fields on the draft
const summary = projection<{ total: number; active: number }>(
  (draft) => {
    draft.total = users().length;
    draft.active = users().filter((u) => u.active).length;
  },
  { total: 0, active: 0 },
);
```

Recompute is pull-based, exactly like `computed`: memoized, re-run on the first read after a dependency changes, coherent immediately after a write (no waiting on an effect flush), and skipped entirely while nobody reads. `fn` must be pure since it runs inside the reactive computation. Prefer `computed` for a plain value, and reach for `projection` when you want the per-property tracking of a store on top of a derivation. The standalone `reconcile(prev, next, key)` is exported too, for producing a reference-stable value by hand. Values must be structured-clonable (the draft is a clone of the current value). With an explicit store context (`createStoreContext()`) a projection is injector-free, so it also runs on a worker host.

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
const rows = keepPrevious(resource.value, { fallback: [] }); // [] only until the first value lands
```

`fallback` is yielded only while nothing has ever been defined; after the first defined value the previous value covers every gap, never the fallback. Like any linked signal the hold is lazy: it carries a value it has computed with, so place it over the value your readers read — reading is what feeds it. `@mmstack/resource` does exactly that for its `keepPrevious` option.

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

#### `providePausableOptions`

Sets an app-wide default pause source for every pausable-aware primitive — the `pausable*` family above plus the opt-in integrations (`stored`, `chunked`). A call-site `pause` always wins; this only fills in when the call didn't specify one. Use it to make everything honour the ambient `*mmActivity` boundary from one place:

```typescript
import { providePausableOptions } from '@mmstack/primitives';

// e.g. in app.config.ts
providers: [providePausableOptions({ pause: true })];
```

With this provided, `stored(...)` / `chunked(...)` (off by default) start reading the ambient paused context; pass `pause: false` at an individual call site to opt that one back out.

### Suspense & the census

`<mm-suspense>` shows a placeholder while the data its subtree needs is loading, the content once it is there, and an error slot when a load failed and there is nothing to show:

```html
<mm-suspense>
  <user-profile />
  <!-- its queries register here -->
  <span placeholder>Loading…</span>
  <!-- first load only -->
  <span busy>Updating…</span>
  <!-- during a reload; content stays mounted -->
  <p error>Could not load the profile. <button mmRetryFailed>Retry</button></p>
  <!-- failed, nothing to show -->
</mm-suspense>
```

**Boundary tracking (the census).** The boundary provides a transition scope that coordinates all async tasks registered inside its subtree. Each registered task (a query, mutation, or `latest()` derivation) reports its status through a unified contract:

- `readiness`: whether it blocks the boundary's first paint (`register: 'suspend'`).
- `pending`: whether it currently has no content to display.
- `inFlight`: whether a network request is currently active (drives `aria-busy` and the `[busy]` slot).
- `failure`: any error that occurred.
- `retry`: a function to re-trigger the load.

Anything async registers cleanly:

- **Resources.** `@mmstack/resource`'s `register: 'suspend' | 'indicator'` option, or `registerResource(ref, { suspends, displayName })` for any `ResourceRef`. The scope adapts the ref: `pending` means "suspends, has no content, has not failed", `inFlight` is `isLoading()`, `failure` follows `status() === 'error'` and carries the error's `message`, and `retry` calls the ref's `reload()`.
- **`latest()` derivations.** The same `register: 'indicator' | 'suspend'` option and adapter.
- **Direct members.** `censusResource({ site, displayName, ...resourceOptions })` is an Angular `resource` that joins the nearest boundary's tracking automatically. `scope.census.register(member)` takes any custom task, and `scope.census.enroll(descriptor)` returns a handle you drive yourself (`started(generation)` / `settled(generation, outcome)`) for external asynchronous work.

**Boundary state resolution.** `scope.census.foldState()` determines the aggregate boundary state:

- `pending`: at least one readiness member has no content yet (the boundary shows the `[placeholder]`).
- `error`: a readiness member failed with nothing to show (the boundary displays the `[error]` slot).
- `idle`: all required data is ready.

`suspended('value')`, the boundary's default `type`, stays in placeholder mode while the state is `pending`, and leaves it once data arrives or an error occurs. `suspended('loading')` (`type="loading"`) is true whenever any suspending registration has a request in flight, even during background reloads. Meanwhile, `scope.pending()` monitors overall network activity across all registrations to drive `aria-busy` and the `[busy]` indicator.

**`failed` vs `errored`.** Two different questions:

- `scope.failed()`: is something failing with nothing to show? True when the fold is `error` and a failing suspending registration has no content, or when a failing member was registered directly (a direct member has no content reading, so its failure counts as empty).
- `scope.errored()`: which members are failing right now, content or not? A `keepPrevious` query whose background reload failed still holds its last value (`hasContent()` stays true), so `failed()` stays false, the rows stay on screen, and the failure appears in `errored()` as `{ member, failure }` with `failure.displayName` and `failure.message`.

The boundary checks failure before suspense. When `failed()`, the `[error]` slot replaces both placeholder and content; its default content is one line, `Failed to load.`. Otherwise the placeholder or the content renders as above, and while `errored()` is not empty the optional `[failed]` slot renders beside the content and the host carries a `data-failed` attribute (`mm-suspense[data-failed]` in CSS).

**Error UI.** Projected content cannot receive template context, so error content reaches the failures through DI: anything inside the boundary that calls `injectTransitionScope()` gets this boundary's scope. Two directives wrap that. `mmRetryFailed` calls `retryAll()` on click (the example at the top). `*mmSuspenseError` renders its template while `errored()` is not empty, with the context keys `$implicit` (the entries), `retry` (`retryAll()`, returns the round), `dismiss(entry)` and `dismissAll()`:

```html
<mm-suspense>
  <ul error *mmSuspenseError="let entries; retry as retry">
    @for (e of entries; track e.member.id) {
    <li>{{ e.failure.displayName }}: {{ e.failure.message }}</li>
    }
    <li><button (click)="retry()">Retry</button></li>
  </ul>
  <orders-table />
</mm-suspense>
```

A structural directive on an element that carries `error` or `failed` projects into that slot. Give the failure a name with `registerResource(ref, { suspends: true, displayName: 'orders' })`; a registration made through the resource `register` option takes the resource's `displayName` option and is called `'resource'` without one.

**Retry rounds.** `scope.retryAll()` and `scope.retry(id)` each run one round: every member that can retry and is not already in flight runs again, once. The round returns `{ dispatched, settled() }`: how many members it re-ran, and a promise for when those runs finish. Each member counts its runs as generations, and a round waits only on the generation it started, so a later round that re-runs the same member takes that wait over. A duplicated retry cannot be constructed: a round skips any member already in flight, so a second click while the first round is still loading dispatches nothing (`dispatched: 0`). A `@mmstack/resource` registration (query, manual, infinite) retries through its `reload()`.

**Dismissal.** `dismiss(entry)` hides one entry from `errored()` until that member fails again; `dismissAll()` hides every entry it can. Dismissal is keyed to the failure's generation, so the member's next failure shows. Only a member without a retry can be dismissed (a retryable failure is meant to be retried), and only a failure that carries a generation, which in practice means an enrolled facade or a failed mutation ([below](#mutations-in-the-census)). For any other resource registration `dismiss` does nothing. `scope.failures()` lists every failure and ignores dismissal.

**Settlement and the deadline.** `await scope.settled()` resolves once the fold has left `pending` and the graph has drained: `'idle'` when everything settled cleanly, `'error'` when something failed. A member that never answers would hold its placeholder forever, so a scope can carry a backstop:

```typescript
providers: [provideTransitionScope({ deadline: { ms: 10_000 } })];
```

Each suspending member gets its own 10 s, counted from its own registration. A member still pending when its time runs out is declared failed with a message that names it (`orders did not settle within 10000ms …`), and the boundary shows its error slot. If the member settles later, the synthesized failure goes away; a failure of its own always wins over it. Indicator-only members are never armed: they cannot hold anything.

**Precedence.** When one suspending member is still loading and another has failed, the scope has to pick what to show. `'pending-first'`, the default, keeps the placeholder until every suspending member has settled, then shows the error slot if a failure is still there. `'error-first'` shows the error slot as soon as a failure leaves nothing to show, even while others load; a failure that does not blank (indicator-only, or content still held) never ends the placeholder while a suspending member has nothing to show. Why pending-first: with three members, one loading, one failed, one done, showing the failure at once means retrying it alone, and if the loading member then fails too the boundary shows a second error and needs a second round for one incident. Waiting for the loading member shows every failure together, and one `retryAll()` covers them. `<mm-suspense>` uses the default; for `'error-first'`, provide the scope yourself and read it with `<mm-unscoped-suspense>` (below):

```typescript
providers: [provideTransitionScope({ precedence: 'error-first' })];
```

**Angular's `@boundary`.** mmstack resources surface errors as values; `@boundary` is for rendering throws. A failed `@mmstack/resource` query never throws into the template: its `value()` does not throw (unlike a plain Angular `resource`), and neither does a `latest()`. A throwing opt-in is rejected for now. So the census sees the failure and `@boundary` sees nothing. A template that throws while rendering is the other way round. The two compose, with one rule: put `@boundary` inside the branch it guards (inside the `*mmTransition` template, inside the routed component), never around `*mmTransition` or `<mm-transition-outlet>`. On a throw `@boundary` removes its whole block, and around a swap primitive that block holds both the outgoing and the incoming view. `provideViewErrorTelemetry()` from `@mmstack/telemetry-core` records each throw a `@boundary` catches as a `VIEW_ERROR` finding (the throwing component and the boundary's component) and passes the error on to your `ErrorHandler`.

`$reset()` clears the boundary's error and renders the block again from the same inputs; it fetches nothing. When the throw came from data owned outside the block, reload that data in the same handler:

```html
@boundary {
<order-chart [orders]="orders.value()" />
} @error {
<p>
  The chart failed. <button (click)="orders.reload(); $reset()">Retry</button>
</p>
}
```

`$reset()` re-renders at once, before the reload lands, and a reloading resource still holds the value that threw. Guard the block on `orders.isLoading()` (or render only once it is not loading), or the re-render throws on the stale data again.

`@boundary` does not catch everything. Errors in event listeners, root effects, `afterRender` callbacks, promises and `@defer` loads go to the `ErrorHandler`, as does a view effect that runs while its view is only traversed. Projected content belongs to the template that declares it, so a `@boundary` around `<ng-content>` does not cover it.

> **Where the resource must live.** Registration resolves the scope _up_ the injector tree, and `<mm-suspense>` provides its scope to its **content children**, so a resource is captured only when it is created _inside_ the boundary (for example in a component projected between the tags). A query declared on the component that _renders_ `<mm-suspense>` sits above it and is not seen.

**Single-component variant.** To keep the boundary and the resource on the **same** component, provide the scope on that component and use `<mm-unscoped-suspense>`, which reads an ambient scope instead of opening its own:

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
    register: 'suspend',
  });
}
```

The same pattern coordinates resources registered _above_ a boundary: the outer `provideTransitionScope()` is the shared scope, and any number of `<mm-unscoped-suspense>` boundaries observe it.

**Forwarding scope (advanced).** `provideForwardingTransitionScope()` provides a scope that can be re-pointed at another target at runtime with `setTarget(scope | null)`. Reads follow the current target, while `add` / `remove` (and direct census members) stay with the target they registered under, so re-pointing never strands a registration. It is the building block for a router outlet that points at the incoming route's own scope (`getTransitionScope(injector)` reads it).

**Cancellation, `scope.abortPending()`.** View-scoped work dies with its view: a superseded transition destroys the hidden incoming view, which aborts its loads, and an aborted response never settles into `@mmstack/resource`'s cache. For resources registered in a scope that _outlives_ the transition, `abortPending()` calls `abort()` on every in-flight registration that has it (queries do; mutations do not, a POST cannot be unsent) and returns how many it aborted. A shared resource aborts for all its readers, so use it when an interaction makes the pending work pointless. Only I/O is cancellable; no framework can preempt a running synchronous computation.

**SSR.** On the server a scope holds an Angular `PendingTask` while it has loads in flight, so serialization waits and custom (non-HTTP) loaders render settled. The `provide*TransitionScope()` factories wire this; call `bridgeScopeToPendingTasks(scope, injector)` yourself only for a scope from `createTransitionScope()`. Browser stability is not tied to loads.

### Mutations in the census

A mutation registered with `register: 'indicator'` is a member of its boundary that never holds first paint. While it runs it drives `pending()` (`aria-busy`, the `[busy]` slot) and `suspended()` does not change. When it fails, the failure stays in `errored()` after the mutation has returned to idle, until it is dismissed (`dismiss(entry)`, `dismissAll()`, or the `dismiss` in `*mmSuspenseError`'s context) or the next `mutate()` starts. `retryAll()` skips it, because a write is not assumed to be safe to send twice. The ref carries the same failure as `lastFailure()`.

`register: 'suspend'` on a mutation behaves as `'indicator'` and warns once in dev mode. To hold the UI while a save runs, use a transaction (`injectStartTransaction`), not suspense.

### In-place error boundary: `*mmErrored`

`*mmErrored` catches a render error the way `@boundary` does, but keeps what it guards. The content renders from the directive's template. When rendering it throws, the content view is detached and hidden, its components and their state stay alive, and the fallback template renders in its place with the error and a `retry`:

```html
<form *mmErrored="failed; name: 'profile form'">
  <profile-fields />
</form>
<ng-template #failed let-error let-retry="retry">
  <p>{{ error.message }} <button (click)="retry()">Retry</button></p>
</ng-template>
```

`retry()` re-attaches the kept view and renders it again, synchronously, with the same instances, so a half-filled form keeps what the user typed. A `computed` that cached the throw throws again until one of its dependencies changes, so a retry before the fix lands on the fallback again and nothing broken is shown. The view that threw renders on retry even when it is an OnPush component with nothing changed. The longhand is `<ng-template [mmErrored]="failed">`; without a fallback the content is only hidden.

**When which.** `@boundary` destroys its block on a throw and builds it again on `$reset()`. Use it for widgets with nothing worth keeping. Use `*mmErrored` when the subtree holds state the user would lose: a form mid-edit, a scrolled list, an editor.

**Hidden, not frozen.** The content is hidden while it is faulted (element roots get `display: none`, text roots are blanked) because its DOM is whatever the throwing pass wrote before the throw: some bindings new, some old. Prefer an element root.

**Creation throws.** A throw while the content itself is first built (a constructor, a DOM instruction) leaves no view to keep, so the fallback shows and `retry()` builds the content again, with new instances. Anything the half-built view registered outside itself before the throw stays registered, as with `@boundary`.

**Rebuilding.** `retry({ rebuild: true })` destroys the faulted content and builds it again from the template, the way `@boundary` resets, so the instances and their state are new. The fallback's `retry` takes the same option: `(click)="retry({ rebuild: true })"`. Use the plain `retry()` for faults that pass, such as a failed load or a value fixed since. Use a rebuild when the kept state is itself what throws, so every plain retry would land on the fallback again. A rebuild also brings back a block branch left empty by the limit below. The census member stays until the rebuilt view renders clean, and a fault in the rebuilt view is caught and reported like any other.

**Reporting and the census.** Angular does not report errors a custom interceptor catches, so the directive reports each catch to your `ErrorHandler` once (`onViewError` when it has one, otherwise `handleError`). Inside a transition scope each fault also joins the scope's census as a member that does not block first paint: `errored()` lists it under the `name` (default `'view'`), `failed()` stays false, `retryAll()` retries it, and the member leaves once a retry renders clean.

**Nesting.** The nearest boundary catches: an inner `@boundary` or `*mmErrored` wins, and a fallback that throws goes to the next boundary out. Inside `*mmTransition`, put the boundary in the branch template. A faulting incoming branch shows its fallback inside the branch and still commits.

**Limits.** Init hooks (`ngOnInit` and friends) that already ran, or started and threw, do not run again on retry. A block (`@if`, `@for`, `@switch`) whose new branch threw while being built has already taken its new condition, so after a retry that branch stays empty until the condition changes again. Errors in event listeners, root effects, `afterRender` callbacks, promises and `@defer` loads are not caught, and a view effect that runs while its view is only traversed (not refreshed) throws past this boundary to the nearest boundary further up whose view is refreshing. Compare with Solid 2.0's `<Errored>`, whose reset re-runs the readers that threw rather than rebuilding the tree; that is the rule `retry()` follows.

### Hold-and-swap — `*mmTransition`

The transition itself, for any branch change — tabs, wizard steps, master-detail. Suspense decides placeholder-vs-content _within_ a branch, but it can't stop an `@switch` from unmounting the old branch the instant the value flips. `*mmTransition` holds it: when the bound value changes, the **old view stays mounted and visible** (keeping its old value) while the **new view mounts hidden with its own transition scope**; resources created in the incoming subtree register there just by existing, and once they've gone in flight and settled the views swap in one frame.

```html
<div *mmTransition="selectedTab(); let tab">
  @switch (tab) { @case ('overview') {
  <overview-pane />
  } @case ('activity') {
  <activity-pane />
  } }
</div>
```

The first render is immediate (nothing to hold). An interrupting change mid-hold destroys the half-ready hidden view and re-targets — the stable view stays visible until the newest branch settles. A branch that loads nothing swaps right after its first render, and per-view scopes mean the outgoing branch's background work can never delay the swap. A transaction that holds the incoming branch's scope keeps the swap back until it releases, and the branch commits once. That includes a transaction on the page around it, since a hold on a scope also holds the scopes provided inside it, so a tab switched mid-save commits with the saved values, together with the rest of the page. `immediate: true` skips holding; `viewTransition: true` wraps the swap in `document.startViewTransition` (feature detected). This is `@mmstack/router-core`'s `<mm-transition-outlet>` without the router — same semantics, any signal as the trigger.

### Reveal order with `<mm-reveal>`

Sibling boundaries settle in whatever order their data lands, so a dashboard can fill in bottom-up. `<mm-reveal>` schedules when each of its boundaries shows its content:

```html
<mm-reveal order="forwards" collapsed>
  <mm-suspense><app-profile /></mm-suspense>
  <mm-suspense><app-feed /></mm-suspense>
  <mm-suspense><app-suggestions /></mm-suspense>
</mm-reveal>
```

With `order="forwards"` (the default) a boundary shows its content once it is ready and every boundary before it has shown. `"backwards"` is the mirror, and `"together"` shows them all in one frame once every one is ready. A boundary held back by an earlier one shows its placeholder; with `collapsed` it renders nothing, so only the next boundary in line shows a placeholder.

Failures follow `onError`. Under `'settled'` (the default) a failed boundary shows its error slot and the ones after it carry on. Under `'blocks'` it shows its error and holds the rest until a retry succeeds, for flows where the order means "this needs that first". Once a boundary has shown its content it stays shown, even if it suspends again later; its own placeholder or busy state takes over as usual.

Only the boundaries directly inside the reveal take part. A boundary nested inside one of them belongs to that boundary. Boundaries are ordered by where they are on the page, whether they come from `@if`, `@for` or a plain element, and the order follows them when they move. A boundary that leaves the page (an `@if` turned off, a cached route) stops holding the others and keeps whatever it already showed. One rendered elsewhere (a portal or overlay) orders by where it renders; provide `severReveal()` at the portal host to keep it out. Boundaries inside a shadow root and outside it can't be put in one order: while a reveal spans both, nothing new is shown. The reveal schedules display and nothing else: held content is created and loads as usual, and a reveal inside a held `*mmTransition` view does its ordering while hidden and shows up with the swap. Compare with Solid 2.0's `<Reveal>`, which this follows. A boundary's readiness counts only once it has rendered, so a state seen before its inputs are bound or its content has run can't show it early. Custom boundaries join through `injectRevealSlot()` from their directive or component (so the slot takes its host element's place in the order), call the slot's `mount()` from `ngAfterViewInit`, and provide `severReveal()` for their content. Driving `createRevealCoordinator()` over the DOM without `<mm-reveal>`? Pass each slot's host to `register()` and call `relayout()` after rendering. Until `mount()` is called the slot stays pending and holds the boundaries after it.

Boundaries that come from an `@for`? Give the reveal the same array and track function, and each boundary its row: `<mm-reveal [items]="rows()" [track]="byId">` with `<mm-suspense [item]="row">` inside the loop (`track` defaults to the row itself, like `@for`). Order and membership then come from the data: a moved row is seen at once, a row that leaves the array stops holding the others and keeps what it showed, and nothing is read from the DOM. A boundary with no `[item]`, or whose key is not in the array, is held and holds nothing (dev mode warns about a missing `[item]` and about duplicate keys). Without `[items]` the reveal orders by the page, as above.

### Per-element morphs — `mmViewTransitionName`

When a swap is wrapped in the View Transitions API (`viewTransition: true` above, or the outlet's equivalent), the browser cross-fades the whole boundary by default. Name an element on both sides and it **morphs** instead — the hero image glides from the list card into the detail header:

```html
<!-- outgoing (list) and incoming (detail) views both name it: -->
<img [mmViewTransitionName]="'hero-' + item().id" [src]="item().img" />
```

The directive binds `view-transition-name` reactively and normalizes the value to a valid CSS ident; `''`/`'none'` clears it (the conditional opt-out). It works with holds precisely because the incoming view is `display: none` while held — unboxed elements aren't captured, so the same name on both sides is legal at each capture point. One rule stays yours: a name must be unique among elements **visible** at capture time, so derive names from ids for anything that can repeat.

### Async derivations — `latest()` / `use()`

A `computed` over resources: `use(res)` reads a resource's value inside a `latest(fn)` computation and reports it to the derivation, so pending-ness propagates **by read**, with no per-site `isLoading` checks:

```typescript
import { latest, use } from '@mmstack/primitives';

const fullName = latest(() => {
  const u = use(user); // typed value, no undefined checks in here
  const org = use(orgFor(u)); // dependent (waterfall) resources compose too
  return `${u.name} @ ${org.name}`;
});

fullName(); // holds its previous value while anything it read is in flight
fullName.outcome(); // the value, or the loading / error sentinel this evaluation settled on
fullName.pending(); // the aggregate flight indicator
```

When a resource has nothing to show yet or has failed, `use()` throws its [sentinel](#async-state-values--sentinels) (`loading` or `error`) and the rest of the callback does not run this round. That is why the body needs no `undefined` handling. A resource that is idle with nothing to show (disabled, not started) throws `loading` too: from the derivation's point of view it is still waiting. The thrown value is an internal control-flow signal, so avoid broad `try/catch` blocks inside `latest()`; if you do catch, re-throw anything where `isAbsorbing(err)` is true. (For combining independent resources without thrown exceptions, prefer `joined()` described below). `latest` catches it and keeps the previous result: `fullName()` is the held value, `hasValue()` says whether there has ever been one, and the held value stays readable through an error (unlike a raw `ResourceRef`, it never throws).

**Two axes.** `outcome()` is the value plane: the result of the last evaluation, or the sentinel it stopped on. `pending()` (alias `isLoading()`) is activity: whether any resource the last evaluation read is `loading` / `reloading`. They are separate on purpose. A `keepPrevious` member that is reloading still has its old value to give, so `outcome()` is that value while `pending()` is true. `status()` composes the two: an `error` outcome is `'error'`; otherwise activity is `'reloading'` (a value is held) or `'loading'` (none yet); otherwise a value outcome is `'resolved'` and a waiting one is `'idle'`. `error()` is the cause behind an `error` outcome, else the first error among the resources it read.

**Several absorbers.** `use()` stops at the first absorber, so a plain sequential callback only ever meets one. `useAll(a, b, …)` reads several resources independently: every one is read and reported, and if any has nothing to show or failed it throws their ranked join.

```typescript
const card = latest(() => {
  const [u, org] = useAll(user, orgOf);
  return `${u.name} @ ${org.name}`;
});
```

`errors` decides what `outcome()` says when an evaluation read more than one absorber. `'first'` (the default) is the absorber the evaluation actually stopped at. `'aggregate'` is the ranked join over everything the evaluation read, under `precedence` (`'pending-first'` by default, `'error-first'` to invert). The options are a discriminated union, so `precedence` without `errors: 'aggregate'` is a compile error:

```typescript
const total = latest(() => use(a) + use(b), {
  errors: 'aggregate',
  precedence: 'pending-first',
});
```

`errors: 'aggregate'` changes the answer only when an evaluation reads past an absorber (`useAll`, or a callback that catches a `use()` throw and keeps reading); with plain sequential `use()` both modes agree, so reach for `useAll` when the reads are independent. `useAll` itself always joins, under `'pending-first'` unless the `latest` sets an aggregate `precedence`.

Results are status-bearing, so they **nest** (a `latest` read by `use` inside another passes its `outcome()` through) and register into transition scopes with the same `register: 'indicator' | 'suspend'` vocabulary as resources. `use()` accepts anything structurally resource-shaped: Angular `resource()` / `httpResource`, `@mmstack/resource` refs, or another `latest`. A source with an `outcome()` is read through it; any other is read through `outcomeOf(source)`, which derives the same answer from `status`, content, `value` and `error`.

Limit: the collector is a synchronous stack, so it covers derivations you own and nothing after an `await`. For a read in a template, see `*mmOutcome` below.

### Reading a resource in a template with `*mmOutcome`

A boundary learns about a resource when the resource registers in it. `*mmOutcome` lets a template read do the same. It takes the resource itself, renders its template with the value, and while the resource is loading or failed it joins the nearest boundary's census as a member of its own. A resource created above the boundary, where no registration can reach it, still holds the boundary once it is read inside:

```html
<mm-suspense>
  <span placeholder>Loading…</span>
  <h2 *mmOutcome="user; let u; error: failed; name: 'profile'">
    {{ u?.name }}
  </h2>
  <ng-template #failed let-error let-retry="retry">
    Could not load the profile. <button (click)="retry?.()">Retry</button>
  </ng-template>
</mm-suspense>
```

The template renders while `outcome()` is a value (`undefined` counts: nothing was requested). While it is `loading` the template is removed, the optional `loading` template renders instead, and the member is pending, so the boundary shows its placeholder. While it is `error` the optional `error` template renders with the error as `$implicit` and a `retry` that reloads the resource when it can; the member reports the failure under its `name` (`'resource'` without one), and the boundary blanks only when the resource has nothing to show. A `done` outcome renders nothing and is not pending. The member leaves when the directive is destroyed. A `latest()` works the same way, read through its `outcome()`.

Each directive is its own member. A resource that is also registered in the same boundary counts once there: one member in the fold, one entry in `errored()`, one reload per retry round. Registered in an outer boundary and read under an inner one, both boundaries hold, each in its own census.

Reach for `latest` where you would write `computed` over resources; reach for the directive where you would read a resource in a template.

**Three readings.** The value, the activity and the boundary answer different questions, and they can disagree on purpose. Take a registered `latest` that reads a user and their orders, after the orders request failed while the user reloads:

```typescript
const summary = latest(() => `${use(user).name}: ${use(orders).length} orders`);

summary.status(); // 'error': the last evaluation stopped at the failed orders
scope.pending(); // true: the user is still reloading
scope.suspended('value'); // false: the held summary stays on screen
```

`status()` and `outcome()` describe the result, `pending()` describes work in flight, and `suspended()` / `failed()` describe whether the boundary can show its content.

Limit: under `type="loading"` a boundary reads only its registrations, so a resource that is only read does not suspend it there.

### `deferredValue`

`useDeferredValue` for signals: holds its previous value when the source changes and catches up at lower priority — after the next paint by default — so an expensive subtree keyed off the deferred value never blocks the urgent update that caused the change:

```typescript
const query = signal('');
const deferredQuery = deferredValue(query);
const results = computed(() => expensiveFilter(items(), deferredQuery()));
// typing echoes instantly; the big list re-renders one beat later
// deferredQuery.pending() → true while behind (dim the stale list)
```

Rapid changes coalesce latest-wins (the expensive subtree never sees intermediate values), `pending` compares by **value** — a change reverted before catch-up isn't pending — and an equal catch-up never notifies consumers. `strategy: 'idle'` defers to `requestIdleCallback` instead; a function strategy is the custom-scheduler/test seam. On the server it's a synchronous pass-through (SSR renders once — deferral would just mean stale content). This is a scheduling tool, not an async one: for async work compose `latest()`; for coordinated reveals use a transition scope.

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
// later: t.abort()  → roll back the recorded writes and release the hold
await t.done; // committed, display revealed in one frame
```

Rollback covers recorded writes, and only those. The store records its root on the first write inside a transaction, and `derived`, `keepPrevious` and the pausable signals record the source they forward to. A plain signal of your own records through `transactional(sig)`, or by calling `activeTransaction()?.record(sig)` before the write. Nothing is intercepted: a write made any other way stays after `abort()`, and an unrecorded writer that re-lands the same value is invisible to the rollback. A `mutable()` is snapshotted when it is recorded, so an in-place write cannot reach the rollback point.

Every exit settles: a throwing body rolls back, and if the calling context is **destroyed
mid-flight** the hold is released (writes kept) and `done` resolves — a transaction can never
leave a surviving ancestor scope frozen.

Attribution is **per transaction**: a load already in flight when it starts is not adopted —
it can neither commit the transaction early nor block its settle. (The same applies to
`startTransition`.) A pre-existing flight re-triggered by the transaction's own writes counts
once it restarts, provided the resource keeps a `loads` counter: `@mmstack/resource` queries,
mutations and streams do, and `latest()` sums its members' counters. A load started inside the
transaction's body, or inside a `tx.enter(...)` slice, belongs to that transaction and to no
other. A load started anywhere else after the transaction began counts for every transaction
open at the time: it says "started since", not "caused by". A plain Angular `resource` has no
counter, so a load of it that restarts or settles and refires between two reads stays excluded.

**After an await.** Pass an async body and you get back `{ pending, done, abort }`, where `done`
resolves with how the transaction ended: `{ kind: 'completed' }`, `{ kind: 'aborted', reason }`
(`'abort'`, `'superseded'` or `'destroyed'`) or `{ kind: 'failed', error }`. It never rejects.
The hold lasts until the body's promise resolves, the loads attributed to the transaction drain
and every `tx.retain()` is released.

```typescript
const t = startTransaction(async (tx) => {
  draft.set(next); // before the first await: recorded as usual
  const saved = await api.save(next);
  tx.set(revision, saved.revision); // a write after an await, still the transaction's
});
const outcome = await t.done; // { kind: 'completed' } | { kind: 'aborted', ... } | { kind: 'failed', ... }
```

Code after an `await` runs outside the transaction. Write through it with `tx.set(sig, value)` or
`tx.update(sig, fn)`: the write is recorded wherever it happens, and a plain `signal()` is recorded
too, so `abort()` undoes it. `tx.enter(() => ...)` puts a whole synchronous block back in: writes and
loads started in the block are the transaction's. A plain `sig.set(...)` after an `await` still
lands and the display stays held, but `abort()` does not undo it. A load Angular
starts later in response to the slice's writes is attributed by time, like any load started while
the transaction is open. A rejected body rolls back and settles `failed`; `abort()` or destroying
the calling context rolls back and settles `aborted`. Once settled, `tx.set`, `tx.update`,
`tx.enter` and `tx.retain` throw and the body's later result is ignored, but nothing stops a leftover continuation from
writing a signal directly. A `startTransaction` called inside a slice joins the outer transaction:
its writes, its `abort()` and its `done` are the outer one's. There is no re-trigger policy here;
for latest-wins or a FIFO queue use `mutationResource`. Reject-while-running and parallel runs are
not provided.

A view that mounts while a transaction holds (an `@if` that opens mid-transaction, a branch
swapped in below the page) reads through `scope.hold` like the rest of the page. It shows each
recorded signal as it was before the first write since its scope's hold began, counting holds
inherited from enclosing scopes. Any transaction's write counts, in any scope, settled or not, so
the new view matches the held page and reveals with it when the hold ends, or keeps that value
after an abort. A hold on a scope also holds the scopes provided inside it (nested boundaries,
`*mmTransition` branches); their `pending` and census stay their own. The one exception is the
fallback scope a forwarding scope uses while it has no target: it cannot take part in an
observable hold. Anything else the view reads (an unrecorded signal, a derived value, a store
leaf) shows the live value.

The history this needs is reclaimed as holds end: once no held scope can read an entry any more,
it is dropped, even while other, unrelated holds keep overlapping. A scope that stays held keeps
every recorded entry since its hold began, since a view mounted there may still need it.

### Optimistic writes

A guess is a value shown before its truth is known. It is gone when its transaction settles, however it settles, so a failed save never leaves a phantom row behind. There are two tiers and no default: pick one per write.

**Live (in place).** `guessable(sig)` wraps a writable signal; `tx.guess(node, value)` lays a guess owned by the transaction. The live signal shows the guess, with an undo log over a truth shadow beneath it and a stamp on every write. Every reader sees the guess: templates, derived values, request functions. Use it when you expect the write to succeed almost always (a like toggle).

```typescript
const liked = guessable(signal(false));

const t = startTransaction(async (tx) => {
  tx.guess(liked, true); // everyone sees true now
  const saved = await api.like(postId);
  tx.set(liked, saved.liked); // the server's answer, recorded
});
```

Readers see the most recent open guess, else the truth. An authoritative write is a `set` or `update` on the guessable (from the body, a user, a refetch, another transaction) or a change of the wrapped signal itself, such as a `linkedSignal` recomputing after a refetch. A write from outside the transaction that guessed replaces every open guess, for good: undoing that write later brings back the truth beneath, never the guess. A write inside the transaction that laid a guess on that node (`tx.set`, or a write in `tx.enter`, typically the server's answer) resolves the guess instead: it records the truth as any write does, and the guess takes the written value until the transaction settles. So a held reader moves from the guess to the answer and never drops back to the value from before the transaction, while every other reader sees the answer at once. A resolved guess equals the truth beneath it, so a guess laid after it always shows over it. A plain `set` after an `await` (not `tx.set`, not inside `tx.enter`) is outside the transaction. Equal values count when written through the guessable, so a server confirming the guessed value is not mistaken for no change. A write made directly on the wrapped signal with an equal value is not seen. `update` applies to the truth, not to a guess on screen. Two transactions guessing the same node show the newer one's guess; when either settles the other's guess or the truth shows, never a settled guess.

The frozen frame is the truth beneath the guess. `scope.hold(node)` and `scope.commit(node)` read a visible guess live and freeze only the truth, so a hold opened over a guess never keeps showing it after it reverts. A derived value under `hold()` freezes what it computed, guess included; hold the guessable itself where that matters.

**Overlay (isolated).** `optimisticStore(base)` gives each transaction its own fork of a store, and `optimistic(sig)` does the same for a plain signal. Guesses go into `tx.overlay(view)`; only readers of the view see them. The base, and every request or derived value built on it, never sees a guess, and the fork is thrown away when the transaction settles, never written back. Use it for multi-field edits (modal forms, draft editors).

```typescript
const todos = store({ items: [] as Todo[] });
const shown = optimisticStore(todos); // read shown.store in the template

startTransaction(async (tx) => {
  tx.overlay(shown).items.update((xs) => [...xs, draft]); // only shown.store sees it
  await api.add(draft);
  tx.update(todos.items, (xs) => [...xs, draft]); // the truth, through the base
});
```

When the base moves while a fork is open, paths the fork did not change follow the base at once, and a path it did change keeps the guess until the fork is discarded. An array is one value, so a guessed list hides a refetch of that list until then; pass `optimisticStore(base, { reconcile })` (an array-by-id merge, say) to merge it in. A guess equal to the value it covers is no change. With several transactions open, the view folds their forks over the base in the order they opened, a later one winning a path both changed. `view.fork()` opens a fork you discard yourself.

A request built from a guessed value fires like any other request; if that is not wanted, have the request function return `undefined` while the input is provisional. `mutationResource({ optimistic })` in `@mmstack/resource` opens one of these transactions per mutation and settles it on the result. Compare with Solid 2.0's optimistic writes, whose revert-by-construction rule the live tier follows.

### `holdUntilReady`

The **structural** counterpart to `keepPrevious`: where that holds a _value_ through a reload, this holds a _structure_ through a swap. Given a `target` signal and a `ready` predicate, it keeps yielding the previous value until `ready()` is true, then swaps to the current target. Mount the incoming structure off to the side so its resources can settle and flip `ready`, keep showing the held one meanwhile, and let the old one go once `ready` releases the swap. (`@mmstack/router-core`'s `<mm-transition-outlet>` is this pattern applied to routes.)

```typescript
import { holdUntilReady } from '@mmstack/primitives';

const shown = holdUntilReady(targetView, () => !scope.pending());
```

### `heldEffect`

An `effect` that waits out a transition. While its gate is held, a change to anything it read does not run it; it only marks it stale. When the hold ends, a stale effect runs once with the latest values, so side effects see the settled state rather than every step on the way to it. With nothing held it is a plain `effect`.

```typescript
import { heldEffect } from '@mmstack/primitives';

heldEffect(() => analytics.track('cart', cart.total()));
```

The default gate is the nearest transition scope's `holding() || pending()`: held while a transaction holds the display or a load is in flight. Pass `scope` to read another scope, or `gate` for your own predicate. A held effect cannot tell one change from many, and a hold with no change in it runs nothing. `onCleanup` callbacks run right before the next run and on destroy; destroying a held effect runs nothing.

The limit: only effects are held. Template bindings belong to Angular's compiler and update as usual, so hold what the template shows with `*mmTransition` or the scope's `hold` / `commit`.

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

  // `register: 'suspend'` → this query blocks the boundary's first paint.
  // `keepPrevious` holds the rows through every refetch, so a filter change never
  // re-suspends — it just flips the boundary to its [busy] state.
  protected readonly users = queryResource<User[]>(
    () => ({ url: '/api/users', params: { q: this.search() } }),
    { register: 'suspend', keepPrevious: true },
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

### `opLog`

A minimal **operation log** over any object-shaped `WritableSignal` that honors the copy-on-write contract (stores qualify, and so do plain immutably-updated model signals): each tick's changes are recovered as one batch of path-level `set`/`delete` ops by a reference-identity-pruned diff — O(changed paths), from _outside_ the signal, zero cost when no log exists:

```typescript
import { opLog, store } from '@mmstack/primitives';

const state = store({ user: { name: 'Ann' }, items: [1, 2] });
const log = opLog(state);

log.subscribe((batch) => send(batch)); // lossless, ordered — sync/persistence feed
log.latest(); // Signal<OpBatch | null> — lossy sampling (devtools-style)

state.user.name.set('Bea');
// → { origin, version, ops: [{ kind: 'set', path: ['user','name'], next: 'Bea', prev: 'Ann' }] }

log.flush(); // synchronously emit any pending change now, instead of waiting for the tick. idempotent, no-op when clean.
log.apply(remoteBatch); // applies ops in ONE commit AND advances the diff baseline —
// so applying a remote batch emits no echo batch (sync loops terminate by construction)
invertBatch(batch); // prev-based inverse — undo is a data transform
```

Batching is per tick (two writes to one leaf in a tick emit one composed op), `prev` is always carried in-memory (structural sharing makes it free — wire serializers decide whether to keep it), arrays diff per-index at equal lengths and as whole-array ops on length change, and a `forkStore`'s `commit()` lands as a single batch — fork _is_ the transaction primitive. Mutable stores are unsupported (in-place mutation defeats ref-identity diffing; dev warn). This is the substrate for worker mirrors, tab/mesh sync, persistence journals, and undo — one protocol, many consumers.

An `opLog` can also run with no Angular injector, which is what lets the graph mirror into a Web Worker. Pass `driver: microtaskOpLogDriver()` to drive emission off the microtask queue instead of an `effect()`, and build the store with `createStoreContext()` (a self-contained proxy cache) so `store` and `opLog` work in a worker or a plain Node process. The pure helpers `applyOps(root, ops)` and `diffOps(prev, next)` apply and produce batches without owning a log. [`@mmstack/worker`](https://www.npmjs.com/package/@mmstack/worker) is built directly on these seams.

### `storeHistory`

Undo and redo for a store, over the op-log rather than value snapshots, so each entry costs only the diff. `undo()` applies one inverse batch; a new edit after an undo forks the timeline.

```typescript
import { store, storeHistory } from '@mmstack/primitives';

const doc = store({ title: 'Draft', body: '' });
const history = storeHistory(doc);

doc.title.set('Final');
history.undo(); // title back to 'Draft'
history.canRedo(); // Signal<boolean>

storeHistory(doc, { track: syncClient }); // collaborative: only your own writes are undoable
```

### `persistedStore`

Persists a whole store to an async backend (IndexedDB) and restores it on boot. It ships no IndexedDB code: you pass an `AsyncStore` adapter, which `idb-keyval` satisfies directly and a Dexie table satisfies with a few lines. Local durability, not sync (compose `tabSync` / `@mmstack/mesh` for that). Reads stay synchronous; because the backend is async, the store shows its initial value until the snapshot loads (`hydrated` is a signal you can gate on).

```typescript
import * as idbKeyval from 'idb-keyval';
import {
  persistedStore,
  providePersistedStoreOptions,
} from '@mmstack/primitives';

providePersistedStoreOptions({ store: idbKeyval }); // wire the backend once

const draft = persistedStore({ title: '', body: '' }, { key: 'draft' });
draft.store.title.set('Hi'); // persisted (debounced), restored on next load
draft.hydrated(); // Signal<boolean>
```

When the persisted shape changes between releases, pass `version` and a `migrate` hook. An older snapshot is brought forward on boot before it is adopted, then re-persisted in the new shape (a newer snapshot than the running build is left untouched). Boot is already async, so `migrate` can be async, so the migration ladder can be lazy-loaded.

```typescript
const profile = persistedStore(
  { first: '', last: '' },
  {
    key: 'profile',
    version: 2,
    migrate: async (data, from) =>
      (await import('./migrations')).run(data, from),
  },
);
```

`persistedStore` is `store()` + `persist()`. Reach for `persist(store, opt)` directly to add durability to a store you already have — one you also `meshSync`, or a worker-owned store's replica. Persistence is a reader over the op-log, so it composes with the other readers on the same store.

```typescript
import { store, persist } from '@mmstack/primitives';
import { meshSync } from '@mmstack/mesh';

const doc = store({ title: '', body: '' });
persist(doc, { key: 'draft', store: idbKeyval }); // durable to IndexedDB
meshSync(doc, { room: 'doc-42', writer, transport }); // and synced to peers
```

## Sync & convergence

The op-log is the substrate; these keep two copies of a store in agreement across a boundary (tabs, a worker, a network). `opSync` wires a store to a transport: local writes emit stamped envelopes, received envelopes fold in through a per-path last-writer-wins register map, ordered by a hybrid logical clock so any arrival order converges to the same state. `tabSync(store, { id })` is `opSync` over `BroadcastChannel` with a join handshake.

```typescript
import {
  store,
  tabSync,
  keyedArray,
  preserve,
  isConflicted,
} from '@mmstack/primitives';

const board = tabSync(store({ title: 'Board', todos: [] }), {
  id: 'board',
  policies: [
    { path: 'todos', merge: keyedArray((t) => t.id) }, // reconcile a list by item identity
    { path: 'title', merge: preserve }, // keep both sides of a clash as data
  ],
});
```

A **merge policy** decides the result when two peers change one path at once: `lww` (default), `mergeThree` (three-way against the common ancestor), `keyedArray(idFn)` (list reconcile by identity), or `preserve` (both sides survive as a `Conflicted` value; `isConflicted(v)` narrows it, resolution is a later write). `rebaseOps(root, pending, remote, policies)` is the pure invert-apply-reapply routine behind optimistic updates and offline queues, and `policyStrategy(policies)` gives a `forkStore` the same per-path resolution. This is what [`@mmstack/mesh`](https://www.npmjs.com/package/@mmstack/mesh) wraps for multiplayer.

### Keyed containers

**A list several peers reorder is a record keyed by element id, never an array.** Each element carries a fractional position at `~pos`, so an insert is one write at `[list, id]` and a move is one write at `[list, id, '~pos']` — two peers inserting into the same list at once keep both elements, where one whole-array write would have folded over the other.

```typescript
import { keyedContainer } from '@mmstack/primitives';

const board = store<{ todos: Record<string, Todo> }>({ todos: {} });
const todos = keyedContainer({ key: (t: Todo) => t.id }); // or pass the key to insert

todos.insert(board.todos, { id: 't1', title: 'Ship it' }, 0);
todos.move(board.todos, 't1', 3); // writes the position and nothing else
todos.entries(board.todos()); // reading order: by ~pos, key breaking ties
todos.rebalance(sync, board.todos); // authority sweep when positions grow long
```

Reading order is a pure function of the materialized value, so every replica agrees without consulting the op log. `wrappedContainer` stores elements as `{ '~pos', value }` instead, keeping the payload a closed record a schema can validate; the choice is fixed when the container is created and never inferred from data, so peers of a synced container must agree on it. `posBetween(before, after)` is the fractional index underneath.

## Async state values & sentinels

Rather than managing disjoint `isLoading`, `error`, and `data` boolean flags ("boolean soup"), `@mmstack` models async states as explicit, first-class values. A **sentinel** is a frozen, lightweight value representing an in-flight or failed state:

- `loading`: data is currently in flight. Created via `loading(source?)`, where `source` optionally describes what is loading.
- `error`: an operation failed. The sentinel object itself is value-free (the actual error cause is delivered to telemetry once and not retained on the value to prevent memory leaks).
- `done`: an operation settled successfully without a payload (`DONE`).

`loading` and `error` are **absorbing**: any operation depending on an unresolved state yields that state rather than producing garbage data or throwing prematurely (similar to how `NaN` propagates through arithmetic).
Use `isLoading(v)`, `isError(v)`, `isDone(v)`, and `isSentinel(v)` to narrow values, or `ifLoading(v, fallback)` and `ifError(v, fallback)` to provide defaults.

### Combining resources: `joined()`

For combining multiple async resources into a single signal without exceptions or boilerplate, use `joined()`:

```typescript
import { joined } from '@mmstack/primitives';

// Combines independent resources into a single reactive Result union:
const card = joined(user, org, (u, o) => `${u.name} @ ${o.name}`);

// card() is:
//   { kind: 'value', value: '...' }
// | { kind: 'pending', source: ... }
// | { kind: 'error', error: ... }
```

In templates, consume `joined()` using Angular `@switch`:

```html
@switch (card().kind) { @case ('value') {
<p>{{ card().value }}</p>
} @case ('pending') {
<span class="spinner">Loading card…</span>
} @case ('error') {
<p class="error">Failed: {{ card().error }}</p>
} }
```

`joined()` runs as a standard `computed()`: it never throws, joins pending/error states automatically, and maps any thrown exceptions inside your callback into an `error` result. To convert a single resource outcome to this tagged shape, use `settle(outcome)`.

### State precedence & `joinAbsorbers()`

When multiple async resources are combined, `@mmstack` resolves their combined state using deterministic precedence:

`value < error < pending`

- **Pending outranks error** (`'pending-first'`, default): while any resource is still in flight, the combined operation is not settled, so errors are held until all pending work resolves.
- **Error outranks pending** (`'error-first'`): pass `'error-first'` to `joined()`, `latest()`, or a transition scope if you want a failure to surface immediately even while other sibling requests are still loading.

`joinAbsorbers(operands, order)` performs this resolution: it returns the winning in-flight or error state, or `undefined` if all operands have resolved to values.

```typescript
import { errorEdge, joinAbsorbers, loading } from '@mmstack/primitives';

const failed = errorEdge('failed');
const waiting = loading();

joinAbsorbers([1, failed, waiting]); // waiting (pending outranks error by default)
joinAbsorbers([1, failed, waiting], 'error-first'); // failed
joinAbsorbers([1, 2]); // undefined (all values resolved)
```

### Minting errors & telemetry

`errorEdge(cause)` mints an error sentinel for an I/O failure (used by resource `outcome()`s); `error(message)` mints an application error. Every mint reports its cause once to the installed reporter at creation time.

In an application, `provideSentinelTelemetry()` from [`@mmstack/telemetry-core`](https://www.npmjs.com/package/@mmstack/telemetry-core) forwards these to your telemetry sink (tracking origin, subclass, and error type) and unregisters cleanly when the injector is destroyed. Without Angular DI, use `setErrorReporter(reporter)`:

```typescript
import { errorEdge, isError, setErrorReporter } from '@mmstack/primitives';

setErrorReporter(({ origin, subclass, cause }) =>
  console.warn(origin, subclass, cause),
);

const failed = errorEdge(new Error('503')); // reported once
isError(failed); // true
```

### Template safety & coercion

If a sentinel value is interpolated directly in a template (e.g. `{{ res.outcome() }}` or `{{ res.outcome() | json }}`):

- By default, it safely renders as `[mmstack loading]`, `[mmstack error]`, or `[mmstack done]` (or `NaN` in numeric contexts and `{"$sentinel": "loading"}` with the `json` pipe), preventing change detection from throwing repeatedly.
- The first time a sentinel is coerced, it reports an `origin: 'leak'` finding through the installed telemetry reporter so unintended template reads are visible in monitoring.
- `provideStrictSentinels()` at the application root makes coercion throw a `SentinelLeakError`, useful in compiler or expression-evaluation contexts that require strict containment. The policy is realm-wide: the most recently initialized live provider wins, including `provideStrictSentinels(false)`. Injectors can be destroyed in any order; each removes only its own override. With no providers, `setStrictSentinels(true)` controls the policy directly. While providers are active, that setter updates the fallback used after the last provider is destroyed.

### The compiler & expression kit (`@mmstack/primitives/algebra`)

For teams building dynamic expression interpreters or AST compilers that evaluate user expressions over async sentinels, the operator algebra (`strictUnary`, `strictBinary`, `and`, `or`, `coalesce`, `conditional`, `member`, `invoke`, `joinAbsorbersDeep`) and sentinel-safe array shims (`ARRAY_METHOD_SHIMS`, `spreadArray`) are published separately under:

```typescript
import { strictBinary, ARRAY_METHOD_SHIMS } from '@mmstack/primitives/algebra';
```

Standard application development does not need this subpath.

### Multi-bundle registry

Sentinels are recognized across independently bundled chunks or micro-frontends through a shared registry on `globalThis` (`Symbol.for('@mmstack/primitives.sentinels')`). Two bundles sharing the same protocol version seamlessly recognize each other's sentinels and share the strictness setting.

## Observability

An optional listener seam on the concurrency layer. `provideConcurrencyInstrumentation(listener)` receives events as transition scopes coordinate pending, suspense and transaction windows; with no listener the taps are no-ops. `perfCustomTracks()` is a ready listener that writes each window to a Chrome DevTools Performance track, and the window hooks are span-shaped, so forwarding to [`@mmstack/telemetry-core`](https://www.npmjs.com/package/@mmstack/telemetry-core) is a direct mapping.

```typescript
import {
  provideConcurrencyInstrumentation,
  perfCustomTracks,
} from '@mmstack/primitives';

providers: [provideConcurrencyInstrumentation(perfCustomTracks())];
```

Three hooks report failures and what was done about them:

- `resourceFailed({ scope, name, message, at })`: a member started failing. Reported once per failure; a member that recovers and fails again reports again.
- `retryRound({ scope, dispatched, at })`: a `retry(id)` or `retryAll()` round was claimed. A round that re-ran nothing reports `dispatched: 0`.
- `dismissed({ scope, name, at })`: one failure was hidden. `dismissAll()` reports each entry it actually hid.

`perfCustomTracks()` draws these as zero-length entries on the same track (`failed: <name>`, `retry (<dispatched>)`, `dismissed: <name>`). The failure tap runs for scopes made by `provideTransitionScope()`, which has an injection context to watch from; a listener passed as `provideTransitionScope({ instrumentation })` gets every hook, pending spans included. A listener without these hooks costs nothing extra: no watcher is installed and no payload is built.

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

| Type                | Standalone fn                | Returns                                                   | Notes                                                                                                          |
| ------------------- | ---------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `networkStatus`     | `networkStatus()`            | `Signal<boolean>` + `.since`                              | Online/offline. `since` is `Signal<Date>` of last transition.                                                  |
| `pageVisibility`    | `pageVisibility()`           | `Signal<DocumentVisibilityState>`                         | `'visible' \| 'hidden' \| 'prerender'`.                                                                        |
| `mediaQuery`        | `mediaQuery(q)`              | `Signal<boolean>`                                         | Generic CSS media-query tracker.                                                                               |
| `dark-mode`         | `prefersDarkMode()`          | `Signal<boolean>`                                         | Shorthand for `(prefers-color-scheme: dark)`.                                                                  |
| `reduced-motion`    | `prefersReducedMotion()`     | `Signal<boolean>`                                         | Shorthand for `(prefers-reduced-motion: reduce)`.                                                              |
| `windowSize`        | `windowSize()`               | `Signal<{ width, height }>` + `.unthrottled`              | Throttled to 100ms by default.                                                                                 |
| `scrollPosition`    | `scrollPosition()`           | `Signal<{ x, y }>` + `.unthrottled`                       | Window or element scroll, throttled 100ms.                                                                     |
| `mousePosition`     | `mousePosition()`            | `Signal<{ x, y }>` + `.unthrottled`                       | Throttled 100ms. `coordinateSpace: 'client' \| 'page'`, optional `touch`.                                      |
| `pointerDrag`       | `pointerDrag()`              | `Signal<PointerDragState>` + `.unthrottled` + `.cancel()` | Pointer gesture (down→move→up) with `activationThreshold`, `delta`, modifiers, pointer capture, Escape-cancel. |
| `elementVisibility` | `elementVisibility(target?)` | `Signal<IntersectionObserverEntry?>` + `.visible`         | IntersectionObserver-based, `.visible` is a boolean shorthand.                                                 |
| `elementSize`       | `elementSize(target?)`       | `Signal<{ width, height }?>`                              | ResizeObserver-based. Defaults to `border-box`.                                                                |
| `geolocation`       | `geolocation(opt?)`          | `Signal<GeolocationPosition?>` + `.error` + `.loading`    | One-shot by default; pass `watch: true` for `watchPosition`.                                                   |
| `clipboard`         | `clipboard()`                | `Signal<string>` + `.copy(v)` + `.isSupported`            | Mirrors clipboard contents; `.copy` writes through and updates the signal.                                     |
| `orientation`       | `orientation()`              | `Signal<{ angle, type }>`                                 | Tracks `screen.orientation`.                                                                                   |
| `batteryStatus`     | `batteryStatus()`            | `Signal<BatteryStatus \| null>`                           | `null` until `navigator.getBattery()` resolves, or forever if unsupported.                                     |
| `idle`              | `idle({ ms })`               | `Signal<boolean>` + `.since`                              | Flips to `true` after `ms` of inactivity. Configurable activity events.                                        |
| `focusWithin`       | `focusWithin(target?)`       | `Signal<boolean>`                                         | Mirrors the `:focus-within` CSS pseudo-class.                                                                  |

Element-targeting sensors (`elementSize`, `elementVisibility`, `focusWithin`, `pointerDrag`) default `target` to `inject(ElementRef)` so they're drop-in inside a component.

### `pointerDrag`

Tracks a pointer **gesture** (pointerdown → capture → move → up) as a signal — the
foundation for pointer-based move/resize/marquee on a canvas. Unlike native HTML5
drag, pointer events fire continuously and coordinates stay reliable; `delta` is
computed on the same update as `current` (never torn). `active` only flips true
once the pointer travels past `activationThreshold`, so the same element stays
clickable. Uses `setPointerCapture`, supports a delegated `handleSelector`, and
cancels on Escape or via `.cancel()`.

A delegated `handleSelector` reports which child actually started the drag via
`drag().origin` (so one listener on a container can serve many handles), and
`stopPropagation: true` lets an inner sensor claim the `pointerdown` over an
outer one on the same tree (e.g. a nested sortable). Reads are throttled
(`throttle`, default 16ms); `drag.unthrottled()` exposes the un-throttled view
for logic that needs the exact release position.

The idle state carries the **end reason**: `cancelled` is `true` when the gesture
was aborted (Escape, `pointercancel`, `.cancel()`) rather than released, and stays
set until the next `pointerdown` — so a drag consumer can tell "drop here" from
"abort" (`@mmstack/dnd` uses this to cancel instead of committing).

```typescript
import { sensor } from '@mmstack/primitives';

const drag = sensor('pointerDrag', { activationThreshold: 4 });

// derive position from the gesture — no effects
const position = computed(() => {
  const d = drag();
  return d.active ? { x: base.x + d.delta.x, y: base.y + d.delta.y } : base;
});
// drag().modifiers.shift → e.g. constrain axis · drag().origin → the handle · drag.cancel() → revert
```

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
