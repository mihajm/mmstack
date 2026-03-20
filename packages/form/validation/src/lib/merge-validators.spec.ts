import { defaultMergeMessage, mergeValidators, createMergeValidators } from './merge-validators';
import { type Validator } from './validator.type';

describe('mergeValidators', () => {
  describe('defaultMergeMessage', () => {
    it('should return empty strings for no errors', () => {
      const result = defaultMergeMessage([]);
      expect(result).toEqual({ error: '', tooltip: '' });
    });

    it('should return the error directly if there is only one short error', () => {
      const result = defaultMergeMessage(['Short error']);
      expect(result).toEqual({ error: 'Short error', tooltip: '' });
    });

    it('should truncate and add tooltip if one error is very long', () => {
      const longError = 'A'.repeat(70);
      const result = defaultMergeMessage([longError]);
      expect(result.error).toBe(longError.slice(0, 60) + '...');
      expect(result.tooltip).toBe(longError);
    });

    it('should combine multiple errors and add count', () => {
      const result = defaultMergeMessage(['Error 1', 'Error 2', 'Error 3']);
      expect(result.error).toBe('Error 1, +2 issues');
      expect(result.tooltip).toBe('Error 1\nError 2\nError 3');
    });

    it('should truncate first error if it is long in multiple errors case', () => {
      const longError = 'A'.repeat(50);
      const result = defaultMergeMessage([longError, 'Second error']);
      expect(result.error).toBe(longError.slice(0, 40) + '..., +1 issues');
      expect(result.tooltip).toBe(longError + '\nSecond error');
    });
  });

  describe('mergeValidators utility', () => {
    const required: Validator<string | null> = (v) => v ? '' : 'required';
    const min3: Validator<string | null> = (v) => v && v.length >= 3 ? '' : 'too short';

    it('should return an array of error messages', () => {
      const merged = mergeValidators(required, min3);
      expect(merged('')).toEqual(['required', 'too short']);
      expect(merged('ab')).toEqual(['too short']);
      expect(merged('abc')).toEqual([]);
    });

    it('should return empty array if no validators provided', () => {
      const merged = mergeValidators();
      expect(merged('anything')).toEqual([]);
    });
  });

  describe('createMergeValidators integration', () => {
    it('should create a function that joins errors with internal delimiter', () => {
      const merge = createMergeValidators();
      const required: Validator<string> = (v) => v ? '' : 'required';
      const min: Validator<string> = (v) => v.length > 2 ? '' : 'min';
      
      const validate = merge([required, min]);
      const result = validate('');
      
      expect(result).toContain('required');
      expect(result).toContain('::INTERNAL_MMSTACK_MERGE_DELIM::');
      expect(result).toContain('min');
    });

    it('should resolve the merged error using the merge function', () => {
      const merge = createMergeValidators();
      const validatorFn = merge([(v) => 'error1', (v) => 'error2']);
      const mergedError = validatorFn('anything');
      
      const resolved = validatorFn.resolve(mergedError);
      expect(resolved.error).toBe('error1, +1 issues');
      expect(resolved.tooltip).toBe('error1\nerror2');
    });

    it('should support custom merge function', () => {
      const customMerge = (errors: string[]) => errors.join(' | ');
      const merge = createMergeValidators(customMerge);
      const validatorFn = merge([(v) => 'e1', (v) => 'e2']);
      
      const resolved = validatorFn.resolve(validatorFn('test'));
      expect(resolved.error).toBe('e1 | e2');
    });
  });
});
