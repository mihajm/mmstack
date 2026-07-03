import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';

@Component({
  selector: 'docs-not-found',
  imports: [Link],
  template: `
    <section>
      <h1>404</h1>
      <p>That page doesn't exist (or moved).</p>
      <p><a mmLink="/">Back to the start</a></p>
    </section>
  `,
  styles: `
    section {
      text-align: center;
      padding: 6rem 1rem;
    }

    h1 {
      font-size: 4rem;
      margin: 0;
    }

    p {
      color: var(--fg-muted);
    }
  `,
})
export class NotFound {}
