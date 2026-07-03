import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-worker-setup',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Host, connection, and typing"
      pkg="@mmstack/worker"
      lead="Build the worker runtime with createWorkerHost, connect to it with connectWorker, and get the whole thing typed from one export."
    >
      <docs-section title="The worker host" id="host">
        <p>
          <code>createWorkerHost</code> is the entire worker runtime. It has no
          Angular DI, only signals and plain functions. Call it once at the top
          of your worker entry file. By default it serves the worker's own
          <code>self</code> scope, so your code never touches
          <code>self</code> or <code>postMessage</code>.
        </p>
        <docs-code [code]="host" lang="ts" />
        <p>
          <code>workerStoreContext()</code> returns the one store context for the
          worker. Pass it to every store you create there so they share proxy
          identity and cleanup. It is the worker's version of
          <code>providedIn: 'root'</code>, scoped to the thread because the
          <code>/host</code> entry only loads inside a worker. Do not use it on
          the main thread.
        </p>
      </docs-section>

      <docs-section title="Connecting" id="connect">
        <p>
          <code>connectWorker</code> spawns the worker and runs the handshake.
          You pass a factory that returns the worker, not the worker itself,
          which is what keeps it safe on the server and puts the
          bundler-visible literal in your app code.
        </p>
        <docs-code [code]="connect" lang="ts" />
        <p>
          The <code>new Worker(new URL('./x.worker', import.meta.url), &#123;
          type: 'module' &#125;)</code> form must be written literally: a string
          literal path, and <code>import.meta.url</code> as the second argument.
          This is the one shape the Angular application builder, webpack 5, and
          Vite all recognize and turn into a separate worker bundle. A computed
          path silently opts out.
        </p>
      </docs-section>

      <docs-section title="Typing from the contract" id="typing">
        <p>
          Export the host type from your worker file and pass it to
          <code>connectWorker</code>. Every store key, value type, task
          signature, and whether a subtree is writable is then inferred.
        </p>
        <docs-code [code]="typing" lang="ts" />
        <p>
          For an untyped connection you can still set the value type by hand with
          <code>workerStore&lt;Todo[]&gt;(worker, 'todos')</code>.
        </p>
      </docs-section>

      <docs-section title="Server-side rendering" id="ssr">
        <p>
          On the server <code>connectWorker</code> does not spawn.
          <code>connected()</code> stays <code>false</code>, replicas hold their
          default value, and <code>runTask</code> rejects. The subtree renders
          its connecting state and resolves once the worker connects during
          client hydration. No guard needed on your side.
        </p>
        <docs-code [code]="ssr" lang="ts" />
      </docs-section>

      <docs-section title="Crash handling" id="restart">
        <p>
          With <code>restart: 'auto'</code> (the default) a crashed worker
          respawns with exponential backoff, re-handshakes, and every live
          replica re-subscribes. Pass <code>restart: 'manual'</code> to surface
          the disconnect instead of recovering.
        </p>
        <docs-code [code]="restart" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class WorkerSetupDoc {
  protected readonly host = `// app/demo.worker.ts
import { store } from '@mmstack/primitives';
import { createWorkerHost, workerStoreContext } from '@mmstack/worker/host';

const todos = store<Todo[]>([], workerStoreContext());
const filter = store({ q: '' }, workerStoreContext()); // same context

const host = createWorkerHost({
  stores: { todos, filter },   // writable stores the worker owns
  published: { visible },      // derived signals mirrored read-only
  tasks: { search, index },    // callable functions
});

export type AppWorker = typeof host;`;

  protected readonly connect = `import { connectWorker } from '@mmstack/worker';
import type { AppWorker } from './demo.worker';

const worker = connectWorker<AppWorker>(
  () => new Worker(new URL('./demo.worker', import.meta.url), { type: 'module' }),
);

worker.connected();        // Signal<boolean>, true after the handshake
worker.manifest();         // Signal<{ hostId, stores, published, tasks } | null>
worker.runTask('search', 'foo'); // Promise<Result>, typed from the tasks
worker.destroy();`;

  protected readonly typing = `const worker = connectWorker<AppWorker>(spawn);

workerStore(worker, 'todos');    // Todo[], writable (owned store)
workerStore(worker, 'visible');  // read-only, no write() (published)
worker.runTask('search', 'foo'); // typed input and result
worker.runTask('unknown', 1);    // compile error: not a task`;

  protected readonly ssr = `// nothing to guard: on the server this renders "connecting…"
// and resolves after hydration
readonly connected = this.worker.connected;
readonly todos = workerStore(this.worker, 'todos', { defaultValue: [] });`;

  protected readonly restart = `const worker = connectWorker<AppWorker>(spawn, { restart: 'auto' });
// or 'manual' to stop and surface the disconnect via connected()`;
}
