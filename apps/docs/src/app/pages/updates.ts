import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';

type Highlight = {
  pkg: string;
  link: string;
  items: string[];
};

type Entry = {
  month: string;
  lead: string;
  highlights: Highlight[];
};

const ENTRIES: Entry[] = [
  {
    month: 'July 2026',
    lead: 'The marquee wave. Drag and drop got its pointer engine, primitives got the *mmTransition directive and streaming resources, and this documentation site went live, built on the same libraries it documents.',
    highlights: [
      {
        pkg: '@mmstack/dnd',
        link: '/docs/dnd',
        items: [
          'New pointer engine. Sortable lists no longer depend on native HTML5 drag, so reordering stays smooth with FLIP animation and behaves the same on touch.',
          'reorderable() covers simple lists, drag handles, cross-list groups, nested lists, and horizontal axes from one controller.',
          'The native and pointer engines share one session and load lazily, so both work in an app and you only pay for the one you use.',
        ],
      },
      {
        pkg: '@mmstack/primitives',
        link: '/docs/primitives/transitions',
        items: [
          '*mmTransition holds the current view until the next one has loaded, so tab switches and value changes stop flashing a spinner.',
          'The deep store gained an operation log, a compact record of every change for replay, sync, and undo.',
        ],
      },
      {
        pkg: '@mmstack/resource',
        link: '/docs/resource/streaming',
        items: [
          'streamResource for Server-Sent Events and WebSockets, with the same status surface and automatic reconnection as a query.',
          'parse now runs through interceptors, and injector passthrough is fixed for queryResource and mutationResource.',
        ],
      },
      {
        pkg: '@mmstack/forms',
        link: '/docs/forms/change-tracking',
        items: [
          'changedValues and submitChanges: read the diff of a form, submit only what changed, and re-baseline on success.',
        ],
      },
      {
        pkg: '@mmstack/router-core',
        link: '/docs/router-core/transition-outlet',
        items: [
          'Tighter coordination with the concurrency layer, so route data and the transition outlet swap a route in one frame once its data settles.',
        ],
      },
      {
        pkg: '@mmstack/translate-tools',
        link: '/docs/translate/tooling',
        items: [
          'A new lint command, and the 1.0 release: exact-shape key checks, per-file imports that isolate failures, and skipped-file reporting.',
        ],
      },
    ],
  },
  {
    month: 'June 2026',
    lead: 'The build-out. The concurrency foundation landed, resource matured into a full data layer, router-core got the transition outlet, and the forms and dnd libraries were born.',
    highlights: [
      {
        pkg: '@mmstack/primitives',
        link: '/docs/primitives/transitions',
        items: [
          'The concurrency foundation: keepPrevious, latest and use, deferredValue, suspense boundaries, and per-element view transitions.',
          'Store gained opaque leaves, vivify for missing paths, extendStore overlays, and shape adaptation between arrays and records.',
          'A new pointer-drag sensor for building custom pointer gestures.',
        ],
      },
      {
        pkg: '@mmstack/resource',
        link: '/docs/resource',
        items: [
          'mutateAsync, clearQueue, declarative invalidates for any method with custom prefixes, infinite queries, and an auto-wired cache.',
        ],
      },
      {
        pkg: '@mmstack/router-core',
        link: '/docs/router-core/transition-outlet',
        items: [
          'The transition outlet and holdThroughNavigation, which hold the current view through a navigation until the next route settles.',
          'mmLink anchor-detection fixes, and no refetch of retained route data on unrelated navigations.',
        ],
      },
      {
        pkg: '@mmstack/forms',
        link: '/docs/forms',
        items: [
          'New library. Typed field metadata, reusable field compositions, and change tracking layered on Angular Signal Forms.',
        ],
      },
      {
        pkg: '@mmstack/di',
        link: '/docs/di',
        items: [
          'Lazy and async injection with injectLazy and injectAsync, plus a no-deps injectable signature.',
        ],
      },
      {
        pkg: '@mmstack/translate',
        link: '/docs/translate/tooling',
        items: [
          'translate-tools gained JSON import and export for round-tripping with translators, and registerNamespace got a cleaner shape.',
        ],
      },
      {
        pkg: '@mmstack/dnd',
        link: '/docs/dnd',
        items: [
          'New library. The native HTML5 engine, typed draggable and drop-target primitives, and the shared drag session.',
        ],
      },
    ],
  },
];

@Component({
  selector: 'docs-updates',
  imports: [Link],
  template: `
    <article>
      <p class="kicker">Updates</p>
      <h1>What's new</h1>
      <p class="lead">
        Release highlights across the stack, newest first. For the full detail,
        see the
        <a
          href="https://github.com/mihajm/mmstack/commits/master"
          target="_blank"
          rel="noopener"
          >commit history</a
        >.
      </p>

      @for (entry of entries; track entry.month) {
        <section>
          <h2>{{ entry.month }}</h2>
          <p class="entry-lead">{{ entry.lead }}</p>
          @for (h of entry.highlights; track h.pkg) {
            <div class="pkg-block">
              <h3>
                <a [mmLink]="h.link"
                  ><code>{{ h.pkg }}</code></a
                >
              </h3>
              <ul>
                @for (item of h.items; track item) {
                  <li>{{ item }}</li>
                }
              </ul>
            </div>
          }
        </section>
      }
    </article>
  `,
  styles: `
    article {
      max-width: var(--content-w);
      margin: 0 auto;
      padding: 2.5rem 1.5rem 4rem;
    }

    .kicker {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--fg-muted);
      margin: 0 0 0.5rem;
    }

    h1 {
      margin: 0 0 0.5rem;
      letter-spacing: -0.02em;
    }

    .lead {
      color: var(--fg-muted);
      margin: 0 0 2.5rem;
    }

    section + section {
      margin-top: 3rem;
    }

    h2 {
      border-bottom: 1px solid var(--line);
      padding-bottom: 0.5rem;
    }

    .entry-lead {
      color: var(--fg-muted);
    }

    .pkg-block {
      margin: 1.5rem 0;
    }

    h3 {
      margin: 0 0 0.5rem;
      font-size: 1rem;
    }

    h3 a {
      text-decoration: none;
    }

    h3 a:hover code {
      color: var(--accent);
    }

    li {
      margin: 0.35rem 0;
      font-size: 0.95rem;
    }
  `,
})
export class Updates {
  protected readonly entries = ENTRIES;
}
