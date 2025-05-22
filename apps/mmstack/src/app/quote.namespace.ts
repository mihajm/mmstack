import { createNamespace } from '@mmstack/translate';

const ns = createNamespace('quote', {
  pageTitle: 'Famous Quotes',
  greeting: 'Hello {name}!',
  detail: {
    authorLabel: 'Author',
  },
  errors: {
    minLength: 'Quote must be at least {min} characters long.',
  },
  stats: '{count, plural, one {# quote} other {# quotes}} available',
});

export default ns.translation;

export type QuoteLocale = (typeof ns)['translation'];

export const createQuoteTranslation = ns.createTranslation;