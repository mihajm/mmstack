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

// Stand-in for genuinely expensive work. Every new filter blocks the main thread
// for about 250ms, however many rows match, so typing straight into the list is
// visibly sluggish and deferring it keeps the input responsive. Real apps get
// here honestly, with heavy component trees or charts.
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
      } @empty {
        <li class="none">No matches.</li>
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
      align-content: flex-start;
      gap: 6px;
      height: 8rem;
      overflow-y: auto;
    }

    .list li {
      padding: 4px 8px;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 999px;
      font-size: 0.8rem;
    }

    .list li.none {
      border: none;
      padding: 4px 0;
      color: var(--fg-muted, #6b7280);
    }
  `,
})
export class SlowList {
  readonly filter = input('');

  protected readonly visible = computed(() => {
    const q = this.filter().toLowerCase();
    burn(250);
    const matches = q ? ITEMS.filter((item) => item.includes(q)) : ITEMS;
    return matches.slice(0, 120);
  });

  protected render(item: string): string {
    burn(0.2); // a little per-row cost on top
    return item;
  }
}

@Component({
  selector: 'demo-deferred-value',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SlowList],
  template: `
    <label class="toggle">
      <input
        type="checkbox"
        [checked]="defer()"
        (change)="defer.set($any($event.target).checked)"
      />
      defer the list (untick it and type again to feel the difference)
    </label>

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
      <span
        >you typed: <code>{{ query() || '(empty)' }}</code></span
      >
      <span
        >list shows: <code>{{ shown() || '(empty)' }}</code></span
      >
      @if (defer() && deferred.pending()) {
        <span class="tag">catching up…</span>
      }
    </div>

    <div [class.stale]="defer() && deferred.pending()">
      <demo-slow-list [filter]="shown()" />
    </div>
  `,
  styles: `
    :host {
      display: block;
      max-width: 26rem;
    }

    .toggle {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      margin-bottom: 0.75rem;
      font-size: 0.8rem;
      color: var(--fg-muted, #6b7280);
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

    input[type='text'] {
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

    @media (pointer: coarse) {
      button,
      select,
      input:not([type='checkbox']) {
        min-height: 44px;
      }

      label:has(input[type='checkbox']) {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        min-height: 44px;
      }

      input[type='checkbox'] {
        width: 1.25rem;
        height: 1.25rem;
        margin: 0;
      }
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

  protected readonly defer = signal(true);
  protected readonly shown = computed(() =>
    this.defer() ? this.deferred() : this.query(),
  );

  protected onInput(event: Event) {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
