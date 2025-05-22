import { createQuoteTranslation } from './quote.namespace';

// shape is typesafe (errors if you have missing or additional keys)
export default createQuoteTranslation('sl', {
  pageTitle: 'Znani Citati',
  greeting: 'Zdravo {name}!',
  detail: {
    authorLabel: 'Avtor',
  },
  errors: {
    minLength: 'Citat mora imeti vsaj {min} znakov.', // If original has variables, the translation must contain a subset of used variables (min 1)
  },
  stats:
    '{count, plural, =1 {# citat} =2 {# citata} few {# citati} other {# citatov}} na voljo', // also guarenteed for "complex" variables, so {count} must be used in this translation
});
