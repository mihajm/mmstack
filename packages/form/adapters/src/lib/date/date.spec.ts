import { TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createDateState, injectCreateDateState } from './base-date';

describe('Date Adapter', () => {
  describe('createDateState (standalone)', () => {
    it('should initialize with date value and type', () => {
      const initialDate = new Date();
      const state = createDateState(initialDate, {
        locale: 'en-US',
      });
      expect(state.value()).toBe(initialDate);
      expect(state.type).toBe('date');
    });

    it('should respect min and max signals from standalone options', () => {
      const minDate = new Date('2025-01-01');
      const maxDate = new Date('2025-12-31');
      const state = createDateState(null, {
        locale: 'en-US',
        min: () => minDate,
        max: () => maxDate,
      });

      expect(state.min()?.getTime()).toBe(minDate.getTime());
      expect(state.max()?.getTime()).toBe(maxDate.getTime());
    });

    it('should parse string min/max in standalone options', () => {
        const state = createDateState(null, {
          locale: 'en-US',
          min: () => '2025-01-01',
        });
        expect(state.min()).toBeInstanceOf(Date);
        expect(state.min()?.getFullYear()).toBe(2025);
    });
  });

  describe('injectCreateDateState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          { provide: LOCALE_ID, useValue: 'en-US' },
          provideValidatorConfig(() => undefined),
        ],
      });
    });

    it('should derive min/max signals from validation options', () => {
      TestBed.runInInjectionContext(() => {
        const minVal = new Date('2024-01-01');
        const createDate = injectCreateDateState();
        const state = createDate(null, {
          validation: () => ({
            required: true,
            min: minVal,
          }),
        });

        expect(state.min()).toBe(minVal);
        expect(state.required()).toBe(true);
        expect(state.error()).toBe('Field is required'); // min skips null
      });
    });

    it('should handle localized error messages', () => {
        TestBed.runInInjectionContext(() => {
          const createDate = injectCreateDateState();
          const state = createDate(new Date('invalid'), {
            label: () => 'Start Date',
          });
          
          expect(state.error()).toBe('Must be a valid date');
        });
    });
  });
});
