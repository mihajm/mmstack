import { Component, resource, signal } from '@angular/core';
import { MmOutcome, SuspenseBoundary } from '@mmstack/primitives';

type User = { id: string; name: string; role: string };

const DB: Record<string, User> = {
  ana: { id: 'ana', name: 'Ana Ruiz', role: 'Admin' },
  ben: { id: 'ben', name: 'Ben Cole', role: 'Editor' },
  cal: { id: 'cal', name: 'Cal Ito', role: 'Viewer' },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Component({
  selector: 'demo-outcome',
  imports: [SuspenseBoundary, MmOutcome],
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
        </mm-suspense>
      </div>
      <div>
        <p class="caption">*mmOutcome, the read holds the boundary</p>
        <mm-suspense class="card">
          <span placeholder class="muted">Loading…</span>
          <strong *mmOutcome="user; let u; error: failed; name: 'user'">
            {{ u?.name }}
          </strong>
          <ng-template #failed let-error let-retry="retry">
            <span class="muted">{{ error.message }}</span>
            <button type="button" (click)="retry?.()">Retry</button>
          </ng-template>
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
      color: var(--fg-muted, #6b7280);
      font-size: 0.85rem;
    }

    @media (max-width: 600px) {
      .compare {
        grid-template-columns: 1fr;
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
