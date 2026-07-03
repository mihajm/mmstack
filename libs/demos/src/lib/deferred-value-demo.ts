import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import { deferredValue } from '@mmstack/primitives';

const WORDS = [
  'auth',
  'billing',
  'cache',
  'dashboard',
  'export',
  'filter',
  'gateway',
  'history',
  'invoice',
  'journal',
  'kanban',
  'ledger',
  'metrics',
  'notify',
  'orders',
  'profile',
  'queue',
  'report',
  'search',
  'tenant',
  'upload',
  'vault',
  'webhook',
];

const ITEMS = Array.from({ length: 400 }, (_, i) => {
  const word = WORDS[i % WORDS.length];
  return `${word}-${i}`;
});

// Stand-in for a genuinely expensive render. Each visible row burns a little
// main-thread time, so rendering the whole list is slow enough that deferring
// it keeps the input responsive. Real apps get here honestly, with heavy
// component trees or charts.
function burn(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // intentionally blocking
  }
}

@Component({
  selector: 'demo-slow-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="list">
      @for (item of visible(); track item) {
        <li>{{ render(item) }}</li>
      }
    </ul>
  `,
  styles: `
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      max-height: 8rem;
      overflow: hidden;
    }

    .list li {
      padding: 4px 8px;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 999px;
      font-size: 0.8rem;
    }
  `,
})
export class SlowList {
  readonly filter = input('');

  protected readonly visible = computed(() => {
    const q = this.filter().toLowerCase();
    const matches = q ? ITEMS.filter((item) => item.includes(q)) : ITEMS;
    return matches.slice(0, 120);
  });

  protected render(item: string): string {
    burn(0.7); // per-row cost
    return item;
  }
}

@Component({
  selector: 'demo-deferred-value',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SlowList],
  template: `
    <label class="field">
      <span>Filter</span>
      <input
        type="text"
        [value]="query()"
        (input)="onInput($event)"
        placeholder="type quickly…"
      />
    </label>

    <div class="readout">
      <span>you typed: <code>{{ query() || '(empty)' }}</code></span>
      <span>list shows: <code>{{ deferred() || '(empty)' }}</code></span>
      @if (deferred.pending()) {
        <span class="tag">catching up…</span>
      }
    </div>

    <div [class.stale]="deferred.pending()">
      <demo-slow-list [filter]="deferred()" />
    </div>
  `,
  styles: `
    :host {
      display: block;
      max-width: 26rem;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      font-size: 0.85rem;
    }

    .field span {
      color: var(--fg-muted, #6b7280);
    }

    input {
      padding: 0.5rem 0.65rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 6px;
      background: var(--bg, #fff);
      color: inherit;
      font: inherit;
    }

    .readout {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
      margin: 0.75rem 0 0.5rem;
      font-size: 0.8rem;
      color: var(--fg-muted, #6b7280);
    }

    .tag {
      color: var(--accent, #2456d6);
    }

    .stale {
      opacity: 0.5;
      transition: opacity 120ms;
    }
  `,
})
export class DeferredValueDemo {
  protected readonly query = signal('');

  // The input binds to query() and stays responsive. The expensive list binds
  // to deferred(), which holds its previous value and catches up when the main
  // thread goes idle, so typing never waits on the list and rapid keystrokes
  // coalesce into one catch-up. pending() is true while behind.
  protected readonly deferred = deferredValue(this.query, { strategy: 'idle' });

  protected onInput(event: Event) {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
