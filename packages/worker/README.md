# @mmstack/worker

> **Experimental.** The API may still change and this package is not yet battle-tested in production. Pin a version and expect some churn.

Split-graph state and compute for Angular. Keep the reactive graph on the main thread for rendering, and hand owned state plus heavy computation to a Web Worker that runs its own graph. The main thread reads live replicas and routes writes; the worker owns the data, derives from it, and answers tasks. State stays in sync automatically over minimal deltas, never full snapshots.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/worker/LICENSE)

Built on the store op-log from [`@mmstack/primitives`](https://www.npmjs.com/package/@mmstack/primitives): every change crosses the thread boundary as a small batch of path-level ops, applied in one notification wave on the other side.

## Highlights

- **Main renders, worker computes.** The worker owns stores and derivations and runs off the main thread. The main thread holds a live replica of each owned store (a real, writable signal store), so heavy work makes the UI pending, not frozen.
- **Deltas, not snapshots.** State mirrors as op batches (one `set`/`delete` per changed path), diffed by reference identity. The initial hydration is the only snapshot; everything after is a minimal delta.
- **Single sequencer, provable convergence.** Each store subtree has exactly one owner (the worker). Writes apply optimistically on the main thread and route to that owner, which sequences them and fans the authoritative result back to every replica; because every op is idempotent, replicas reconcile without divergence. Owner-authoritative, no CRDTs. Interleaved writes converge to identical state.
- **Optimistic by default, composable.** A write is visible immediately and its promise resolves once the owner confirms; fork the store if you want honest hide-until-confirmed. And because an owned store is a writable op-log endpoint, `persist` and `@mmstack/mesh`'s `meshSync` attach to it directly: a persisted, meshed, worker-owned graph with no bridge.
- **The resource surface you already know.** `workerResource` runs a function off-main and exposes `value` / `status` / `error` / `isLoading`, so it drops into `latest()` / `use()` and Suspense boundaries with no adapter.
- **Typed from the worker's contract.** `connectWorker<typeof host>()` infers store keys, value types, task signatures, and whether a subtree is writable, all from the worker you wrote.
- **SSR safe.** On the server nothing spawns. Replicas render their default value and resolve once the worker connects in the browser.
- **Resilient.** Lost batches re-hydrate from a fresh snapshot. A crashed worker respawns with backoff and re-subscribes. Pending writes reject so you can retry.

## Install

```bash
npm install @mmstack/worker @mmstack/primitives
```

`@mmstack/primitives`, `@angular/core`, and `@angular/common` are peer dependencies.

## The mental model

There are two reactive graphs and a wire between them.

**The worker graph** owns the data. You build it inside a worker entry file with `createWorkerHost`. It can:

1. own `stores` (writable signal stores the worker is the single writer of),
2. `publish` derivations (read-only `computed`s or async `latest()` values recomputed on the worker),
3. expose `tasks` (plain functions the main thread can call).

**The main graph** renders. From a component you `connectWorker` (which spawns the worker) and then:

1. `workerStore(worker, key)` gives a live replica of an owned store (a writable op-log endpoint): read it, `write()` to route a change to the owner (optimistic), and attach `persist`/`meshSync` readers to it,
2. `workerStore(worker, key)` on a published key gives a read-only mirror of a derivation (no `write()`),
3. `workerResource(...)` runs a task and exposes it with the standard resource surface.

Those three capabilities are the "rungs". You can use only the first (run a heavy function off-main) or all three (a subsystem that lives on a worker and syncs to the UI).

## Quick start

Two files. First the worker, which owns a counter, publishes stats derived from it, and exposes a heavy `fib` task.

```ts
// app/demo.worker.ts
import { computed } from '@angular/core';
import { store } from '@mmstack/primitives';
import { createWorkerHost, workerStoreContext } from '@mmstack/worker/host';

export type CounterState = { value: number; history: number[] };
export type Stats = { count: number; sum: number; max: number };

// stores in a worker share ONE context (the worker's equivalent of providedIn: 'root')
const counter = store<CounterState>({ value: 0, history: [] }, workerStoreContext());

const stats = computed<Stats>(() => {
  const h = counter().history;
  return { count: h.length, sum: h.reduce((a, b) => a + b, 0), max: h.length ? Math.max(...h) : 0 };
});

const fib = (n: number): number => {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
};

const host = createWorkerHost({
  stores: { counter },
  published: { stats },
  tasks: { fib },
});

// the worker's compile-time contract, imported (type-only) by the component below
export type AppWorker = typeof host;
```

Then the component. The `new Worker(new URL(...))` literal lives here in app code so the bundler emits the worker chunk.

```ts
// app/worker-example.ts
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { connectWorker, workerResource, workerStore } from '@mmstack/worker';
import type { AppWorker } from './demo.worker';

@Component({
  selector: 'app-worker-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p>{{ connected() ? 'connected' : 'connecting…' }}</p>

    <p>counter: {{ counter.value()?.value ?? 0 }}</p>
    <button (click)="add(1)">+1</button>

    @if (stats.hasValue()) {
      <p>count {{ stats.value()?.count }}, sum {{ stats.value()?.sum }}</p>
    }

    <p>fib(35) = {{ fib.isLoading() ? '…' : fib.value() }}</p>
  `,
})
export class WorkerDemo {
  // typed against the worker's contract: keys, value types, and write-ability are inferred
  private readonly worker = connectWorker<AppWorker>(
    () => new Worker(new URL('./demo.worker', import.meta.url), { type: 'module' }),
  );

