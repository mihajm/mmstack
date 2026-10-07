import { Component, resource, signal } from '@angular/core';
import {
  MmOutcome,
  MmRetryFailed,
  SuspenseBoundary,
} from '@mmstack/primitives';

type User = { id: string; name: string; role: string };

const DB: Record<string, User> = {
  ana: { id: 'ana', name: 'Ana Ruiz', role: 'Admin' },
  ben: { id: 'ben', name: 'Ben Cole', role: 'Editor' },
  cal: { id: 'cal', name: 'Cal Ito', role: 'Viewer' },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Component({
  selector: 'demo-outcome',
  imports: [SuspenseBoundary, MmOutcome, MmRetryFailed],
  template: `
    <div class="bar">
      @for (id of ids; track id) {
        <button
          type="button"
          [class.active]="selected() === id"
          (click)="selected.set(id)"
        >
          {{ id }}
        </button>
      }
      <label
        ><input
          type="checkbox"
          [checked]="failNext()"
          (change)="failNext.set($any($event.target).checked)"
        />
        next load fails</label
      >
    </div>
    <div class="compare">
      <div>
        <p class="caption">Plain read, the boundary never hears of it</p>
        <mm-suspense class="card">
          <span placeholder class="muted">Loading…</span>
          <!-- a plain resource throws from value() on error -->
          <strong>{{ user.hasValue() ? user.value().name : '' }}</strong>
          @if (user.status() === 'error') {
            <span class="muted"
              >Blank: the error never reached the boundary.</span
            >
          }
        </mm-suspense>
      </div>
      <div>
        <p class="caption">*mmOutcome, the read holds the boundary</p>
        <mm-suspense class="card">
          <span placeholder class="muted">Loading…</span>
          <p error class="muted">
            Could not load the user.
            <button type="button" mmRetryFailed>Retry</button>
          </p>
          <strong *mmOutcome="user; let u; name: 'user'">{{ u?.name }}</strong>
        </mm-suspense>
      </div>
    </div>
  `,
  styles: `
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1rem;
      font-size: 0.85rem;
    }

    .bar button {
      padding: 0.35rem 0.85rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 999px;
      background: var(--bg, #fff);
      color: var(--fg-muted, #6b7280);
      font: inherit;
      font-size: 0.85rem;
      cursor: pointer;
      text-transform: capitalize;
    }

    .bar button.active {
      background: var(--accent, #0969da);
      border-color: var(--accent, #0969da);
      color: var(--accent-fg, #fff);
    }

    .compare {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }

    .caption {
      margin: 0 0 0.5rem;
      font-size: 0.8rem;
      color: var(--fg-muted, #6b7280);
    }

    .card {
      display: block;
      min-height: 2.5rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
    }

    .muted {
      margin: 0;
      color: var(--fg-muted, #6b7280);
      font-size: 0.85rem;
    }

    .card button {
      font: inherit;
      font-size: 0.85rem;
    }

    @media (max-width: 600px) {
      .compare {
        grid-template-columns: 1fr;
      }
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
export class OutcomeDemo {
  protected readonly ids = Object.keys(DB);
  protected readonly selected = signal('ana');
  protected readonly failNext = signal(false);

  // Created above both boundaries, so no registration can reach them.
  protected readonly user = resource({
    params: () => this.selected(),
    loader: async ({ params }) => {
      await wait(800);
      if (this.failNext()) {
        this.failNext.set(false);
        throw new Error('Could not load the user');
      }
      return DB[params];
    },
  });
}
