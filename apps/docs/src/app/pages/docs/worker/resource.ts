import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-worker-resource',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="workerResource"
      pkg="@mmstack/worker"
      lead="Run a function off the main thread and read it as a resource. A slow computation makes the UI pending, not frozen."
    >
      <p>
        <code>workerResource</code> runs work on a worker and gives you back the
        same signal surface as a data fetch: <code>value</code>,
        <code>status</code>, <code>error</code>, <code>isLoading</code>. The
        first argument reactively derives the input, the run re-fires when that
        input changes, and the latest run wins.
      </p>

      <docs-code [code]="basic" lang="ts" />

      <p>
        Because it satisfies the same shape as an
        <a mmLink="/docs/resource/query">&#64;mmstack/resource</a> query, it
        composes with <code>latest()</code> and <code>use()</code> and registers
        into transition scopes. Add <code>register: 'indicator'</code> and a
        boundary above shows a busy state while the run is in flight, holding the
        previous value.
      </p>

      <docs-section title="The task" id="task">
        <p>
          The task named in <code>&#123; worker, task &#125;</code> is a function
          you exposed on the host with
          <code>createWorkerHost(&#123; tasks &#125;)</code>. It runs on the same
          worker that owns your stores, so a whole subsystem lives on one thread.
          There is no <code>eval</code>, so nothing changes under a strict CSP.
        </p>
        <docs-code [code]="named" lang="ts" />
      </docs-section>

      <docs-section title="Latest wins, and holding the value" id="latest">
        <p>
          When the input changes mid-run, the in-flight run is superseded and its
          result discarded, so the value never regresses. By default the previous
          value is held through the next run (<code>status</code> reports
          <code>'reloading'</code>) rather than flashing empty, because a
          <code>workerResource</code> is a derivation, not a one-shot fetch. Set
          <code>keepPrevious: false</code> to clear instead.
        </p>
        <docs-code [code]="control" lang="ts" />
        <p>
          <code>abort()</code> cancels the in-flight run and keeps the current
          value, moving <code>status</code> to <code>'local'</code>.
          <code>reload()</code> re-runs with the current input.
        </p>
      </docs-section>

      <docs-section title="Pausing" id="pausing">
        <p>
          Return <code>ctx.paused</code> from the input function to hold the
          current value and run nothing. Returning <code>undefined</code>
          disables the resource (idle). A resume to the same input does not
          re-run.
        </p>
        <docs-code [code]="paused" lang="ts" />
      </docs-section>

      <docs-section title="Transferables" id="transfer">
        <p>
          For large binary payloads, <code>transfer</code> moves an
          <code>ArrayBuffer</code> into the worker instead of cloning it, detached
          at the sender. It applies to a task's input.
        </p>
        <docs-code [code]="transferCode" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class WorkerResourceDoc {
  protected readonly basic = `import { signal } from '@angular/core';
import { workerResource } from '@mmstack/worker';

readonly n = signal(40);

readonly fib = workerResource(() => this.n(), {
  worker: this.worker,
  task: 'fib',
});

fib.value();     // Signal<number | undefined>, held through re-runs
fib.status();    // 'idle' | 'loading' | 'reloading' | 'resolved' | 'error' | 'local'
fib.isLoading();
fib.error();
fib.reload();
fib.abort();`;

  protected readonly named = `// runs the 'fib' task exposed by the connected worker host
const fib = workerResource(() => n(), { worker, task: 'fib' });`;

  protected readonly control = `const users = workerResource(() => query(), {
  worker,
  task: 'searchUsers',
  register: 'indicator',   // join a transition scope; boundary shows busy
  keepPrevious: true,      // default: hold the value while reloading
  equal: (a, b) => a.id === b.id, // an equal result emits no notification
});`;

  protected readonly paused = `const data = workerResource((ctx) => {
  if (!ready()) return ctx.paused;   // hold the current value, run nothing
  if (!id()) return undefined;       // idle, disabled
  return id();
}, { worker, task: 'load' });`;

  protected readonly transferCode = `import { transfer } from '@mmstack/worker';

const buffer = new Float64Array(1_000_000).buffer;
workerResource(() => transfer({ buffer }, [buffer]), { worker, task: 'process' });`;
}
