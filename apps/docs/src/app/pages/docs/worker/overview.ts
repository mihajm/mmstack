import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-worker-overview',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Worker"
      experimental
      pkg="@mmstack/worker"
      lead="Split-graph state and compute. Keep the reactive graph on the main thread for rendering, and hand owned state plus heavy work to a Web Worker that runs its own graph. State stays in sync over small deltas, never full snapshots."
    >
      <p>
        A component that does real work on the client eventually hits the same
        wall: a parse, a filter over ten thousand rows, a layout pass, and the
        frame drops because it all runs on the thread that also paints. The
        usual fix is to move the work to a Web Worker, and then you inherit a
        second problem. The worker has the data, the UI needs it, and now you
        are hand-writing <code>postMessage</code> calls and keeping two copies
        of everything in step.
      </p>
      <p>
        <code>&#64;mmstack/worker</code> removes the second problem. The worker
        owns state and derives from it; the main thread reads a live replica and
        routes writes back. Sync happens for you, as minimal operations over the
        store op-log from
        <a mmLink="/docs/primitives/store">&#64;mmstack/primitives</a>, so you
        never ship a whole object across the boundary after the first load.
      </p>

      <docs-code [code]="install" lang="bash" />

      <docs-section title="The mental model" id="model">
        <p>
          There are two reactive graphs and a wire between them. The
          <strong>worker graph</strong> owns the data. You build it in a worker
          entry file with <code>createWorkerHost</code>, and it can own writable
          stores, publish derivations, and expose callable tasks.
        </p>
        <p>
          The <strong>main graph</strong> renders. From a component you
          <code>connectWorker</code> (which spawns the worker), then read a
          replica of an owned store, mirror a published derivation, or run a
          task. These three capabilities are the rungs. Use only the first to
          run a heavy function off-main, or all three for a subsystem that lives
          on a worker and syncs to the UI.
        </p>
        <ul>
          <li>
            <strong>Rung 1</strong>, a task run off-main with the resource
            surface. See <a mmLink="/docs/worker/resource">workerResource</a>.
          </li>
          <li>
            <strong>Rung 2</strong>, a live read-only replica of a worker-owned
            store, with writes routed to the owner. See
            <a mmLink="/docs/worker/store">Replicas and writes</a>.
          </li>
          <li>
            <strong>Rung 3</strong>, a worker-side derivation mirrored
            read-only, with its pending state carried across. Covered on the
            same page.
          </li>
        </ul>
      </docs-section>

      <docs-section title="Quick start" id="quick-start">
        <p>
          Two files. First the worker, which owns a counter, publishes stats
          derived from it, and exposes a heavy <code>fib</code> task. It has no
          Angular DI, only signals and plain functions.
        </p>
        <docs-code [code]="workerFile" lang="ts" label="app/demo.worker.ts" />
        <p>
          Then the component. The <code>new Worker(new URL(...))</code> literal
          lives here in app code so the bundler emits the worker chunk. Passing
          <code>&lt;typeof host&gt;</code> to <code>connectWorker</code> infers
          every key, value type, and task signature from the worker you wrote.
        </p>
        <docs-code
          [code]="componentFile"
          lang="ts"
          label="app/worker-demo.ts"
        />
      </docs-section>

      <docs-section title="Entry points" id="entry-points">
        <p>
          Three entry points, so worker code never pulls in main-thread code and
          the wire types cannot drift between the two sides.
        </p>
        <docs-code [code]="entries" lang="ts" />
        <ul>
          <li>
            <code>&#64;mmstack/worker</code> runs on the main thread:
            <code>connectWorker</code>, <code>workerStore</code>,
            <code>workerResource</code>.
          </li>
          <li>
            <code>&#64;mmstack/worker/host</code> runs in the worker entry file:
            <code>createWorkerHost</code>, <code>workerStoreContext</code>.
          </li>
          <li>
            <code>&#64;mmstack/worker/protocol</code> holds the shared wire
            types used by both sides.
          </li>
        </ul>
      </docs-section>

      <docs-section title="How the sync works" id="how-it-works">
        <p>
          Every owned store on the worker is watched by an op-log. A leaf change
          becomes a minimal batch of path operations tagged with a monotonic
          version, and that batch is applied on each replica in a single
          <code>set</code>, one notification wave no matter how many operations
          it carries. The first hydration is the only snapshot; everything after
          is a delta.
        </p>
        <p>
          A write applies optimistically on the writer and routes to the owner,
          which folds it in and echoes it to every replica; the echo is also the
          acknowledgement. The main thread and the worker run the same convergent
          sync the mesh uses, so interleaved writes from several components land
          on the same value on every replica. The owner can also correct a value
          authoritatively, and that correction wins wherever it meets a
          concurrent write, which is how a single owner keeps the last word over
          its subtree.
        </p>
        <p>
          Reads stay synchronous because a replica always holds a value. Only
          writes and settles are async, and they surface as
          <code>pending</code> through transition scopes rather than promises
          you await in a template.
        </p>
      </docs-section>

      <docs-section title="Notes and limits" id="notes">
        <ul>
          <li>
            Store values that cross the wire must be structured-clonable. Class
            instances, functions, and <code>opaque()</code> values do not
            serialize.
          </li>
          <li>
            One owner per subtree, always. Moving a subtree to another thread is
            a new owner and a re-hydrate.
          </li>
          <li>
            Store values must be structured-clonable. A dev-mode guard names the
            offending store if a value cannot be sent across the boundary.
          </li>
          <li>
            On the server nothing spawns. Replicas render their default and
            resolve once the worker connects during hydration.
          </li>
          <li>
            Feeding a worker with server data: fetch on the main thread with
            <a mmLink="/docs/resource/query">queryResource.text</a> or
            <code>.arrayBuffer</code> (interceptors and auth intact), then hand
            the raw body to a task with <code>transfer()</code>. The parse runs
            off-main and the parsed rows never touch the main thread.
          </li>
        </ul>
      </docs-section>
    </docs-page>
  `,
})
export class WorkerOverview {
  protected readonly install = `npm install @mmstack/worker @mmstack/primitives`;

  protected readonly workerFile = `import { computed } from '@angular/core';
