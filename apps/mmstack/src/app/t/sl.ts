import { createAppTranslation } from './ns';

export default createAppTranslation('sl-SI', {
  yay: 'Super',
  greeting: 'Hello, {name, select, one {yay} other {test}}!',
  required:
    '{label} je {gender, select, masculine {obvezen} feminine {obvezna} other {obvezno}}',
});
