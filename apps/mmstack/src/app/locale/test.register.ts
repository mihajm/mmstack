import { registerNamespace } from '@mmstack/translate';

const r = registerNamespace(
  () => import('./test.namespace').then((m) => m.default),
  {
    'sl-SI': () => import('./test.sl').then((m) => m.default),
    'de-DE': () => import('./test.de').then((m) => m.default),
  },
);

export const injectTestT = r.injectNamespaceT;
export const resolveTestTranslation = r.resolveNamespaceTranslation;
