import { createDateRangeValidators } from './date-range';
import { defaultIsDateMessageFactory, createIsDateValidator } from './is-date';
import { defaultMaxDateMessageFactory, createMaxDateValidator } from './max-date';
import { defaultMinDateMessageFactory, createMinDateValidator } from './min-date';
import { defaultToDate } from './util';

describe('Date Validators', () => {
  const toDate = defaultToDate;
  const formatDate = (d: Date) => d.toISOString().split('T')[0]; // Simple formatter for tests
  const locale = 'en-US';

  describe('util.toDate', () => {
    it('should convert string to date', () => {
      const d = defaultToDate('2023-01-01');
      expect(d.getFullYear()).toBe(2023);
      expect(d.getMonth()).toBe(0);
      expect(d.getDate()).toBe(1);
    });

    it('should convert number to date', () => {
      const now = Date.now();
      const d = defaultToDate(now);
      expect(d.getTime()).toBe(now);
    });

    it('should return the date if already a Date object', () => {
      const original = new Date();
      const d = defaultToDate(original);
      expect(d).toBe(original);
    });
  });

  describe('isDate', () => {
    const validatorFactory = createIsDateValidator(defaultIsDateMessageFactory, toDate);

    it('should return error if invalid date string', () => {
      const validate = validatorFactory();
      expect(validate('not-a-date')).toBe('Must be a valid date');
    });

    it('should return empty string if valid date', () => {
      const validate = validatorFactory();
      expect(validate('2023-01-01')).toBe('');
      expect(validate(new Date())).toBe('');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory();
      expect(validate(null)).toBe('');
    });
  });

  describe('maxDate', () => {
    const validatorFactory = createMaxDateValidator(defaultMaxDateMessageFactory, toDate, formatDate, locale);

    it('should return error if value is after max date', () => {
      const max = '2023-01-01';
      const validate = validatorFactory(max);
      expect(validate('2023-01-02')).toBe('Must be before 2023-01-01');
    });

    it('should return empty string if value is on or before max date', () => {
      const max = '2023-01-01';
      const validate = validatorFactory(max);
      expect(validate('2023-01-01')).toBe('');
      expect(validate('2022-12-31')).toBe('');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory('2023-01-01');
      expect(validate(null)).toBe('');
    });
  });

  describe('minDate', () => {
    const validatorFactory = createMinDateValidator(defaultMinDateMessageFactory, toDate, formatDate, locale);

    it('should return error if value is before min date', () => {
      const min = '2023-01-01';
      const validate = validatorFactory(min);
      expect(validate('2022-12-31')).toBe('Must be after 2023-01-01');
    });

    it('should return empty string if value is on or after min date', () => {
      const min = '2023-01-01';
      const validate = validatorFactory(min);
      expect(validate('2023-01-01')).toBe('');
      expect(validate('2023-01-02')).toBe('');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory('2023-01-01');
      expect(validate(null)).toBe('');
    });
  });

  describe('createDateRangeValidators', () => {
    const rangeValidators = createDateRangeValidators(undefined, toDate, formatDate);

    it('should validate start and end dates', () => {
      const validate = rangeValidators.all({ required: true });
      expect(validate({ start: null, end: null })).toContain('Field is required');
      expect(validate({ start: new Date(), end: new Date() })).toBe('');
    });

    it('should validate min and max for range', () => {
      const min = new Date('2023-01-01');
      const max = new Date('2023-12-31');
      const validate = rangeValidators.all({ min, max });

      expect(validate({ start: new Date('2022-01-01'), end: new Date('2023-06-01') })).toContain('Must be after 2023-01-01');
      expect(validate({ start: new Date('2023-06-01'), end: new Date('2024-01-01') })).toContain('Must be before 2023-12-31');
    });

    it('should ensure start is before or equal to end', () => {
      const validate = rangeValidators.all({});
      const invalidRange = { start: new Date('2023-02-01'), end: new Date('2023-01-01') };
      expect(validate(invalidRange)).toBeTruthy();
    });
  });
});
