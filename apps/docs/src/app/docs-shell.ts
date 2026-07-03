import { Component } from '@angular/core';
import {
  injectNavItems,
  Link,
  TransitionRouterOutlet,
} from '@mmstack/router-core';
import { DocFooterNav } from './layout/doc-footer-nav';

@Component({
  selector: 'docs-shell',
  imports: [TransitionRouterOutlet, Link, DocFooterNav],
  template: `
    <div class="docs-layout">
      <aside>
        <nav aria-label="Documentation">
          @for (group of nav(); track group.id()) {
            <section>
              <p class="group-label">{{ group.label() }}</p>
              <ul>
                @for (item of group.children(); track item.id()) {
                  <li>
                    <a
                      [mmLink]="item.link()"
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
      <main>
        <mm-transition-outlet />
        <docs-footer-nav />
      </main>
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

    aside a.active {
      color: var(--fg);
      text-decoration: underline;
      text-decoration-color: var(--accent);
      text-decoration-thickness: 2px;
      text-underline-offset: 4px;
    }

    main {
      padding: 2rem 2.5rem 4rem;
    }

    @media (max-width: 760px) {
      .docs-layout {
        grid-template-columns: 1fr;
      }

      aside {
        position: static;
        height: auto;
        border-right: none;
        border-bottom: 1px solid var(--line);
      }
    }
  `,
})
export class DocsShell {
  protected readonly nav = injectNavItems('docs');
}
