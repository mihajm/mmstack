import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { connectWorker, workerResource, workerStore } from '@mmstack/worker';
import type { AppWorker } from './worker/demo.worker';

/**
 * Split-graph demo: the main thread renders, a real Web Worker owns state and computes.
 * - `counter` is a live read-only replica of a worker-owned store; `add()` routes a write to it.
 * - `stats` is a worker-side derivation mirrored read-only (rung 3).
 * - `fib` is a heavy task run on the worker via `workerResource` (rung 1) — the UI stays responsive.
 *
 * The `new Worker(new URL(...))` literal lives HERE in app code so the bundler emits the worker
 * chunk; on the server `connectWorker` no-ops and the template renders its "connecting" state.
 */
@Component({
  selector: 'mm-worker-example',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h1>@mmstack/worker — split-graph demo</h1>
      <p class="status" [class.live]="connected()">
        {{ connected() ? '● worker connected' : '○ connecting…' }}
      </p>

      <div class="grid">
        <article>
          <h2>Owned store (replica + routed writes)</h2>
          <p class="big" data-testid="counter">
            {{ counter.value()?.value ?? 0 }}
          </p>
          <div class="row">
            <button type="button" (click)="add(1)" data-testid="inc">+1</button>
            <button type="button" (click)="add(5)">+5</button>
            <button type="button" (click)="add(-1)">−1</button>
          </div>
          <p class="muted">
            history: [{{ counter.value()?.history?.join(', ') }}]
          </p>
        </article>

        <article>
          <h2>Published derivation (rung 3)</h2>
          @if (stats.hasValue()) {
            <dl data-testid="stats">
              <div>
                <dt>count</dt>
                <dd>{{ stats.value()?.count }}</dd>
              </div>
              <div>
                <dt>sum</dt>
                <dd>{{ stats.value()?.sum }}</dd>
              </div>
              <div>
                <dt>avg</dt>
                <dd>{{ stats.value()?.avg }}</dd>
              </div>
              <div>
                <dt>max</dt>
                <dd>{{ stats.value()?.max }}</dd>
              </div>
            </dl>
          } @else {
            <p class="muted">hydrating…</p>
          }
        </article>

        <article>
          <h2>Heavy task (rung 1)</h2>
          <label>
            fib(n), n =
            <input
              type="number"
              [value]="fibN()"
              (input)="fibN.set(+$any($event.target).value)"
              min="0"
              max="90"
            />
          </label>
          <p class="big" data-testid="fib">
            {{ fib.isLoading() ? '…' : (fib.value() ?? '—') }}
          </p>
          <p class="muted">status: {{ fib.status() }}</p>
        </article>
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
      font-family: system-ui, sans-serif;
      padding: 1.5rem;
      color: #1e293b;
    }
    h1 {
      font-size: 1.25rem;
    }
    .status {
      color: #94a3b8;
      font-variant-numeric: tabular-nums;
    }
    .status.live {
      color: #16a34a;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
    }
    article {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 1rem;
    }
    h2 {
      font-size: 0.9rem;
      color: #475569;
      margin-top: 0;
    }
    .big {
      font-size: 2rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      margin: 0.5rem 0;
    }
    .row {
      display: flex;
      gap: 0.5rem;
    }
    button,
    input {
      font: inherit;
      padding: 0.35rem 0.6rem;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      background: white;
      cursor: pointer;
    }
    input {
      width: 5rem;
      cursor: text;
    }
    .muted {
      color: #94a3b8;
      font-size: 0.85rem;
    }
    dl {
      margin: 0;
    }
    dl div {
      display: flex;
      justify-content: space-between;
      padding: 0.15rem 0;
    }
    dt {
      color: #64748b;
    }
    dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
  `,
})
export class WorkerExample {
  // typed against the worker's contract — keys, value types, and write-ability are all inferred
  private readonly worker = connectWorker<AppWorker>(
    () =>
      new Worker(new URL('./worker/demo.worker', import.meta.url), {
        type: 'module',
      }),
  );

  readonly connected = this.worker.connected;
  readonly counter = workerStore(this.worker, 'counter'); // → CounterState, writable (owned)
  readonly stats = workerStore(this.worker, 'stats'); // → Stats, read-only (published, no write())

  readonly fibN = signal(35);
  readonly fib = workerResource(() => this.fibN(), {
    worker: this.worker,
    task: 'fib',
  });

  add(n: number): void {
    this.counter.write((d) => {
      const next = (d.value() ?? 0) + n;
      d.value.set(next);
      d.history.set([...(d.history() ?? []), next]);
    });
  }
}
