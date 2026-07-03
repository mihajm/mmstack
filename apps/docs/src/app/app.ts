import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  Component,
  computed,
  effect,
  inject,
  PLATFORM_ID,
} from '@angular/core';
import { RouterLinkActive } from '@angular/router';
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
  imports: [TransitionRouterOutlet, Link, RouterLinkActive, Logo],
  template: `
    <a class="skip-link" href="#main-content">Skip to content</a>
    <header class="site-header">
      <a mmLink="/" class="brand" aria-label="mmstack home">
        <docs-logo [size]="22" />
        <span>mmstack</span>
      </a>
      <nav aria-label="Primary">
        <a mmLink="/docs" routerLinkActive="active" ariaCurrentWhenActive="page"
          >Docs</a
        >
        <a
          mmLink="/updates"
          routerLinkActive="active"
          ariaCurrentWhenActive="page"
          >Updates</a
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
        <span aria-hidden="true">{{ icon() }}</span> {{ theme() }}
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
    <main id="main-content" tabindex="-1" class="content">
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

    @media (max-width: 760px) {
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
  `,
})
export class App {
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly menu = inject(DocsMenu);
  private readonly currentUrl = url();
  protected readonly isDocs = computed(() =>
    this.currentUrl().split(/[?#]/)[0].startsWith('/docs'),
  );

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

  protected cycleTheme() {
    this.theme.update((t) => THEME_CYCLE[t]);
  }
}
