import { createTestTranslation } from './test.namespace';

export default createTestTranslation('de-DE', {
  hello: 'Hallo!',
  name: 'Hallo, {name}!',
});