  readonly connected = this.worker.connected;
  readonly counter = workerStore(this.worker, 'counter'); // CounterState, writable (owned)
  readonly stats = workerStore(this.worker, 'stats'); //     Stats, read-only (published)

  readonly fib = workerResource(() => 35, { worker: this.worker, task: 'fib' });

  add(n: number): void {
    this.counter.write((draft) => {
      const next = (draft.value() ?? 0) + n;
      draft.value.set(next);
      draft.history.set([...(draft.history() ?? []), next]);
    });
  }
}
```

## Entry points

The package ships three entry points so worker code never pulls in main-thread code and the wire types can never drift between the two sides.

| Import | Where it runs | Contains |
| --- | --- | --- |
| `@mmstack/worker` | main thread | `connectWorker`, `workerStore`, `workerResource` |
| `@mmstack/worker/host` | worker entry file | `createWorkerHost`, `workerStoreContext` |
| `@mmstack/worker/protocol` | both (types) | `WorkerPortLike`, `transfer`, wire types, schema helpers |

## The worker side: `createWorkerHost`

`createWorkerHost` is the whole worker runtime. It has no Angular DI (there is none in a worker), only signals and plain functions. Call it once at the top of your worker entry file. By default it serves the worker's own `self` scope, so your code never touches `self` or `postMessage`.

```ts
const host = createWorkerHost({
  stores: { todos, filter }, // writable stores the worker owns
  published: { visible },    // derived signals mirrored read-only
  tasks: { search, index },  // callable functions
});
export type AppWorker = typeof host;
```

`workerStoreContext()` returns the one store context for the worker. Pass it to every `store` / `toStore` you create there so they share proxy identity and cleanup. This is the worker's version of `providedIn: 'root'`, and because the `/host` entry only ever loads in a worker, that single instance is scoped to the thread. Never use it on the main thread.

## Connecting: `connectWorker`

`connectWorker` spawns the worker and performs the handshake. You pass a factory that returns the worker, not the worker itself, which is what makes it SSR safe (the factory is never called on the server) and what puts the bundler-visible `new Worker(new URL(...))` literal in your app code.

```ts
const worker = connectWorker<AppWorker>(
  () => new Worker(new URL('./demo.worker', import.meta.url), { type: 'module' }),
);

worker.connected(); // Signal<boolean>, true after the handshake (and after any auto-restart)
worker.manifest(); //  Signal<{ hostId, stores, published, tasks } | null>
worker.runTask('fib', 35); // Promise<number>, typed from the worker's tasks
worker.destroy();
```

The `new Worker(new URL('./x.worker', import.meta.url), { type: 'module' })` form must be written literally. The URL must be a string literal and the second argument must be `import.meta.url`. This is the one shape every modern bundler (the Angular application builder, webpack 5, Vite) recognizes and turns into a separate worker bundle. A computed path silently opts out.

### Manifest typing

Pass the host type as `connectWorker<typeof host>()` and everything downstream is inferred:

```ts
const worker = connectWorker<AppWorker>(spawn);

