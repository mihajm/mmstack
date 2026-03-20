import { defaultMustBeTreFactory, createMustBeTrueValidator } from './must-be-true';

describe('Boolean Validators', () => {
  describe('mustBeTrue', () => {
    const validatorFactory = createMustBeTrueValidator(defaultMustBeTreFactory);

    it('should return error if value is false', () => {
      const validate = validatorFactory();
      expect(validate(false)).toBe('Must be true');
    });

    it('should return error if value is null or undefined', () => {
      const validate = validatorFactory();
      expect(validate(null as any)).toBe('Must be true');
      expect(validate(undefined as any)).toBe('Must be true');
    });

    it('should return empty string if it is true', () => {
      const validate = validatorFactory();
      expect(validate(true)).toBe('');
    });
  });
});
