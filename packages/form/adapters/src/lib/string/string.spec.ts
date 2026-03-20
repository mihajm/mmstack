import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createStringState, injectCreateStringState } from './base-string';

describe('String Adapter', () => {
  describe('createStringState (standalone)', () => {
    it('should initialize with default options', () => {
      const state = createStringState('initial');
      expect(state.value()).toBe('initial');
      expect(state.autocomplete()).toBe('off');
      expect(state.placeholder()).toBe('');
      expect(state.type).toBe('string');
    });

    it('should respect custom options', () => {
      const state = createStringState(null, {
        autocomplete: () => 'username',
        placeholder: () => 'Enter username',
        maxErrorHintLength: () => 10,
      });
      expect(state.autocomplete()).toBe('username');
      expect(state.placeholder()).toBe('Enter username');
    });

    it('should handle shortened hints and tooltips', () => {
        const hint = signal('');
        const state = createStringState('', {
            maxErrorHintLength: () => 5,
            hint: () => hint()
        });
        hint.set('Too long');
        expect(state.hint()).toBe('Too l...');
        expect(state.hintTooltip()).toBe('Too long');
    });
  });

  describe('injectCreateStringState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate validation rules automatically', () => {
      TestBed.runInInjectionContext(() => {
        const createString = injectCreateStringState();
        const state = createString('', {
          label: () => 'Name',
          validation: () => ({ required: true, minLength: 3 }),
        });

        expect(state.error()).toContain('Name is required');
        expect(state.error()).toContain('+1 issues');
        
        state.value.set('ab');
        expect(state.error()).toBe('Min 3 characters');

        state.value.set('abc');
        expect(state.error()).toBe('');
      });
    });

    it('should resolve complex merged errors into tooltip', () => {
      TestBed.runInInjectionContext(() => {
        const createString = injectCreateStringState();
        const state = createString('', {
          validation: () => ({ required: true, minLength: 10 }),
        });

        // Combined errors: "Field is required, +1 issues"
        expect(state.error()).toContain('Field is required' + ', +1 issues');
        expect(state.errorTooltip()).toContain('Field is required' + '\n' + 'Min 10 characters');
      });
    });

    it('should be required based on validation options', () => {
        TestBed.runInInjectionContext(() => {
          const createString = injectCreateStringState();
          const state = createString(null, {
            validation: () => ({ required: true })
          });
          expect(state.required()).toBe(true);
        });
    });
  });
});