const todos = workerStore(worker, 'todos'); // Todo[], writable (todos is an owned store)
const visible = workerStore(worker, 'visible'); // read-only, no write() (published)
workerStore(worker, 'nope'); // wrong key: falls back to a loose ref
worker.runTask('search', 'foo'); // typed input and result
worker.runTask('unknown', 1); // compile error: not a task
```

For an untyped connection you can still set the value type by hand: `workerStore<Todo[]>(worker, 'todos')`.

### Server-side rendering

On the server `connectWorker` does not spawn. `connected()` stays `false`, replicas hold their `defaultValue` (or `undefined`), and `runTask` rejects. The subtree renders its "connecting" state and resolves once the worker connects during client hydration.

## `workerResource`: run a function off-main

`workerResource` runs work on a worker and exposes it with the resource surface, so a slow computation makes the UI pending instead of frozen. The first argument reactively derives the input; the run re-fires when that input changes, and the latest run wins.

```ts
const n = signal(40);

const fib = workerResource(() => n(), {
  worker: this.worker,
  task: 'fib',
});

fib.value(); //     Signal<number | undefined>, held through re-runs
fib.status(); //    'idle' | 'loading' | 'reloading' | 'resolved' | 'error' | 'local'
fib.isLoading();
fib.error();
fib.reload(); //    re-run with the current input
fib.abort(); //     cancel the in-flight run; the value is kept, status becomes 'local'
```

Because it satisfies the same shape as a `@mmstack/resource` query, it composes with `latest()` / `use()` and registers into transition scopes:

```ts
const fib = workerResource(() => n(), { worker, task: 'fib', register: 'indicator' });
// a boundary above now shows aria-busy while fib runs, holding the previous value
```

The task named in `{ worker, task }` is a function you exposed on the host with `createWorkerHost({ tasks })`. It runs on the same worker that owns your stores, so a whole subsystem lives on one thread. There is no `eval`, so nothing changes under a strict CSP.

### Options

- `params`: `(ctx) => Input | undefined | ctx.paused`. Return `undefined` to disable (idle), or `ctx.paused` (the `PAUSED` symbol) to hold the current value and status.
- `worker` and `task`: the connected worker and the name of the task to run.
- `keepPrevious` (default `true`): hold the previous value through a re-run (`status` becomes `'reloading'`).
- `equal`: a result equality function; an equal result emits no notification.
- `register`: `'indicator'` or `'suspend'` to join a transition scope.

## `workerStore`: a live replica plus routed writes

`workerStore` mirrors a worker-owned store to the main thread. The replica is a real, read-only `SignalStore` with per-leaf reads.

```ts
const todos = workerStore(this.worker, 'todos');

todos.store; //       SignalStore<Todo[]>, read deeply like any store
todos.value(); //     Signal<Todo[] | undefined>, undefined before hydration
todos.status(); //    'loading' until the first snapshot, then 'resolved'
todos.hasValue();
todos.connected; //   the worker connection's liveness
```

You cannot set a leaf locally (that would diverge from the owner). To change owned state, route a write:

```ts
await todos.write((draft) => {
  draft.set([...draft(), { id: 1, text: 'buy milk', done: false }]);
});
```

`write` runs your recipe against a scratch draft of the current replica, diffs it to minimal ops, and ships them to the owner. The owner applies them and emits the authoritative batch, which comes back and updates your replica. The promise resolves once that batch has landed locally. Nothing is applied optimistically, which is what guarantees every replica converges to the owner's ordering.

### Optimistic UI

Because writes are honest, optimism is opt-in. Keep a local overlay, show it, route the write underneath, and drop the overlay when the authoritative value lands:

```ts
const optimistic = signal<Todo[] | null>(null);
const view = computed(() => optimistic() ?? todos.value() ?? []); // render view()

async function add(todo: Todo) {
  const next = [...(todos.value() ?? []), todo];
  optimistic.set(next); // shown immediately
  try {
    await todos.write((d) => d.set(next));
  } finally {
    optimistic.set(null); // the owner's authoritative batch has landed on the replica
  }
}
```

## Published subtrees

A published entry is a derivation the worker computes. The main thread mirrors it read-only. Because it satisfies the resource surface, an in-flight worker computation shows as pending on the main thread while holding the last value:

```ts
// worker
const visible = latest(() => filter(use(query), todos()));
createWorkerHost({ stores: { todos }, published: { visible } });

