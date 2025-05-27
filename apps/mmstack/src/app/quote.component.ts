import { Component, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import {
  MatFormField,
  MatInputModule,
  MatLabel,
} from '@angular/material/input';
import { MatTimepickerModule } from '@angular/material/timepicker';
import { isToday } from 'date-fns';
import { injectQuoteT } from './quote.r';

@Component({
  selector: 'app-quote',
  imports: [
    MatTimepickerModule,
    MatFormField,
    MatLabel,
    FormsModule,
    MatInputModule,
    MatButtonModule,
    MatDatepickerModule,
  ],
  template: ``,
})
export class QuoteComponent {
  protected readonly count = signal(0);
  private readonly t = injectQuoteT();

  time = signal<Date | null>(null);

  protected readonly author = this.t('quote.detail.authorLabel'); // static translation

  protected readonly stats = this.t.asSignal('quote.stats', () => ({
    count: this.count(), // must be object with count parameter & type number
  }));

  e = effect(() => {
    const t = this.time();
    if (!t) return;
    console.log(isToday(t));
  });
}
