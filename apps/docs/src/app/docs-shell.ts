import {
  afterNextRender,
  Component,
  effect,
  type ElementRef,
  inject,
  Injector,
  viewChild,
} from '@angular/core';
import { mediaQuery } from '@mmstack/primitives';
import {
  injectNavItems,
  Link,
  TransitionRouterOutlet,
  url,
} from '@mmstack/router-core';
import { DocFooterNav } from './layout/doc-footer-nav';
import { DocsMenu } from './layout/docs-menu';

@Component({
  selector: 'docs-shell',
  imports: [TransitionRouterOutlet, Link, DocFooterNav],
  template: `
    <div class="docs-layout">
      @if (menu.open()) {
        <button
          type="button"
          class="backdrop"
          (click)="menu.close()"
          aria-label="Close documentation menu"
        ></button>
      }
      <aside
        #aside
        id="docs-nav"
        [class.open]="menu.open()"
        [attr.inert]="mobile() && !menu.open() ? '' : null"
      >
        <nav aria-label="Documentation">
          @for (group of nav(); track group.id()) {
            <section>
              <p class="group-label">{{ group.label() }}</p>
              <ul>
                @for (item of group.children(); track item.id()) {
                  <li>
                    <a
                      [mmLink]="item.link()"
                      [preloadOn]="mobile() ? null : 'hover'"
                      [class.active]="item.active()"
                      [attr.aria-current]="item.active() ? 'page' : null"
                    >
                      {{ item.label() }}
                    </a>
                  </li>
                }
              </ul>
            </section>
          }
        </nav>
      </aside>
      <div id="docs-content" class="docs-main" tabindex="-1">
        <mm-transition-outlet />
        <docs-footer-nav />
      </div>
    </div>
  `,
  styles: `
    .docs-layout {
      display: grid;
      grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
      min-height: 100%;
    }

    aside {
      border-right: 1px solid var(--line);
      padding: 1.5rem 1rem;
      position: sticky;
      top: 0;
      align-self: start;
      max-height: calc(100dvh - var(--header-h));
      overflow-y: auto;
    }

    .group-label {
      margin: 0 0 0.35rem;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--fg-muted);
      font-family: var(--font-mono);
    }

    aside section + section {
      margin-top: 1.25rem;
    }

    aside ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    aside a {
      display: block;
      padding: 0.25rem 0.5rem;
      color: var(--fg-muted);
      font-size: 0.9rem;
      text-decoration: none;
    }

    aside a:hover {
      color: var(--fg);
    }

    @media (pointer: coarse) {
      aside a {
        padding-block: 0.65rem;
      }
    }

    aside a.active {
      color: var(--fg);
      text-decoration: underline;
      text-decoration-color: var(--accent);
      text-decoration-thickness: 2px;
      text-underline-offset: 4px;
    }

    .docs-main {
      min-width: 0;
      padding: 2rem 2.5rem 4rem;
    }

    .docs-main:focus {
      outline: none;
    }

    .backdrop {
      display: none;
    }

    @media (max-width: 900px) {
      .docs-layout {
        grid-template-columns: minmax(0, 1fr);
      }

      .docs-main {
        padding: 1.5rem 1.15rem 3rem;
      }

      /* Off-canvas drawer on the right, revealed by the header hamburger. */
      aside {
        position: fixed;
        top: var(--header-h);
        right: 0;
        bottom: 0;
        left: auto;
        /* the desktop align-self: start would shrink-wrap the fixed box and
           pin it to y=0 over the header */
        align-self: stretch;
        width: min(82vw, 20rem);
        max-height: none;
        overscroll-behavior: contain;
        padding: 1.25rem 1.15rem;
        background: var(--bg);
        border-right: none;
        border-left: 1px solid var(--line);
        transform: translateX(100%);
        transition: transform 200ms ease;
        z-index: 15;
      }

      aside.open {
        transform: translateX(0);
      }

      .backdrop {
        display: block;
        position: fixed;
        top: var(--header-h);
        inset: var(--header-h) 0 0;
        width: 100%;
        padding: 0;
        border: none;
        background: color-mix(in srgb, var(--fg) 28%, transparent);
        cursor: pointer;
        z-index: 14;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      aside {
        transition: none;
      }
    }
  `,
})
export class DocsShell {
  protected readonly nav = injectNavItems('docs');
  protected readonly menu = inject(DocsMenu);
  protected readonly mobile = mediaQuery('(max-width: 900px)');
  private readonly aside = viewChild<ElementRef<HTMLElement>>('aside');

  constructor() {
    const currentUrl = url();
    const injector = inject(Injector);
    // Keep the active link in view inside the sidebar (or the drawer when it
    // opens). Instant, and only the sidebar scrolls, never the page.
    effect(() => {
      currentUrl();
      this.menu.open();
      const aside = this.aside()?.nativeElement;
      if (!aside) return;
      afterNextRender(() => revealActive(aside), { injector });
    });
    // Close the drawer whenever the route changes (drawer link, footer nav,
    // or browser back), so it never lingers over the new page.
    effect(() => {
      currentUrl();
      this.menu.close();
    });
  }
}

function revealActive(aside: HTMLElement): void {
  const link = aside.querySelector<HTMLElement>('a.active');
  if (!link) return;
  const box = aside.getBoundingClientRect();
  const item = link.getBoundingClientRect();
  const pad = 48;
  if (item.top < box.top) aside.scrollTop += item.top - box.top - pad;
  else if (item.bottom > box.bottom)
    aside.scrollTop += item.bottom - box.bottom + pad;
}