import { store } from '@mmstack/primitives';
import { createWorkerHost, workerStoreContext } from '@mmstack/worker/host';

export type CounterState = { value: number; history: number[] };
export type Stats = { count: number; sum: number; max: number };

// stores in a worker share ONE context (the worker's providedIn: 'root')
const counter = store<CounterState>({ value: 0, history: [] }, workerStoreContext());

const stats = computed<Stats>(() => {
  const h = counter().history;
  return { count: h.length, sum: h.reduce((a, b) => a + b, 0), max: h.length ? Math.max(...h) : 0 };
});

const fib = (n: number): number => {
  let a = 0, b = 1;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
};

const host = createWorkerHost({
  stores: { counter },
  published: { stats },
  tasks: { fib },
});

// the worker's compile-time contract, imported (type-only) by the component
export type AppWorker = typeof host;`;

  protected readonly componentFile = `import { ChangeDetectionStrategy, Component } from '@angular/core';
import { connectWorker, workerResource, workerStore } from '@mmstack/worker';
import type { AppWorker } from './demo.worker';

@Component({
  selector: 'app-worker-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: \`
    <p>{{ connected() ? 'connected' : 'connecting…' }}</p>
    <p>counter: {{ counter.value()?.value ?? 0 }}</p>
    <button (click)="add(1)">+1</button>

    @if (stats.hasValue()) {
      <p>count {{ stats.value()?.count }}, sum {{ stats.value()?.sum }}</p>
    }

    <p>fib(35) = {{ fib.isLoading() ? '…' : fib.value() }}</p>
  \`,
})
export class WorkerDemo {
  private readonly worker = connectWorker<AppWorker>(
    () => new Worker(new URL('./demo.worker', import.meta.url), { type: 'module' }),
  );

  readonly connected = this.worker.connected;
  readonly counter = workerStore(this.worker, 'counter'); // CounterState, writable
  readonly stats = workerStore(this.worker, 'stats');     // Stats, read-only

  readonly fib = workerResource(() => 35, { worker: this.worker, task: 'fib' });

  add(n: number): void {
    this.counter.write((draft) => {
      const next = (draft.value() ?? 0) + n;
      draft.value.set(next);
      draft.history.set([...(draft.history() ?? []), next]);
    });
  }
}`;

  protected readonly entries = `import { connectWorker, workerStore, workerResource } from '@mmstack/worker';
import { createWorkerHost, workerStoreContext } from '@mmstack/worker/host';
import { transfer, type WorkerPortLike } from '@mmstack/worker/protocol';`;
}