// main
const visible = workerStore(this.worker, 'visible');
visible.status(); // 'reloading' while the worker recomputes, 'resolved' when it settles
visible.value(); // the last result, held during recompute
```

Register it with `{ register: 'indicator' }` and a boundary above reflects the worker's pending state. `write()` on a published subtree is a compile error (and rejects at runtime if you reach past the types).

## Transferables

For large binary payloads, `transfer` moves an `ArrayBuffer` into the worker instead of cloning it (zero copy, detached at the sender). It applies to a task's input:

```ts
import { transfer } from '@mmstack/worker';

const buffer = new Float64Array(1_000_000).buffer;
workerResource(() => transfer({ buffer }, [buffer]), { worker, task: 'process' });
```

## Resilience

- **Lost message.** If a replica sees a version gap it re-subscribes, holds the stale value as `'reloading'`, and re-hydrates from a fresh snapshot.
- **Duplicate message.** Batches are applied by monotonic version, so a duplicate is dropped.
- **Crash.** With `restart: 'auto'` (the default) a crashed worker respawns with exponential backoff, re-handshakes, and every live replica re-subscribes. Pending writes reject with `WorkerCrashedError`, so the caller (who still has the value and the recipe) can retry. Pass `restart: 'manual'` to surface the disconnect instead.

## How it works

Every owned store on the worker is observed by an op-log (the same `opLog` from `@mmstack/primitives`). A leaf change becomes a minimal batch of path ops, tagged with a monotonic version. The batch is fanned to every subscribed replica, which applies it in a single `set` (one notification wave, regardless of how many ops it carries).

Writes route to the owner rather than applying locally. The owner is the single sequencer: it applies incoming write ops through the store, which emits one authoritative owner-origin batch covering that write, and that batch goes to every replica including the writer. The writer's replica updates from that echo, and the echo is also the write's acknowledgement. Because all replicas apply the identical owner-ordered stream, they converge, and the async round trip is honest in the API (a `write()` that returns a promise) rather than hidden behind a `set` you cannot read back synchronously.

The protocol rides a minimal structural port (`postMessage` / `onmessage`), so a `MessageChannel` pair works in tests and the same envelope stream can later run over other transports.

## Performance

A worker does not make work finish sooner. It makes it finish somewhere other than the thread that paints, so frames keep rendering. The number that matters is main-thread blocking time, not total wall-clock.

`benchmarks/data-grid.mjs` runs a grid workload (filter, then a three-column sort, then a group aggregate) over a range of row counts and reports how long the main thread is blocked three ways: inline, on a worker that receives the rows on every call, and on a worker that owns the rows and answers with just the result. Run it with `node packages/worker/benchmarks/data-grid.mjs`. On one machine, main-thread blocking in milliseconds:

| rows | inline | worker, ship rows each call | worker owns rows |
| --- | --- | --- | --- |
| 10,000 | 0.7 | 1.9 | 0.01 |
| 100,000 | 11.7 | 19.9 | 0.02 |
| 250,000 | 36.3 | 53.2 | 0.02 |
| 500,000 | 81.9 | 109 | 0.02 |

Two things fall out of this. First, moving work to a worker is not automatically a win: shipping the whole grid across on every call blocks the main thread more than the inline compute did, because serializing the rows costs more than the work. Second, the win is real once the worker owns the data and only deltas cross, which is exactly what `workerStore` does over the op-log. There the main-thread cost is flat and near zero no matter how large the grid grows, because the rows are hydrated once and never re-sent.

So reach for a worker when the data lives there and the main thread reads a replica, not to run a one-shot function over a large payload you hand it each time. For that second case the serialization usually costs more than it saves.

## Notes and limits

- Store values that cross the wire must be structured-clonable. Class instances, functions, and `opaque()` values do not serialize.
- Same-length array reorders diff by value, not identity. Length changes travel as a whole-array op.
- A single owner per subtree, always. If a subtree needs to move threads, that is a new owner and a re-hydrate, not a protocol feature.
- Store values must be structured-clonable; a dev-mode guard names the offending store if not.
