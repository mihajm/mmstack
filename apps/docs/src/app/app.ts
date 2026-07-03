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
import { Link, TransitionRouterOutlet } from '@mmstack/router-core';
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
        >GitHub</a
      >
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
      color: var(--fg-muted);
      font-size: 0.925rem;
      text-decoration: none;
    }
  `,
})
export class App {
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

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
