import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createAutocompleteState, injectCreateAutocompleteState } from './autocomplete';

describe('Autocomplete Adapter', () => {
  describe('createAutocompleteState (standalone)', () => {
    it('should filter options based on user input', () => {
      const state = createAutocompleteState('', {
        options: () => ['Apple', 'Banana', 'Cherry'],
      });

      expect(state.options()).toHaveLength(3);
      
      state.value.set('a'); // case insensitive match
      expect(state.options()).toHaveLength(2); // Apple, Banana
      expect(state.options().map(o => o.value)).toEqual(['Apple', 'Banana']);

      state.value.set('cher');
      expect(state.options()).toHaveLength(1);
      expect(state.options()[0].value).toBe('Cherry');
    });

    it('should respect custom displayWith for filtering', () => {
        const state = createAutocompleteState('', {
            options: () => ['a', 'b'],
            displayWith: () => (v) => `Prefix: ${v}`
        });

        state.value.set('prefix: a');
        expect(state.options()).toHaveLength(1);
        expect(state.options()[0].label()).toBe('Prefix: a');
        expect(state.options()[0].value).toBe('a');
    });
  });

  describe('injectCreateAutocompleteState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate string validation', () => {
      TestBed.runInInjectionContext(() => {
        const createAutocomplete = injectCreateAutocompleteState();
        const state = createAutocomplete('', {
          label: () => 'Color',
          validation: () => ({ required: true }),
        });

        expect(state.error()).toBe('Color is required');
        
        state.value.set('Red');
        expect(state.error()).toBe('');
      });
    });
  });
});
