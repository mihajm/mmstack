import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  signal,
} from '@angular/core';
import { mediaQuery } from '@mmstack/primitives';
import { injectNavItems, Link, url } from '@mmstack/router-core';

/**
 * Previous / next links at the foot of a docs page, following the sidebar
 * order. Reads the flattened nav and the current URL, both reactive, so it
 * updates on navigation without living inside the routed view.
 */
@Component({
  selector: 'docs-footer-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Link],
  template: `
    @if (prev() || next()) {
      <nav class="footer-nav" aria-label="Pagination">
        @if (prev(); as p) {
          <a
            class="page prev"
            [mmLink]="p.link()"
            [preloadOn]="mobile() ? 'visible' : 'hover'"
            (preloading)="prevReady.set(true)"
          >
            <span class="dir">
              Previous
              @if (prevReady()) {
                <span class="ready" aria-hidden="true">ready</span>
              }
            </span>
            <span class="title">{{ p.label() }}</span>
          </a>
        } @else {
          <span></span>
        }
        @if (next(); as n) {
          <a
            class="page next"
            [mmLink]="n.link()"
            [preloadOn]="mobile() ? 'visible' : 'hover'"
            (preloading)="nextReady.set(true)"
          >
            <span class="dir">
              @if (nextReady()) {
                <span class="ready" aria-hidden="true">ready</span>
              }
              Next
            </span>
            <span class="title">{{ n.label() }}</span>
          </a>
        }
      </nav>
    }
  `,
  styles: `
    .footer-nav {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      margin: 3rem 0 1rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--line);
    }

    .page {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      max-width: 48%;
      padding: 0.65rem 0.9rem;
      border: 1px solid var(--line);
      border-radius: 2px;
      text-decoration: none;
      color: inherit;
      transition: border-color 120ms;
    }

    .page:hover {
      border-color: var(--accent);
      color: inherit;
    }

    .page.next {
      text-align: right;
      margin-left: auto;
    }

    .dir {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-family: var(--font-mono);
      font-size: 0.7rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--fg-muted);
    }

    .next .dir {
      justify-content: flex-end;
    }

    .ready {
      color: var(--accent);
      letter-spacing: 0.06em;
    }

    .title {
      font-weight: 600;
      font-size: 0.95rem;
    }

    .page:hover .title {
      color: var(--accent);
    }
  `,
})
export class DocFooterNav {
  private readonly nav = injectNavItems('docs');
  private readonly currentUrl = url();

  protected readonly mobile = mediaQuery('(max-width: 760px)');
  protected readonly prevReady = signal(false);
  protected readonly nextReady = signal(false);

  constructor() {
    // This lives outside the routed outlet, so it persists across navigations.
    // Reset the preload indicators when the page (and its neighbors) change.
    effect(() => {
      this.currentUrl();
      this.prevReady.set(false);
      this.nextReady.set(false);
    });
  }

  private readonly flat = computed(() =>
    this.nav().flatMap((group) => group.children()),
  );

  private readonly index = computed(() => {
    const here = this.currentUrl().split(/[?#]/)[0];
    return this.flat().findIndex((item) => item.link() === here);
  });

  protected readonly prev = computed(() => {
    const i = this.index();
    return i > 0 ? this.flat()[i - 1] : null;
  });

  protected readonly next = computed(() => {
    const i = this.index();
    return i >= 0 && i < this.flat().length - 1 ? this.flat()[i + 1] : null;
  });
}
