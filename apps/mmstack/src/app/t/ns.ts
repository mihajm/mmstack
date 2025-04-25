import { createNamespace } from '@mmstack/translate';

const ns = createNamespace('app', {
  yay: 'yay',
  greeting: 'Hello, {name}!',
} as const);

export type AppTranslation = (typeof ns)['translation'];
export default ns.translation;
export const createAppTranslation = ns.createTranslation;
