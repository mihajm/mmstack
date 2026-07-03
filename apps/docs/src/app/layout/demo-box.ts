import { Component, input } from '@angular/core';

@Component({
  selector: 'docs-demo',
  template: `
    <figure>
      <figcaption>
        <span class="dot"></span>
        {{ title() }}
      </figcaption>
      <div class="body">
        <ng-content />
      </div>
    </figure>
  `,
  styles: `
    figure {
      margin: 1.25rem 0;
      border: 1px solid var(--line);
      border-radius: 2px;
      overflow: hidden;
    }

    figcaption {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--fg-muted);
      background: var(--bg-soft);
      border-bottom: 1px solid var(--line);
      padding: 0.45rem 1rem;
    }

    .dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: var(--accent);
    }

    .body {
      padding: 1.25rem;
      overflow-x: auto;
    }
  `,
})
export class DemoBox {
  readonly title = input('Live demo');
}
