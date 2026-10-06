import { Component, input, resource, signal } from '@angular/core';
import {
  MmReveal,
  MmRetryFailed,
  registerResource,
  type RevealOnError,
  type RevealOrder,
  SuspenseBoundary,
} from '@mmstack/primitives';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Component({
  selector: 'demo-reveal-panel',
  template: `<strong>{{ label() }}</strong>
    <span class="muted">arrived after {{ data.value() }}ms</span>`,
  styles: `
    :host {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .muted {
      color: var(--fg-muted, #6b7280);
      font-size: 0.8rem;
    }
  `,
})
export class RevealPanel {
  readonly label = input.required<string>();
  readonly delay = input.required<number>();
  readonly fail = input(false);

  private attempts = 0;

  protected readonly data = registerResource(
    resource({
      params: () => this.delay(),
      loader: async ({ params }) => {
        await wait(params);
        // fails on the first attempt only, so a retry succeeds
        if (this.fail() && this.attempts++ === 0)
          throw new Error(`${this.label()} failed`);
        return params;
      },
    }),
    { suspends: true },
  );
}

const PANELS = [
  { label: 'Profile', delay: 1400 },
  { label: 'Feed', delay: 500 },
  { label: 'Suggestions', delay: 900 },
];

@Component({
  selector: 'demo-reveal',
  imports: [MmReveal, SuspenseBoundary, RevealPanel, MmRetryFailed],
  template: `
    <div class="bar">
      <label>
        order
        <select
          [value]="order()"
          (change)="order.set($any($event.target).value)"
        >
          <option value="forwards">forwards</option>
          <option value="backwards">backwards</option>
          <option value="together">together</option>
        </select>
      </label>
      <label>
        onError
        <select
          [value]="onError()"
          (change)="onError.set($any($event.target).value)"
        >
          <option value="settled">settled</option>
          <option value="blocks">blocks</option>
        </select>
      </label>
      <label
        ><input
          type="checkbox"
          [checked]="collapsed()"
          (change)="collapsed.set($any($event.target).checked)"
        />
        collapsed</label
      >
      <label
        ><input
          type="checkbox"
          [checked]="failFeed()"
          (change)="failFeed.set($any($event.target).checked)"
        />
        feed fails once</label
      >
      <button type="button" (click)="run.set(run() + 1)">Load again</button>
    </div>
    @for (r of [run()]; track r) {
      <mm-reveal
        [order]="order()"
        [onError]="onError()"
        [collapsed]="collapsed()"
      >
        @for (p of panels; track p.label) {
          <mm-suspense class="slot">
            <span placeholder class="muted">Loading {{ p.label }}…</span>
            <p error class="muted">
              {{ p.label }} failed. <button mmRetryFailed>Retry</button>
            </p>
            <demo-reveal-panel
              [label]="p.label"
              [delay]="p.delay"
              [fail]="failFeed() && p.label === 'Feed'"
            />
          </mm-suspense>
        }
      </mm-reveal>
    }
  `,
  styles: `
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
      font-size: 0.85rem;
    }

    .bar select,
    .bar button,
    .slot button {
      font: inherit;
      font-size: 0.85rem;
    }

    .slot {
      display: block;
      min-height: 1.5rem;
      margin-bottom: 0.5rem;
      padding: 0.6rem 1rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
    }

    .muted {
      margin: 0;
      color: var(--fg-muted, #6b7280);
      font-size: 0.85rem;
    }
  `,
})
export class RevealDemo {
  protected readonly panels = PANELS;
  protected readonly order = signal<RevealOrder>('forwards');
  protected readonly onError = signal<RevealOnError>('settled');
  protected readonly collapsed = signal(false);
  protected readonly failFeed = signal(false);
  protected readonly run = signal(0);
}
