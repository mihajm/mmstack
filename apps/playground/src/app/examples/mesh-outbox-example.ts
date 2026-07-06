import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { meshSync, webSocketTransport, type MeshSyncRef } from '@mmstack/mesh';
import { store, type AsyncStore, type WritableSignalStore } from '@mmstack/primitives';

type Doc = { title: string };

// A localStorage-backed AsyncStore: persistent AND shared across tabs of the same origin, so the
// durable outbox (and its pinned origin) survives a reload and is visible to a second tab.
const localStorageStore: AsyncStore = {
  get: (k) => {
    const raw = localStorage.getItem(k);
    return raw === null ? undefined : JSON.parse(raw);
  },
  set: (k, v) => void localStorage.setItem(k, JSON.stringify(v)),
  del: (k) => void localStorage.removeItem(k),
};

/**
 * E2E surface for the durable outbox's cross-tab single-writer lock (`crossTab: 'queue'`). Two tabs
 * sharing one `outbox.key` contend for a Web Lock: the first is `live`, the second WAITS
 * (`connecting`) until the first closes, then takes over — proving one durable writer per key.
 * `writer` + `room` come from the query string.
 */
@Component({
  selector: 'mm-mesh-outbox-example',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Durable outbox — cross-tab lock</h2>
    @if (mesh(); as m) {
      <p data-testid="status">{{ m.status() }}</p>
    } @else {
      <p data-testid="status">booting</p>
    }
    <p data-testid="title">{{ store.title() }}</p>
    <button data-testid="write-title" (click)="store.title.set('title-by-' + writer)">
      write title
    </button>
  `,
})
export class MeshOutboxExample {
  private readonly injector = inject(Injector);
  protected writer = 'anon';
  protected readonly store: WritableSignalStore<Doc> = store<Doc>(
    { title: 'shared' },
    { injector: this.injector },
  );
  protected readonly mesh = signal<MeshSyncRef | null>(null);

  constructor() {
    afterNextRender(() => {
      const params = new URLSearchParams(location.search);
      this.writer = params.get('writer') ?? 'anon';
      const room = params.get('room') ?? 'outbox-room';
      const key = params.get('key') ?? 'outbox-demo';
      const transport = webSocketTransport(
        `ws://${location.hostname}:4301/?writer=${this.writer}&kind=human`,
      );
      this.mesh.set(
        meshSync(this.store, {
          room,
          writer: this.writer,
          transport,
          injector: this.injector,
          outbox: { key, store: localStorageStore, crossTab: 'queue' },
        }),
      );
    });
  }
}
