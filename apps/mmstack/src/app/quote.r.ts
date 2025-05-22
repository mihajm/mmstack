import { registerNamespace } from '@mmstack/translate';

export const MAP = {
  // Map other locales to promise factories (dynamic imports)
  sl: () => import('./quote.sl').then((m) => m.default),
};

// Register the namespace
// Example: packages/quote/src/lib/quote.t.ts
const r = registerNamespace(
  () => import('./quote.namespace').then((m) => m.default), // Default locale's compiled translation (functions as fallback if no locale of type provided)
  MAP,
);

export const injectQuoteT = r.injectNamespaceT;
export const resolveQuoteTranslations = r.resolveNamespaceTranslation;
