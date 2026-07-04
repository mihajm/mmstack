import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { meshSync, webSocketTransport, type MeshSyncRef } from '@mmstack/mesh';
import { persist } from '@mmstack/primitives';
import { connectWorker, workerStore } from '@mmstack/worker';
import { del, get, set } from 'idb-keyval';
import type { MeshWorker } from './worker/mesh.worker';

/**
 * Worker + mesh + persistence, composed with NO bridge. Each page is one DEVICE: a real Web Worker
 * owns the graph off the main thread, and its main-side store is now a writable op-log endpoint, so
 * `meshSync` (sync to peers) and `persist` (durable to IndexedDB) attach as plain readers on the
 * same store. A persisted, meshed, worker-owned graph is just readers over one op stream.
 *
 * Query params drive the e2e: `writer`, `room`, `mesh=0` (no peer sync), `persist=1` (durable).
 * `upper` is a value the WORKER computes from the doc — when it updates on a device that only
 * received a remote edit, it proves the change traversed the worker.
 */
@Component({
  selector: 'mm-worker-mesh-example',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Worker + mesh + persist</h2>
    @if (mesh(); as m) {
      <p data-testid="status">{{ m.status() }}</p>
    }
    <p data-testid="connected">{{ connected() ? 'worker-live' : 'connecting' }}</p>

    <input data-testid="title-input" value="" #input />
    <button data-testid="save" (click)="setTitle(input.value)">save</button>

    <p data-testid="title">{{ doc.value()?.title ?? '' }}</p>
    <p data-testid="upper">{{ derived.value()?.upper ?? '' }}</p>
  `,
})
export class WorkerMeshExample {
  private readonly injector = inject(Injector);

  private readonly worker = connectWorker<MeshWorker>(
    () =>
      new Worker(new URL('./worker/mesh.worker', import.meta.url), {
        type: 'module',
      }),
  );

  protected readonly connected = this.worker.connected;
  protected readonly doc = workerStore(this.worker, 'doc'); // owned → writable op-log endpoint
  protected readonly derived = workerStore(this.worker, 'derived'); // worker-computed, read-only
  protected readonly mesh = signal<MeshSyncRef | null>(null);

  constructor() {
    afterNextRender(() => {
      const params = new URLSearchParams(location.search);
      const writer = params.get('writer') ?? 'anon';

      // reader 1: mesh to peers (attaches straight onto the worker-owned store)
      if (params.get('mesh') !== '0') {
        const room = params.get('room') ?? 'worker-mesh-e2e';
        const transport = webSocketTransport(
          `ws://${location.hostname}:4301/?writer=${writer}&kind=human`,
        );
        this.mesh.set(
          meshSync(this.doc.store, {
            room,
            writer,
            transport,
            injector: this.injector,
          }),
        );
      }

      // reader 2: durable to IndexedDB (same store) — persist observes the worker-owned store's
      // changes and writes them to disk, keyed per device
      if (params.get('persist') === '1') {
        persist(this.doc.store, {
          key: `wm-${writer}`,
          store: { get, set, del },
          injector: this.injector,
        });
      }
    });
  }

  protected setTitle(v: string): void {
    // a local edit routes through THIS device's worker; the readers fan it out to peers + disk
    void this.doc.write((d) => d.title.set(v));
  }
}
