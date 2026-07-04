import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  signal,
} from '@angular/core';
import { persistedStore } from '@mmstack/primitives';
import { del, get, set } from 'idb-keyval';

type Doc = { text: string; note: string };

const KEY = 'e2e-persisted';

/**
 * E2E surface for `persistedStore` against a REAL IndexedDB (via idb-keyval, dropped
 * straight in as the AsyncStore backend). The unit suite covers the semantics on an
 * in-memory fake; this exercises the actual browser storage, the async hydration flash,
 * and the version envelope + migration heal on disk (see
 * playground-e2e/src/persisted-store.spec.ts).
 *
 * Versioned at 2 so the e2e can seed a v1 record and prove `migrate` runs on boot.
 */
@Component({
  selector: 'mm-persisted-store-example',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>persistedStore</h2>
    <!-- client-only: the e2e gates interaction on it, SSR HTML has no store wired -->
    @if (ready()) {
      <p data-testid="ready">ready</p>
    }
    <p data-testid="hydrated">{{ p.hydrated() ? 'hydrated' : 'loading' }}</p>

    <input data-testid="text-input" value="" #input />
    <button data-testid="save" (click)="p.store.text.set(input.value)">
      save
    </button>
    <button data-testid="flush" (click)="p.flush()">flush</button>
    <button data-testid="clear" (click)="p.clear()">clear</button>

    <p data-testid="text">{{ p.store.text() }}</p>
    <p data-testid="note">{{ p.store.note() }}</p>
  `,
})
export class PersistedStoreExample {
  protected readonly ready = signal(false);

  protected readonly p = persistedStore<Doc>(
    { text: '', note: '' },
    {
      key: KEY,
      store: { get, set, del }, // idb-keyval satisfies AsyncStore directly
      version: 2,
      writeDebounceMs: 50,
      migrate: (data, from) => {
        const old = data as Partial<Doc>;
        return { text: old.text ?? '', note: `migrated from v${from}` };
      },
    },
  );

  constructor() {
    afterNextRender(() => this.ready.set(true));
  }
}
