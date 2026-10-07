import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'docs-section',
  imports: [RouterLink],
  // id and title are inputs; keep them off the host so the h2 owns the anchor
  host: { '[attr.id]': 'null', '[attr.title]': 'null' },
  template: `
    <section>
      <div class="heading">
        <h2 [id]="id()">{{ title() }}</h2>
        <!-- A router link, not a bare href: with <base href="/"> a plain
             "#id" would resolve against the site root. -->
        <a
          class="anchor"
          [routerLink]="[]"
          [fragment]="id()"
          queryParamsHandling="preserve"
          [attr.aria-label]="'Link to section ' + title()"
          >#</a
        >
      </div>
      <ng-content />
    </section>
  `,
  styles: `
    section {
      margin: 2.5rem 0;
    }

    .heading {
      position: relative;
      margin: 0 0 1rem;
    }

    h2 {
      font-size: 1.4rem;
      margin: 0;
    }

    .anchor {
      position: absolute;
      top: 0;
      left: -1.25rem;
      font-size: 1.4rem;
      line-height: 1.25;
      font-weight: 700;
      color: var(--fg-muted);
      text-decoration: none;
      opacity: 0;
      transition: opacity 120ms;
    }

    .heading:hover .anchor,
    .anchor:focus-visible {
      opacity: 1;
    }

    .anchor:hover {
      color: var(--accent);
    }

    /* Narrow columns have no gutter: put the anchor after the title. */
    @media (max-width: 900px) {
      .heading {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
      }

      h2 {
        min-width: 0;
      }

      .anchor {
        position: static;
        flex: none;
        padding: 0 0.25rem;
      }
    }

    /* No hover on touch screens, so keep it visible there, at full
       strength, with a padded target that doesn't move the glyph. */
    @media (hover: none) {
      .anchor {
        opacity: 1;
        padding: 0.5rem 0.6rem;
        margin: -0.5rem -0.6rem;
      }
    }
  `,
})
export class DocSection {
  readonly title = input.required<string>();
  readonly id = input.required<string>();
}
