import { Component } from '@angular/core';
import { mediaQuery } from '@mmstack/primitives';
import { Link } from '@mmstack/router-core';
import { Logo } from '../layout/logo';

type Pkg = {
  name: string;
  link: string;
  blurb: string;
  experimental?: boolean;
};

const PACKAGES: Pkg[] = [
  {
    name: '@mmstack/primitives',
    link: '/docs/primitives',
    blurb:
      'Signal utilities useful for any app; from simple sensors to deep/async reactivity.',
  },
  {
    name: '@mmstack/resource',
    link: '/docs/resource',
    blurb:
      'Data fetching with caching, retries & much more. Built on Angular resources & signals.',
  },
  {
    name: '@mmstack/router-core',
    link: '/docs/router-core',
    blurb:
      'Transitions, preloading, data-fetching & more, all declarative at the route-level.',
  },
  {
    name: '@mmstack/forms',
    link: '/docs/forms',
    blurb: 'Angular Signal Forms utilities.',
  },
  {
    name: '@mmstack/dnd',
    link: '/docs/dnd',
    blurb: 'Fine-grained reactive Drag and drop.',
  },
  {
    name: '@mmstack/translate',
    link: '/docs/translate',
    blurb: 'Feature-level i18n. Type-safe & fully reactive.',
  },
  {
    name: '@mmstack/di',
    link: '/docs/di',
    blurb: 'Dependency injection utilities.',
  },
  {
    name: '@mmstack/worker',
    link: '/docs/worker',
    blurb: 'Off-thread state & compute. A worker owns state, the UI reads a live replica.',
    experimental: true,
  },
  {
    name: '@mmstack/telemetry',
    link: '/docs/telemetry',
    blurb:
      'Signals-native telemetry. Spans, events, errors, metrics & logs to OTLP, PostHog or Sentry. Explicit, zone-free context.',
    experimental: true,
  },
  {
    name: '@mmstack/mesh',
    link: '/docs/mesh',
    blurb:
      'Multiplayer for signal stores. Sync a store across tabs, a worker, a relay or peers. Reads exactly like a local store.',
    experimental: true,
  },
];

@Component({
  selector: 'docs-landing',
  imports: [Link, Logo],
  template: `
    <section class="hero">
      <docs-logo [size]="52" />
      <h1>mmstack</h1>
      <p class="tagline">Reactive, type-safe libraries for Angular.</p>
      <p class="sub">
        Each library does one job and works on its own, and because they share
        the same signals foundation they compose cleanly when you combine them.
        Data fetching, routing, forms, i18n, drag and drop, and concurrent UI.
        Reach for the one you need, or the whole set. The site you are reading
        runs on them.
      </p>
      <div class="cta">
        <a mmLink="/docs" class="primary">Read the docs</a>
        <a mmLink="/updates">What's new</a>
      </div>
    </section>

    <section class="packages">
      <h2 class="kicker">Packages</h2>
      <div class="grid">
        @for (pkg of packages; track pkg.name) {
          <a
            [mmLink]="pkg.link"
            [preloadOn]="mobile() ? 'visible' : 'hover'"
            class="card"
          >
            <h3>
              {{ pkg.name }}
              @if (pkg.experimental) {
                <span class="badge">Experimental</span>
              }
            </h3>
            <p>{{ pkg.blurb }}</p>
          </a>
        }
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
      max-width: 64rem;
      margin: 0 auto;
      padding: 3.5rem 1.5rem 5rem;
    }

    .hero {
      text-align: center;
      padding: 1rem 0 3.5rem;
      color: var(--fg);
    }

    .hero docs-logo {
      color: var(--fg);
    }

    h1 {
      font-size: 3rem;
      margin: 1rem 0 0;
      letter-spacing: -0.03em;
    }

    .tagline {
      font-size: 1.3rem;
      margin: 0.75rem 0 0;
    }

    .sub {
      color: var(--fg-muted);
      max-width: 38rem;
      margin: 1rem auto 0;
    }

    .cta {
      display: flex;
      gap: 0.75rem;
      justify-content: center;
      margin-top: 2rem;
    }

    .cta a {
      padding: 0.55rem 1.25rem;
      border-radius: 2px;
      border: 1px solid var(--line);
      font-weight: 600;
      text-decoration: none;
    }

    .cta a.primary {
      background: var(--fg);
      border-color: var(--fg);
      color: var(--bg);
    }

    .cta a:hover {
      color: var(--accent);
    }

    .cta a.primary:hover {
      color: var(--bg);
      background: var(--accent);
      border-color: var(--accent);
    }

    .kicker {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--fg-muted);
      margin: 0 0 1rem;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
      gap: 1rem;
    }

    .card {
      display: block;
      border: 1px solid var(--line);
      border-radius: 2px;
      padding: 1.1rem 1.25rem;
      color: inherit;
      text-decoration: none;
      transition: border-color 120ms;
    }

    .card:hover {
      color: inherit;
      border-color: var(--accent);
    }

    .card:hover h3 {
      text-decoration: underline;
      text-decoration-color: var(--accent);
      text-decoration-thickness: 2px;
      text-underline-offset: 4px;
    }

    .card h3 {
      margin: 0 0 0.4rem;
      font-size: 0.95rem;
      font-family: var(--font-mono);
    }

    .card p {
      margin: 0;
      font-size: 0.9rem;
      color: var(--fg-muted);
    }

    .card h3 .badge {
      font-family: var(--font-sans, sans-serif);
      font-size: 0.6rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 0.1rem 0.4rem;
      margin-left: 0.4rem;
      border-radius: 999px;
      background: var(--warn-bg, #fef9c3);
      color: var(--warn-fg, #854d0e);
      vertical-align: middle;
    }
  `,
})
export class Landing {
  protected readonly packages = PACKAGES;
  protected readonly mobile = mediaQuery('(max-width: 760px)');
}
