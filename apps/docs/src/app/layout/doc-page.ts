import {
  booleanAttribute,
  Component,
  effect,
  inject,
  input,
} from '@angular/core';
import { Meta } from '@angular/platform-browser';

@Component({
  selector: 'docs-page',
  template: `
    <article>
      <header>
        <h1>
          {{ title() }}
          @if (experimental()) {
            <span class="badge">Experimental</span>
          }
        </h1>
        @if (lead()) {
          <p class="lead">{{ lead() }}</p>
        }
        @if (pkg()) {
          <p class="pkg">
            <code>{{ pkg() }}</code>
            <a
              [href]="'https://www.npmjs.com/package/' + pkg()"
              target="_blank"
              rel="noopener"
              >npm</a
            >
          </p>
        }
        @if (experimental()) {
          <p class="experimental-note">
            This package is experimental: the API may still change and it is not
            yet battle-tested in production. Pin a version and expect some churn.
          </p>
        }
      </header>
      <ng-content />
    </article>
  `,
  styles: `
    article {
      max-width: var(--content-w);
    }

    h1 {
      margin: 0 0 0.5rem;
      font-size: 2rem;
    }

    .badge {
      vertical-align: middle;
      margin-left: 0.6rem;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 0.15rem 0.5rem;
      border-radius: 999px;
      background: var(--warn-bg, #fef9c3);
      color: var(--warn-fg, #854d0e);
    }

    .experimental-note {
      margin: 0.75rem 0 0;
      font-size: 0.9rem;
      color: var(--fg-muted);
    }

    .lead {
      margin: 0;
      font-size: 1.1rem;
      color: var(--fg-muted);
    }

    .pkg {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin: 0.75rem 0 0;
      font-size: 0.9rem;
    }

    header {
      margin-bottom: 2rem;
      padding-bottom: 1.25rem;
      border-bottom: 1px solid var(--line);
    }
  `,
})
export class DocPage {
  readonly title = input.required<string>();
  readonly lead = input<string>();
  readonly pkg = input<string>();
  readonly experimental = input(false, { transform: booleanAttribute });

  private readonly meta = inject(Meta);

  constructor() {
    // Runs during prerender too, so each page ships its own description and
    // Open Graph tags in the static head, for search engines and AI crawlers.
    effect(() => {
      const title = this.title();
      const lead = this.lead();
      this.meta.updateTag({ property: 'og:title', content: `${title} • mmstack` });
      this.meta.updateTag({ property: 'og:type', content: 'article' });
      if (lead) {
        this.meta.updateTag({ name: 'description', content: lead });
        this.meta.updateTag({ property: 'og:description', content: lead });
      }
    });
  }
}

