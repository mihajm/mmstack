import { Component, resource, signal } from '@angular/core';
import { latest, use } from '@mmstack/primitives';

type User = { id: string; name: string; role: string };

const DB: Record<string, User> = {
  ana: { id: 'ana', name: 'Ana Ruiz', role: 'Admin' },
  ben: { id: 'ben', name: 'Ben Cole', role: 'Editor' },
  cal: { id: 'cal', name: 'Cal Ito', role: 'Viewer' },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Component({
  selector: 'demo-latest',
  template: `
    <div class="picker">
      @for (id of ids; track id) {
        <button
          type="button"
          [class.active]="selected() === id"
          (click)="selected.set(id)"
        >
          {{ id }}
        </button>
      }
    </div>

    <div class="compare">
      <div>
        <p class="caption">Reading the resource directly</p>
        <div class="card">
          @if (user.isLoading()) {
            <span class="muted">Loading…</span>
          } @else if (user.value(); as u) {
            <strong>{{ u.name }}</strong>
            <span class="muted">{{ u.role }}</span>
          }
        </div>
      </div>
      <div>
        <p class="caption">Through latest(), holds the last value</p>
        <div class="card" [class.busy]="user.isLoading()">
          @if (view(); as u) {
            <strong>{{ u.name }}</strong>
            <span class="muted">{{ u.role }}</span>
          }
          @if (user.isLoading()) {
            <span class="tag">updating</span>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    .picker {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }

    .picker button {
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

    .picker button.active {
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
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      min-height: 4rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
    }

    .card.busy {
      opacity: 0.7;
    }

    .muted {
      color: var(--fg-muted, #6b7280);
      font-size: 0.85rem;
    }

    .tag {
      position: absolute;
      top: 0.5rem;
      right: 0.75rem;
      font-size: 0.7rem;
      color: var(--fg-muted, #6b7280);
    }

    @media (max-width: 600px) {
      .compare {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class LatestDemo {
  protected readonly ids = Object.keys(DB);
  protected readonly selected = signal<string>('ana');

  protected readonly user = resource({
    params: () => this.selected(),
    loader: async ({ params }) => {
      await wait(700);
      return DB[params];
    },
  });

  // While the resource reloads, use() blocks and latest() returns the previous
  // user, so this panel never blinks to empty on selection change.
  protected readonly view = latest(() => use(this.user));
}
