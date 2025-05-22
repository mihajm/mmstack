import { type Routes } from '@angular/router';
import { QuoteComponent } from './quote.component';
import { resolveQuoteTranslations } from './quote.r';

// quote.routes.ts
export const QUOTE_ROUTES: Routes = [
  {
    component: QuoteComponent,
    path: 'quote',
    resolve: {
      resolveQuoteTranslations,
    },
  },
];
