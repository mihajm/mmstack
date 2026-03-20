import {
  createMustBeEmptyValidator,
  createMustBeValidator,
  defaultMustBeEmptyMessageFactory,
  defaultMustBeMessageFactory,
} from './must-be';
import { createNotValidator, defaultNotMessageFactory } from './not';
import {
  createNotOneOfValidator,
  defaultNotOneOfMessageFactory,
} from './not-one-of';
import { createOneOfValidator, defaultOneOfMessageFactory } from './one-of';
import {
  createRequiredValidator,
  defaultRequiredMessageFactory,
} from './required';

describe('General Validators', () => {
  describe('required', () => {
    const validatorFactory = createRequiredValidator(
      defaultRequiredMessageFactory,
    );

    it('should return error if value is empty string', () => {
      const validate = validatorFactory('Name');
      expect(validate('')).toBe('Name is required');
    });

    it('should return error if value is null', () => {
      const validate = validatorFactory('Name');
      expect(validate(null)).toBe('Name is required');
    });

    it('should return error if value is undefined', () => {
      const validate = validatorFactory('Name');
      expect(validate(undefined)).toBe('Name is required');
    });

    it('should return empty string if value is present', () => {
      const validate = validatorFactory('Name');
      expect(validate('John')).toBe('');
    });

    it('should return empty string if value is 0 (number)', () => {
      const validate = validatorFactory('Count');
      expect(validate(0)).toBe('');
    });

    it('should return empty string if value is false (boolean)', () => {
      const validate = validatorFactory('Active');
      expect(validate(false)).toBe('');
    });
  });

  describe('mustBe', () => {
    const validatorFactory = createMustBeValidator(defaultMustBeMessageFactory);

    it('should return error if value does not match', () => {
      const validate = validatorFactory('fixed', 'FIXED');
      expect(validate('other')).toBe('Must be FIXED');
    });

    it('should return empty string if value matches', () => {
      const validate = validatorFactory('fixed', 'FIXED');
      expect(validate('fixed')).toBe('');
    });

    it('should use Object.is by default', () => {
      const obj = { a: 1 };
      const validate = validatorFactory(obj, 'Object');
      expect(validate({ a: 1 })).toBe('Must be Object');
      expect(validate(obj)).toBe('');
    });

    it('should support custom matcher', () => {
      const validate = validatorFactory(
        'a',
        'A',
        (a, b) => a.toLowerCase() === b.toLowerCase(),
      );
      expect(validate('A')).toBe('');
      expect(validate('b')).toBe('Must be A');
    });
  });

  describe('mustBeEmpty', () => {
    const validatorFactory = createMustBeEmptyValidator(
      defaultMustBeEmptyMessageFactory,
    );

    it('should return error if value is not null', () => {
      const validate = validatorFactory();
      expect(validate('some')).toBe('Must be empty');
    });

    it('should return empty string if value is null', () => {
      const validate = validatorFactory();
      expect(validate(null)).toBe('');
    });
  });

  describe('not', () => {
    const validatorFactory = createNotValidator(defaultNotMessageFactory);

    it('should return error if value matches', () => {
      const validate = validatorFactory('secret', 'SECRET');
      expect(validate('secret')).toBe('Cannot be SECRET');
    });

    it('should return empty string if value does not match', () => {
      const validate = validatorFactory('secret', 'SECRET');
      expect(validate('other')).toBe('');
    });
  });

  describe('oneOf', () => {
    const validatorFactory = createOneOfValidator(defaultOneOfMessageFactory);

    it('should return error if value is not in the list', () => {
      const validate = validatorFactory(
        ['a', 'b'],
        (v) => v,
        (v) => v,
      );
      expect(validate('c')).toBe('Must be one of: a, b');
    });

    it('should return empty string if value is in the list', () => {
      const validate = validatorFactory(
        ['a', 'b'],
        (v) => v,
        (v) => v,
      );
      expect(validate('a')).toBe('');
    });

    it('should support custom label and identity', () => {
      const items = [
        { id: 1, name: 'First' },
        { id: 2, name: 'Second' },
      ];
      const validate = validatorFactory(
        items,
        (v) => v.name,
        (v) => v.id.toString(),
      );

      expect(validate({ id: 1, name: 'First' })).toBe('');
      expect(validate({ id: 3, name: 'Third' })).toBe(
        'Must be one of: First, Second',
      );
    });
  });

  describe('notOneOf', () => {
    const validatorFactory = createNotOneOfValidator(
      defaultNotOneOfMessageFactory,
    );

    it('should return error if value is in the list', () => {
      const validate = validatorFactory(
        ['admin', 'root'],
        (v) => v,
        (v) => v,
      );
      expect(validate('admin')).toBe('Cannot be one of: admin, root');
    });

    it('should return empty string if value is not in the list', () => {
      const validate = validatorFactory(
        ['admin', 'root'],
        (v) => v,
        (v) => v,
      );
      expect(validate('user')).toBe('');
    });
  });
});
