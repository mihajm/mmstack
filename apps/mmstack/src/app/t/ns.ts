import {
  createNamespace,
  inferCompiledTranslationMap,
} from '@mmstack/translate';

const ns = createNamespace('app', {
  yay: 'test',
  greeting: 'Hello, {name, select, one {yay} other {test}}!',
});

export type AppTranslation = (typeof ns)['translation'];
export default ns.translation;
export const createAppTranslation = ns.createTranslation;

type tt = inferCompiledTranslationMap<typeof ns.translation>;
