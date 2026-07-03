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
      lead="Mirror a worker-owned store to the main thread as a live, read-only replica, and route writes back to the owner."
    >
      <p>
        <code>workerStore</code> gives the main thread a replica of a store the
        worker owns. The replica is a real, read-only signal store: you read it
        deeply, per leaf, like any store from
        <code>&#64;mmstack/primitives</code>. It hydrates from the owner's first
        snapshot, then applies each authoritative batch in one notification wave.
      </p>

      <docs-code [code]="replica" lang="ts" />

      <docs-section title="Routing a write" id="write">
        <p>
          You cannot set a leaf locally, because that would diverge from the
          owner. To change owned state you route a write. Your recipe runs
          against a scratch draft of the current replica, the difference is
          shipped to the owner as minimal operations, the owner applies and
          re-emits it, and the promise resolves once that authoritative batch has
          landed back on your replica.
        </p>
        <docs-code [code]="write" lang="ts" />
        <p>
          Nothing is applied optimistically, which is exactly what guarantees
          every replica converges to the owner's ordering. Interleaved writes
          from several components end up identical everywhere.
        </p>
      </docs-section>

      <docs-section title="Optimistic UI" id="optimistic">
        <p>
          Because writes are honest, optimism is opt-in. Keep a local overlay,
          show it, route the write underneath, and drop the overlay when the
          authoritative value lands.
        </p>
        <docs-code [code]="optimistic" lang="ts" />
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

todos.store;       // SignalStore<Todo[]>, read deeply like any store
todos.value();     // Signal<Todo[] | undefined>, undefined before hydration
todos.status();    // 'loading' until the first snapshot, then 'resolved'
todos.hasValue();
todos.connected;   // the worker connection's liveness`;

  protected readonly write = `await todos.write((draft) => {
  draft.set([...draft(), { id: 1, text: 'buy milk', done: false }]);
});
// resolves after the owner's authoritative batch has updated this replica`;

  protected readonly optimistic = `const overlay = signal<Todo[] | null>(null);
const view = computed(() => overlay() ?? todos.value() ?? []); // render view()

async function add(todo: Todo) {
  const next = [...(todos.value() ?? []), todo];
  overlay.set(next);           // shown immediately
  try {
    await todos.write((d) => d.set(next));
  } finally {
    overlay.set(null);         // authoritative value has landed
  }
}`;

  protected readonly published = `// worker: a derivation recomputed off-main
const visible = computed(() => todos().filter((t) => !t.done));
createWorkerHost({ stores: { todos }, published: { visible } });

// main: mirror it read-only
const visible = workerStore(this.worker, 'visible');
visible.status();  // 'reloading' while the worker recomputes, 'resolved' when settled
visible.value();   // the last result, held during recompute`;
}
