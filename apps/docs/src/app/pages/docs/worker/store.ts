import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-worker-store',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Replicas and writes"
      pkg="@mmstack/worker"
      lead="Mirror a worker-owned store to the main thread as a live, writable op-log endpoint: writes apply optimistically and route to the owner, and other readers (mesh, persist) attach to the same store."
    >
      <p>
        <code>workerStore</code> gives the main thread a store the worker owns.
        For an owned subtree it is a real, writable signal store: you read it
        deeply per leaf and route changes with <code>write</code>, like any store
        from <code>&#64;mmstack/primitives</code>. It hydrates from the owner's
        first snapshot, then folds each authoritative batch in through an
        echo-free apply.
      </p>

      <docs-code [code]="replica" lang="ts" />

      <docs-section title="Writing (optimistic)" id="write">
        <p>
          <code>write</code> applies your recipe locally right away, ships the
          diff to the owner as minimal operations, and the owner (the single
          sequencer) applies and re-emits it. The returned promise resolves once
          that authoritative batch lands back, so you can await confirmation while
          the value is already on screen. The owner stays authoritative: every
          replica reconciles to its ordering, and interleaved writes converge to
          the same state everywhere.
        </p>
        <docs-code [code]="write" lang="ts" />
      </docs-section>

      <docs-section title="Honest async (opt-in)" id="honest">
        <p>
          Optimistic is the default because it matches how the rest of the stack
          syncs. If you'd rather not show a value until the owner confirms it
          (say the owner can reject the write), fork the store, write to the fork,
          and reveal it only when the <code>write</code> promise resolves.
        </p>
        <docs-code [code]="honest" lang="ts" />
      </docs-section>

      <docs-section title="Compose: sync and persistence" id="compose">
        <p>
          Because the owned store is a writable op-log endpoint, the readers from
          <code>&#64;mmstack/primitives</code> and
          <code>&#64;mmstack/mesh</code> attach to it directly, no bridge.
          <code>persist</code> makes the worker-owned graph durable;
          <code>meshSync</code> replicates it to peers. The worker owns the graph
          off the main thread; sync and durability are readers over its op-log.
        </p>
        <docs-code [code]="compose" lang="ts" />
      </docs-section>

      <docs-section title="Published derivations" id="published">
        <p>
          A published entry is a value the worker computes, mirrored read-only.
          Because it satisfies the resource surface, an in-flight worker
          computation shows as pending on the main thread while it holds the last
          value. This is how a worker-side derivation participates in a Suspense
          boundary just like a fetch would.
        </p>
        <docs-code [code]="published" lang="ts" />
        <p>
          A published subtree has no <code>write()</code> at the type level, so
          calling it is a compile error. The distinction between owned (writable)
          and published (read-only) is inferred from the worker's contract.
        </p>
      </docs-section>

      <docs-section title="Resilience" id="resilience">
        <p>
          The replica recovers on its own. If it sees a version gap from a lost
          message it holds the stale value, re-subscribes, and re-hydrates from a
          fresh snapshot. A duplicate batch is dropped by version. If the worker
          crashes it respawns with backoff and every replica re-subscribes;
          pending writes reject with <code>WorkerCrashedError</code> so the
          caller, who still has the value and the recipe, can retry.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class WorkerStoreDoc {
  protected readonly replica = `import { workerStore } from '@mmstack/worker';

const todos = workerStore(this.worker, 'todos');

todos.store;       // WritableSignalStore<Todo[]> (owned): read deeply, route writes
todos.value();     // Signal<Todo[] | undefined>, undefined before hydration
todos.status();    // 'loading' until the first snapshot, then 'resolved'
todos.hasValue();
todos.connected;   // the worker connection's liveness`;

  protected readonly write = `await todos.write((draft) => {
  draft.set([...draft(), { id: 1, text: 'buy milk', done: false }]);
});
// visible immediately (optimistic); the promise resolves once the owner's
// authoritative batch has reconciled this replica`;

  protected readonly honest = `const draft = forkStore(todos.store);   // a detached copy
draft.set(next);                         // edit the fork, not the shown store
await todos.write((d) => d.set(next));   // owner confirms
// only now is 'next' the authoritative value on todos.store`;

  protected readonly compose = `import { persist, meshSync } from '@mmstack/primitives'; // + @mmstack/mesh transport

const doc = workerStore(this.worker, 'doc'); // owned → writable op-log endpoint

persist(doc.store, { key: 'doc', store: idbKeyval });      // durable to IndexedDB
meshSync(doc.store, { room: 'doc-42', writer, transport }); // synced to peers
// a persisted, meshed, worker-owned graph: three readers over one op-log`;

  protected readonly published = `// worker: a derivation recomputed off-main
const visible = computed(() => todos().filter((t) => !t.done));
createWorkerHost({ stores: { todos }, published: { visible } });

// main: mirror it read-only
const visible = workerStore(this.worker, 'visible');
visible.status();  // 'reloading' while the worker recomputes, 'resolved' when settled
visible.value();   // the last result, held during recompute`;
}
