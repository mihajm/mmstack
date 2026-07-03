import { Component, input } from '@angular/core';

@Component({
  selector: 'docs-section',
  template: `
    <section>
      <h2 [id]="id()">
        <a class="anchor" [href]="'#' + id()">#</a>{{ title() }}
      </h2>
      <ng-content />
    </section>
  `,
  styles: `
    section {
      margin: 2.5rem 0;
    }

    h2 {
      font-size: 1.4rem;
      margin: 0 0 1rem;
    }

    .anchor {
      float: left;
      margin-left: -1.25rem;
      padding-right: 0.35rem;
      color: var(--fg-muted);
      opacity: 0;
      transition: opacity 120ms;
    }

    h2:hover .anchor {
      opacity: 1;
      text-decoration: none;
    }
  `,
})
export class DocSection {
  readonly title = input.required<string>();
  readonly id = input.required<string>();
}
