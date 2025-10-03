import { createNamespace } from '@mmstack/translate';

const ns = createNamespace('test', {
  hello: 'Hello',
  name: 'Hello, {name}!',
});

export default ns.translation;

export type TestLocale = (typeof ns)['translation'];
export const createTestTranslation = ns.createTranslation;
