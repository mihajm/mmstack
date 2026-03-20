import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createNumberState, injectCreateNumberState } from './base-number';

describe('Number Adapter', () => {
  describe('createNumberState (standalone)', () => {
    it('should initialize with default options', () => {
      const state = createNumberState(10);
      expect(state.value()).toBe(10);
      expect(state.step()).toBe(1);
      expect(state.inputType()).toBe('number');
      expect(state.type).toBe('number');
    });

    it('should format localizedValue correctly (ISO default)', () => {
      const state = createNumberState(10.5);
      expect(state.localizedValue()).toBe(10.5);
    });

    it('should format localizedValue correctly (Custom comma separator)', () => {
      const state = createNumberState(10.5, {
        decimalSeparator: () => ',',
      });
      expect(state.localizedValue()).toBe('10,5');
      expect(state.inputType()).toBe('string');
    });

    it('should parse localized input via setLocalizedValue', () => {
      const state = createNumberState(0, {
        decimalSeparator: () => ',',
      });
      state.setLocalizedValue('12,34');
      expect(state.value()).toBe(12.34);

      state.setLocalizedValue('');
      expect(state.value()).toBeNull();
    });

    it('should handle increment/decrement via keydownHandler', () => {
      const state = createNumberState(10, {
        step: () => 5,
        decimalSeparator: () => ',', // keydownHandler is active only if NOT iso or complex
      });
      
      const handler = state.keydownHandler();
      const preventDefault = vi.fn();
      
      // ArrowUp
      handler({ code: 'ArrowUp', preventDefault, isTrusted: true } as any);
      expect(state.value()).toBe(15);
      expect(preventDefault).toHaveBeenCalled();

      // ArrowDown
      handler({ code: 'ArrowDown', preventDefault, isTrusted: true } as any);
      expect(state.value()).toBe(10);
    });
  });

  describe('injectCreateNumberState (injected)', () => {
    it('should use LOCALE_ID for decimal separator if localizeDecimal is true', () => {
      TestBed.configureTestingModule({
        providers: [
          { provide: LOCALE_ID, useValue: 'de-DE' }, // German uses comma
          provideValidatorConfig(() => undefined),
        ],
      });

      TestBed.runInInjectionContext(() => {
        const createNumber = injectCreateNumberState();
        const state = createNumber(1.2, {
          localizeDecimal: () => true,
        });

        expect(state.localizedValue()).toBe('1,2');
        expect(state.inputType()).toBe('string');
      });
    });

    it('should integrate validation and resolve errors', () => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });

      TestBed.runInInjectionContext(() => {
        const createNumber = injectCreateNumberState();
        const state = createNumber(5, {
          validation: () => ({ min: 10, max: 20 }),
        });

        expect(state.error()).toBe('Must be at least 10');
        
        state.value.set(25);
        expect(state.error()).toBe('Must be at most 20');

        state.value.set(15);
        expect(state.error()).toBe('');
      });
    });
  });
});
