import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createBooleanState, injectCreateBooleanState } from './base-boolean';
import { createToggleState, injectCreateToggleState } from './toggle';

describe('Boolean Adapter', () => {
  describe('createBooleanState (standalone)', () => {
    it('should initialize with default options', () => {
      const state = createBooleanState(true);
      expect(state.value()).toBe(true);
      expect(state.type).toBe('boolean');
    });

    it('should respect custom options', () => {
      const state = createBooleanState(false, {
        label: () => 'Agree',
      });
      expect(state.label()).toBe('Agree');
    });
  });

  describe('injectCreateBooleanState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate requireTrue validation', () => {
      TestBed.runInInjectionContext(() => {
        const createBoolean = injectCreateBooleanState();
        const state = createBoolean(false, {
          label: () => 'Accept Terms',
          validation: () => ({ requireTrue: true }),
        });

        expect(state.error()).toBe('Must be true');
        
        state.value.set(true);
        expect(state.error()).toBe('');
      });
    });

    it('should be valid by default (no validation)', () => {
        TestBed.runInInjectionContext(() => {
          const createBoolean = injectCreateBooleanState();
          const state = createBoolean(false);
          expect(state.error()).toBe('');
        });
    });
  });

  describe('Toggle Adapter', () => {
      it('should initialize with toggle type', () => {
          const state = createToggleState(true);
          expect(state.type).toBe('toggle');
      });

      it('should integrate validation via injected factory', () => {
        TestBed.runInInjectionContext(() => {
            const createToggle = injectCreateToggleState();
            const state = createToggle(false, {
                validation: () => ({ requireTrue: true })
            });
            expect(state.error()).toBe('Must be true');
            expect(state.type).toBe('toggle');
        });
      });
  });
});
