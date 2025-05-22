import { Component, signal } from '@angular/core';
import { injectQuoteT } from './quote.r';

@Component({
  selector: 'app-quote',
  template: `
    quote
    <!-- Directive replaces innerHTML of el -->
    {{ stats() }}
  `,
})
export class QuoteComponent {
  protected readonly count = signal(0);
  private readonly t = injectQuoteT();

  protected readonly author = this.t('quote.detail.authorLabel'); // static translation

  protected readonly stats = this.t.asSignal('quote.stats', () => ({
    count: this.count(), // must be object with count parameter & type number
  }));
}
