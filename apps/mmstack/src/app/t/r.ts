import { registerNamespace } from '@mmstack/translate';

const r = registerNamespace(() => import('./ns').then((m) => m.default), {
  'sl-SI': () => {
    return import('./sl').then((m) => m.default);
  },
});

export const resolver = r.resolveNamespaceTranslation;

export const injectT = r.injectNamespaceT;

const t = r.injectNamespaceT();
