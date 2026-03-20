import { LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { injectValidators, provideValidatorConfig } from './validators';
import { type Validators } from './validators';

describe('Validators Integration (@mmstack/form-validation)', () => {
  describe('injectValidators with defaults', () => {
    it('should return a default set of validators if none provided', () => {
      // TestBed is necessary for inject() calls
      TestBed.runInInjectionContext(() => {
        const validators: Validators = injectValidators();
        
        expect(validators).toBeDefined();
        expect(validators.general).toBeDefined();
        expect(validators.string).toBeDefined();
        expect(validators.number).toBeDefined();
        expect(validators.date).toBeDefined();
        expect(validators.array).toBeDefined();
        expect(validators.boolean).toBeDefined();
        expect(validators.file).toBeDefined();
      });
    });

    it('should produce a working required validator from default set', () => {
      TestBed.runInInjectionContext(() => {
        const validators = injectValidators();
        const validate = validators.general.required('Test');
        expect(validate('')).toBe('Test is required');
        expect(validate('OK')).toBe('');
      });
    });
  });

  describe('provideValidatorConfig', () => {
    it('should configure custom messages for a specific locale', () => {
      TestBed.configureTestingModule({
        providers: [
          { provide: LOCALE_ID, useValue: 'de-DE' },
          provideValidatorConfig((locale) => {
            if (locale === 'de-DE') {
              return {
                general: { required: (label = 'Feld') => `${label} ist erforderlich.` }
              };
            }
            return undefined;
          })
        ]
      });

      TestBed.runInInjectionContext(() => {
        const validators = injectValidators();
        const validate = validators.general.required('Vorname');
        expect(validate('')).toBe('Vorname ist erforderlich.');
      });
    });

    it('should fallback to defaults if custom message for specific validator is not provided', () => {
      TestBed.configureTestingModule({
        providers: [
          { provide: LOCALE_ID, useValue: 'en-US' },
          provideValidatorConfig(() => undefined) // empty custom factories
        ]
      });

      TestBed.runInInjectionContext(() => {
        const validators = injectValidators();
        const validate = validators.general.required('Name');
        expect(validate('')).toBe('Name is required');
      });
    });
  });

  describe('string.all() integration', () => {
    it('should combine multiple string validators correctly', () => {
      TestBed.runInInjectionContext(() => {
        const v = injectValidators();
        const validatorFn = v.string.all({
          required: true,
          minLength: 5,
          pattern: 'email'
        });

        // Test combined results
        const empty = validatorFn('');
        expect(empty).toContain('Field is required' + '::INTERNAL_MMSTACK_MERGE_DELIM::' + 'Min 5 characters' + '::INTERNAL_MMSTACK_MERGE_DELIM::' + 'Must be a valid email');

        const resolved = validatorFn.resolve(empty);
        expect(resolved.error).toBe('Field is required, +2 issues');
      });
    });

    it('should handle non-required string values', () => {
        TestBed.runInInjectionContext(() => {
          const v = injectValidators();
          const validatorFn = v.string.all({
            required: false,
            trimmed: true
          });
          
          expect(validatorFn(null)).toBe(''); // not required
          expect(validatorFn(' ')).toContain('Cannot contain leading or trailing whitespace');
        });
    });
  });

  describe('number.all() integration', () => {
    it('should combine numeric validators', () => {
      TestBed.runInInjectionContext(() => {
        const v = injectValidators();
        const validatorFn = v.number.all({
          required: true,
          min: 10,
          max: 20
        });

        expect(validatorFn(null)).toContain('Field is required');
        expect(validatorFn(5)).toContain('Must be at least 10');
        expect(validatorFn(25)).toContain('Must be at most 20');
        expect(validatorFn(15)).toBe('');
      });
    });
  });
});
