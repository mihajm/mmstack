import { Component, input, resource, signal } from '@angular/core';
import {
  MmTransition,
  provideTransitionScope,
  registerResource,
} from '@mmstack/primitives';

type TabName = 'Overview' | 'Stats' | 'Activity';

const TABS: TabName[] = ['Overview', 'Stats', 'Activity'];

const CONTENT: Record<TabName, string[]> = {
  Overview: ['4 open milestones', '12 contributors', 'Last release: v22.4'],
  Stats: ['1.2k downloads/week', '98.4% test coverage', '0 open P1 issues'],
  Activity: ['feat: pointer engine', 'fix: injector passthrough', 'docs: v1'],
};

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

@Component({
  selector: 'demo-tab-panel',
  template: `
    @if (data.isLoading()) {
      <div class="panel loading">Loading {{ tab() }}…</div>
    } @else {
      <div class="panel">
        <h4>{{ tab() }}</h4>
        <ul>
          @for (line of data.value(); track line) {
            <li>{{ line }}</li>
          }
        </ul>
      </div>
    }
  `,
  styles: `
    .panel {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
      padding: 0.75rem 1rem;
      min-height: 7.5rem;
    }

    .panel.loading {
      display: grid;
      place-items: center;
      color: var(--fg-muted, #6b7280);
      background: var(--bg-soft, #f9fafb);
    }

    h4 {
      margin: 0 0 0.5rem;
    }

    ul {
      margin: 0;
      padding-left: 1.1rem;
    }

    li {
      font-size: 0.9rem;
    }
  `,
})
export class TabPanel {
  readonly tab = input.required<TabName>();

  // Registers into the nearest transition scope: inside *mmTransition that's the
  // incoming view's own scope, which is what the hold waits on.
  protected readonly data = registerResource(
    resource({
      params: () => this.tab(),
      loader: async ({ params }) => {
        await wait(650);
        return CONTENT[params];
      },
    }),
  );
}

@Component({
  selector: 'demo-transition-tabs',
  imports: [MmTransition, TabPanel],
  // Inert fallback scope so the un-held panel's registration has a home
  // (nothing reads it, which is the point of the comparison).
  providers: [provideTransitionScope()],
  template: `
    <div class="tabs" role="tablist">
      @for (t of tabs; track t) {
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="tab() === t"
          [class.active]="tab() === t"
          (click)="tab.set(t)"
        >
          {{ t }}
        </button>
      }
    </div>
    <div class="compare">
      <div>
        <p class="caption">Plain switch, flashes a loading state</p>
        <demo-tab-panel [tab]="tab()" />
      </div>
      <div>
        <p class="caption">*mmTransition, holds until ready</p>
        <ng-container *mmTransition="tab(); let t">
          <demo-tab-panel [tab]="t" />
        </ng-container>
      </div>
    </div>
  `,
  styles: `
    .tabs {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }

    .tabs button {
      padding: 0.35rem 0.85rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 999px;
      background: var(--bg, #fff);
      color: var(--fg-muted, #6b7280);
      font-size: 0.875rem;
      cursor: pointer;
    }

    .tabs button.active {
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

    @media (max-width: 600px) {
      .compare {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class TransitionTabsDemo {
  protected readonly tabs = TABS;
  protected readonly tab = signal<TabName>('Overview');
}
