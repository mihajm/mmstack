import { defaultIntegerMessageFactory, createIntegerValidator } from './integer';
import { defaultIsNumberMessageFactory, createIsNumberValidator } from './is-number';
import { defaultMaxMessageFactory, createMaxValidator } from './max';
import { defaultMinMessageFactory, createMinValidator } from './min';
import { defaultMultipleOfMessageFactory, createMultipleOfValidator } from './multiple-of';

describe('Number Validators', () => {
  describe('integer', () => {
    const validatorFactory = createIntegerValidator(defaultIntegerMessageFactory);

    it('should return error if not an integer', () => {
      const validate = validatorFactory();
      expect(validate(1.5)).toBe('Must be an integer');
    });

    it('should return empty string if it is an integer', () => {
      const validate = validatorFactory();
      expect(validate(10)).toBe('');
      expect(validate(-5)).toBe('');
      expect(validate(0)).toBe('');
    });

    it('should return empty string for null or undefined', () => {
      const validate = validatorFactory();
      expect(validate(null)).toBe('');
      expect(validate(undefined as any)).toBe('');
    });
  });

  describe('isNumber', () => {
    const validatorFactory = createIsNumberValidator(defaultIsNumberMessageFactory);

    it('should return error if not a number', () => {
      const validate = validatorFactory();
      expect(validate('123' as any)).toBe('Must be a number');
      expect(validate({} as any)).toBe('Must be a number');
      expect(validate(NaN)).toBe('Must be a number');
    });

    it('should return empty string if it is a number', () => {
      const validate = validatorFactory();
      expect(validate(123)).toBe('');
      expect(validate(0)).toBe('');
      expect(validate(-1.5)).toBe('');
    });

    it('should return empty string for null or undefined', () => {
      const validate = validatorFactory();
      expect(validate(null)).toBe('');
      expect(validate(undefined as any)).toBe('');
    });
  });

  describe('max', () => {
    const validatorFactory = createMaxValidator(defaultMaxMessageFactory);

    it('should return error if value is greater than max', () => {
      const validate = validatorFactory(10);
      expect(validate(11)).toBe('Must be at most 10');
    });

    it('should return empty string if value is at most max', () => {
      const validate = validatorFactory(10);
      expect(validate(10)).toBe('');
      expect(validate(9)).toBe('');
    });

    it('should return empty string for null or undefined', () => {
      const validate = validatorFactory(10);
      expect(validate(null)).toBe('');
      expect(validate(undefined as any)).toBe('');
    });
  });

  describe('min', () => {
    const validatorFactory = createMinValidator(defaultMinMessageFactory);

    it('should return error if value is less than min', () => {
      const validate = validatorFactory(10);
      expect(validate(9)).toBe('Must be at least 10');
    });

    it('should return empty string if value is at least min', () => {
      const validate = validatorFactory(10);
      expect(validate(10)).toBe('');
      expect(validate(11)).toBe('');
    });

    it('should return empty string for null or undefined', () => {
      const validate = validatorFactory(10);
      expect(validate(null)).toBe('');
      expect(validate(undefined as any)).toBe('');
    });
  });

  describe('multipleOf', () => {
    const validatorFactory = createMultipleOfValidator(defaultMultipleOfMessageFactory);

    it('should return error if value is not a multiple', () => {
      const validate = validatorFactory(5);
      expect(validate(7)).toBe('Must be a multiple of 5');
    });

    it('should return empty string if value is a multiple', () => {
      const validate = validatorFactory(5);
      expect(validate(10)).toBe('');
      expect(validate(0)).toBe('');
      expect(validate(-15)).toBe('');
    });

    it('should return empty string for null or undefined', () => {
      const validate = validatorFactory(5);
      expect(validate(null)).toBe('');
      expect(validate(undefined as any)).toBe('');
    });
  });
});
