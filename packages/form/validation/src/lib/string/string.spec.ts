import { createEmailValidator, defaultEmailMessageFactory } from './email';
import {
  createIsStringValidator,
  defaultIsStringMessageFactory,
} from './is-string';
import {
  createMaxLengthValidator,
  defaultMaxLengthMessageFactory,
} from './max-chars';
import {
  createMinLengthValidator,
  defaultMinLengthMessageFactory,
} from './min-chars';
import {
  createPatternValidator,
  defaultPatternMessageFactory,
} from './pattern';
import {
  createTrimmedValidator,
  defaultTrimmedMessageFactory,
} from './trimmed';
import { createURIValidator, defaultURIMessageFactory } from './uri';

describe('String Validators', () => {
  describe('email', () => {
    const validatorFactory = createEmailValidator(defaultEmailMessageFactory);

    it('should return error for invalid email', () => {
      const validate = validatorFactory();
      expect(validate('invalid-email')).toBe('Must be a valid email');
      expect(validate('test@')).toBe('Must be a valid email');
      expect(validate('@test.com')).toBe('Must be a valid email');
    });

    it('should return empty string for valid email', () => {
      const validate = validatorFactory();
      expect(validate('test@example.com')).toBe('');
      expect(validate('user.name+tag@domain.co.uk')).toBe('');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory();
      expect(validate(null)).toBe('');
    });
  });

  describe('isString', () => {
    const validatorFactory = createIsStringValidator(
      defaultIsStringMessageFactory,
    );

    it('should return error if not a string', () => {
      const validate = validatorFactory();
      expect(validate(123 as any)).toBe('Must be a string');
      expect(validate({} as any)).toBe('Must be a string');
      expect(validate(true as any)).toBe('Must be a string');
    });

    it('should return empty string if it is a string', () => {
      const validate = validatorFactory();
      expect(validate('hello')).toBe('');
      expect(validate('')).toBe('');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory();
      expect(validate(null)).toBe('');
    });
  });

  describe('maxLength', () => {
    const validatorFactory = createMaxLengthValidator(
      defaultMaxLengthMessageFactory,
    );

    it('should return error if string is too long', () => {
      const validate = validatorFactory(5);
      expect(validate('123456')).toBe('Max 5 characters');
    });

    it('should return empty string if string is within length', () => {
      const validate = validatorFactory(5);
      expect(validate('12345')).toBe('');
      expect(validate('abc')).toBe('');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory(5);
      expect(validate(null)).toBe('');
    });
  });

  describe('minLength', () => {
    const validatorFactory = createMinLengthValidator(
      defaultMinLengthMessageFactory,
    );

    it('should return error if string is too short', () => {
      const validate = validatorFactory(3);
      expect(validate('12')).toBe('Min 3 characters');
    });

    it('should return empty string if string is long enough', () => {
      const validate = validatorFactory(3);
      expect(validate('123')).toBe('');
      expect(validate('abcd')).toBe('');
    });

    it('should return error for null if min > 0', () => {
      const validate = validatorFactory(3);
      expect(validate(null)).toBe('Min 3 characters');
    });
  });

  describe('pattern', () => {
    const validatorFactory = createPatternValidator(
      defaultPatternMessageFactory,
    );

    it('should return error if pattern does not match', () => {
      const validate = validatorFactory(/^[0-9]+$/);
      expect(validate('abc')).toBe('Must match pattern ^[0-9]+$');
    });

    it('should return empty string if pattern matches', () => {
      const validate = validatorFactory(/^[0-9]+$/);
      expect(validate('123')).toBe('');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory(/^[0-9]+$/);
      expect(validate(null)).toBe('');
    });
  });

  describe('trimmed', () => {
    const validatorFactory = createTrimmedValidator(
      defaultTrimmedMessageFactory,
    );

    it('should return error if leading or trailing whitespace', () => {
      const validate = validatorFactory();
      expect(validate(' hello')).toBe(
        'Cannot contain leading or trailing whitespace',
      );
      expect(validate('hello ')).toBe(
        'Cannot contain leading or trailing whitespace',
      );
      expect(validate(' hello ')).toBe(
        'Cannot contain leading or trailing whitespace',
      );
    });

    it('should return empty string if no leading or trailing whitespace', () => {
      const validate = validatorFactory();
      expect(validate('hello')).toBe('');
      expect(validate('hello world')).toBe('');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory();
      expect(validate(null)).toBe('');
    });
  });

  describe('uri', () => {
    const validatorFactory = createURIValidator(defaultURIMessageFactory);

    it('should return error for invalid URI', () => {
      const validate = validatorFactory();
      expect(validate('not-a-uri')).toBe('Must be a valid URI');
      expect(validate('http://')).toBe('Must be a valid URI');
    });

    it('should return empty string for valid URI', () => {
      const validate = validatorFactory();
      expect(validate('http://example.com')).toBe('');
      expect(validate('https://www.google.com/search?q=test')).toBe('');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory();
      expect(validate(null)).toBe('');
    });
  });
});
