import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  PLATFORM_ID,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { stored } from '@mmstack/primitives';
import { Link, TransitionRouterOutlet, url } from '@mmstack/router-core';
import { DocsMenu } from './layout/docs-menu';
import { Logo } from './layout/logo';

type ThemeSetting = 'auto' | 'light' | 'dark';

const THEME_CYCLE: Record<ThemeSetting, ThemeSetting> = {
  auto: 'light',
  light: 'dark',
  dark: 'auto',
};

const THEME_ICON: Record<ThemeSetting, string> = {
  auto: '◐',
  light: '☀',
  dark: '☾',
};

@Component({
  selector: 'docs-root',
  imports: [TransitionRouterOutlet, Link, Logo],
  host: { '(document:keydown.escape)': 'closeMenu()' },
  template: `
    <a class="skip-link" [href]="skipHref()" (click)="skipToContent($event)"
      >Skip to content</a
    >
    <header class="site-header">
      <a mmLink="/" class="brand" aria-label="mmstack home">
        <docs-logo [size]="22" />
        <span>mmstack</span>
      </a>
      <nav aria-label="Primary">
        <a
          mmLink="/docs"
          [class.active]="isDocs()"
          [attr.aria-current]="isDocs() ? 'page' : null"
          >Docs</a
        >
      </nav>
      <span class="spacer"></span>
      <button
        type="button"
        class="theme-toggle"
        (click)="cycleTheme()"
        [attr.aria-label]="'Theme: ' + theme() + '. Click to change.'"
        [title]="'Theme: ' + theme()"
      >
        <span aria-hidden="true">{{ icon() }}</span>
        <span class="theme-label">{{ theme() }}</span>
      </button>
      <a
        href="https://github.com/mihajm/mmstack"
        target="_blank"
        rel="noopener"
        class="gh"
        aria-label="GitHub repository (opens in a new tab)"
      >
        <svg
          class="gh-icon"
          viewBox="0 0 16 16"
          width="18"
          height="18"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
          />
        </svg>
        <span class="gh-label">GitHub</span>
      </a>
      @if (isDocs()) {
        <button
          #menuToggle
          type="button"
          class="menu-toggle"
          (click)="menu.toggle()"
          [attr.aria-expanded]="menu.open()"
          aria-controls="docs-nav"
          aria-label="Toggle documentation menu"
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            @if (menu.open()) {
              <path d="M6 6l12 12M18 6L6 18" />
            } @else {
              <path d="M4 7h16M4 12h16M4 17h16" />
            }
          </svg>
        </button>
      }
    </header>
    <main
      id="main-content"
      tabindex="-1"
      class="content"
      [class.locked]="menu.open()"
    >
      <mm-transition-outlet />
    </main>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100dvh;
      overflow: hidden;
    }

    .content {
      flex: 1 1 auto;
      overflow-y: auto;
      min-height: 0;
    }

    .content:focus {
      outline: none;
    }

    .skip-link {
      position: absolute;
      left: 0.75rem;
      top: -3rem;
      z-index: 20;
      padding: 0.5rem 0.9rem;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--line);
      border-radius: 2px;
      text-decoration: none;
      transition: top 120ms;
    }

    .skip-link:focus {
      top: 0.75rem;
    }

    .site-header {
      flex: 0 0 var(--header-h);
      z-index: 10;
      display: flex;
      align-items: center;
      gap: 1.25rem;
      padding: 0 1.25rem;
      background: var(--bg);
      border-bottom: 1px solid var(--line);
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.55rem;
      font-weight: 650;
      font-size: 1.05rem;
      letter-spacing: -0.01em;
      color: var(--fg);
      text-decoration: none;
    }

    nav {
      display: flex;
      gap: 1rem;
    }

    nav a {
      color: var(--fg-muted);
      font-size: 0.925rem;
      text-decoration: none;
    }

    nav a.active {
      color: var(--fg);
      text-decoration: underline;
      text-decoration-color: var(--accent);
      text-decoration-thickness: 2px;
      text-underline-offset: 6px;
    }

    nav a:hover,
    .brand:hover,
    .gh:hover {
      color: var(--fg);
    }

    .spacer {
      flex: 1;
    }

    .theme-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.8rem;
      line-height: 1;
      padding: 0.4rem 0.6rem;
      background: none;
      color: var(--fg-muted);
      border: 1px solid var(--line);
      border-radius: 2px;
      cursor: pointer;
      text-transform: capitalize;
      font-variant-numeric: tabular-nums;
    }

    .theme-toggle:hover {
      color: var(--fg);
    }

    .gh {
      display: inline-flex;
      align-items: center;
      color: var(--fg-muted);
      font-size: 0.925rem;
      text-decoration: none;
    }

    .gh-icon {
      display: none;
    }

    .menu-toggle {
      display: none;
      align-items: center;
      justify-content: center;
      padding: 0.3rem;
      background: none;
      color: var(--fg-muted);
      border: 1px solid var(--line);
      border-radius: 2px;
      cursor: pointer;
    }

    .menu-toggle:hover {
      color: var(--fg);
    }

    @media (max-width: 900px) {
      .site-header {
        gap: 0.85rem;
        padding: 0 0.85rem;
      }

      .gh-label {
        display: none;
      }

      .gh-icon {
        display: inline-flex;
      }

      .menu-toggle {
        display: inline-flex;
      }
    }

    @media (max-width: 400px) {
      .theme-label {
        display: none;
      }
    }

    @media (max-width: 900px) {
      /* the open drawer owns scrolling; the page behind it stays put */
      .content.locked {
        overflow: hidden;
      }
    }

    /* Touch: 44px hit areas. The text links grow their box with padding
       and give it back with a negative margin, so nothing moves. */
    @media (pointer: coarse) {
      .site-header {
        gap: 0.35rem;
      }

      .brand,
      nav a {
        padding: 0.6rem 0.4rem;
        margin: -0.6rem -0.4rem;
      }

      nav {
        margin-left: 0.75rem;
      }

      .theme-toggle,
      .gh,
      .menu-toggle {
        min-width: 44px;
        min-height: 44px;
        justify-content: center;
      }

      /* at 44px the hairline box reads as a stuck focus ring next to the bare
         GitHub icon; keep the hit area, drop the outline */
      .theme-toggle,
      .menu-toggle {
        border-color: transparent;
      }
    }

    @media (pointer: coarse) and (max-width: 400px) {
      .site-header {
        gap: 0.25rem;
        padding: 0 0.6rem;
      }

      nav {
        margin-left: 0.3rem;
      }
    }
  `,
})
export class App {
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly menu = inject(DocsMenu);
  private readonly menuToggle =
    viewChild<ElementRef<HTMLButtonElement>>('menuToggle');
  private readonly router = inject(Router);
  private readonly currentUrl = url();
  private readonly path = computed(() => this.currentUrl().split(/[?#]/)[0]);
  // From the matched route, not the URL: an unknown /docs/... path renders
  // the top-level 404, which has no docs shell.
  protected readonly isDocs = computed(() => {
    this.currentUrl();
    return (
      this.router.routerState.snapshot.root.firstChild?.routeConfig?.path ===
      'docs'
    );
  });
  protected readonly skipHref = computed(() => this.path() + '#main-content');

  protected readonly theme = stored<ThemeSetting>('auto', {
    key: 'mmstack-docs-theme',
    syncTabs: true,
    validate: (t) => t === 'auto' || t === 'light' || t === 'dark',
  });

  protected readonly icon = computed(() => THEME_ICON[this.theme()]);

  constructor() {
    // The inline script in index.html applies the stored theme before first
    // paint, so this only needs to keep the attribute in sync while the reader
    // toggles it. Browser only: the server DOM has no documentElement.dataset,
    // and 'auto' resolves through CSS (color-scheme: light dark) regardless.
    effect(() => {
      const theme = this.theme();
      if (this.isBrowser) {
        this.document.documentElement.setAttribute('data-theme', theme);
      }
    });
  }

  // Bare "#main-content" would resolve against <base href="/">, so move focus
  // here instead of navigating. Inside the docs, skip the sidebar too.
  protected skipToContent(event: Event) {
    event.preventDefault();
    const target =
      this.document.getElementById('docs-content') ??
      this.document.getElementById('main-content');
    target?.focus(); // and bring the start of the content into view
  }

  protected closeMenu() {
    if (!this.menu.open()) return;
    this.menu.close();
    this.menuToggle()?.nativeElement.focus();
  }

  protected cycleTheme() {
    this.theme.update((t) => THEME_CYCLE[t]);
  }
}
