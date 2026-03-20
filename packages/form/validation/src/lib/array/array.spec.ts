import { defaultMaxLengthMessageFactory, createMaxLengthValidator } from './max-length';
import { defaultMinLengthMessageFactory, createMinLengthValidator } from './min-length';

describe('Array Validators', () => {
  describe('maxLength', () => {
    const validatorFactory = createMaxLengthValidator(defaultMaxLengthMessageFactory);

    it('should return error if array is too long', () => {
      const validate = validatorFactory(2);
      expect(validate([1, 2, 3])).toBe('Max 2 items');
    });

    it('should return empty string if array is within length', () => {
      const validate = validatorFactory(2);
      expect(validate([1, 2])).toBe('');
      expect(validate([])).toBe('');
    });

    it('should return empty string for null or undefined', () => {
      const validate = validatorFactory(2);
      expect(validate(null)).toBe('');
      expect(validate(undefined as any)).toBe('');
    });

    it('should support custom label', () => {
      const validate = validatorFactory(2, 'elements');
      expect(validate([1, 2, 3])).toBe('Max 2 elements');
    });
  });

  describe('minLength', () => {
    const validatorFactory = createMinLengthValidator(defaultMinLengthMessageFactory);

    it('should return error if array is too short', () => {
      const validate = validatorFactory(2);
      expect(validate([1])).toBe('Min 2 items');
    });

    it('should return empty string if array is long enough', () => {
      const validate = validatorFactory(2);
      expect(validate([1, 2])).toBe('');
      expect(validate([1, 2, 3])).toBe('');
    });

    it('should return error for null or undefined if min > 0', () => {
      const validate = validatorFactory(2);
      expect(validate(null)).toBe('Min 2 items');
      expect(validate(undefined as any)).toBe('Min 2 items');
    });

    it('should support custom label', () => {
      const validate = validatorFactory(2, 'elements');
      expect(validate([1])).toBe('Min 2 elements');
    });
  });
});
