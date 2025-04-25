import { registerNamespace } from '@mmstack/translate';
import t from './ns';

const r = registerNamespace(t, {
  'sl-SI': () => {
    return import('./sl').then((m) => m.default);
  },
});

export const resolver = r.resolveNamespaceTranslation;

export const injectT = r.injectNamespaceT;
