import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createTextareaState, injectCreateTextareaState } from './textarea';

describe('Textarea Adapter', () => {
  describe('createTextareaState (standalone)', () => {
    it('should initialize with textarea rows', () => {
      const state = createTextareaState('initial', {
        rows: () => 5,
        minRows: () => 2,
        maxRows: () => 10,
      });

      expect(state.value()).toBe('initial');
      expect(state.rows()).toBe(5);
      expect(state.minRows()).toBe(2);
      expect(state.maxRows()).toBe(10);
      expect(state.type).toBe('textarea');
    });

    it('should clamp rows between min and max', () => {
      const state = createTextareaState('', {
        rows: () => 20,
        minRows: () => 3,
        maxRows: () => 10,
      });
      // Clamp to min if out of range
      expect(state.rows()).toBe(3);
    });
  });

  describe('injectCreateTextareaState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate string validation', () => {
      TestBed.runInInjectionContext(() => {
        const createTextarea = injectCreateTextareaState();
        const state = createTextarea('', {
          label: () => 'Comments',
          validation: () => ({ required: true, maxLength: 10 }),
        });

        expect(state.error()).toBe('Comments is required');
        
        state.value.set('A very long comment that exceeds ten');
        expect(state.error()).toBe('Max 10 characters');
      });
    });
  });
});
