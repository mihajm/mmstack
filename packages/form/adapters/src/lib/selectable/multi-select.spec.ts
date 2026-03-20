import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createMultiSelectState, injectCreateMultiSelectState } from './multi-select';

describe('MultiSelect Adapter', () => {
  describe('createMultiSelectState (standalone)', () => {
    it('should initialize with array value and type', () => {
      const state = createMultiSelectState(['a', 'b'], {
        options: () => ['a', 'b', 'c'],
      });

      expect(state.value()).toEqual(['a', 'b']);
      expect(state.type).toBe('multi-select');
    });

    it('should format valueLabel correctly (default joinLabel)', () => {
      const state = createMultiSelectState(['Apple', 'Banana', 'Cherry'], {
        options: () => ['Apple', 'Banana', 'Cherry', 'Date'],
      });

      expect(state.valueLabel()).toBe('Apple, +2');
    });

    it('should identify and display objects', () => {
      const items = [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }];
      const state = createMultiSelectState([items[0]], {
        options: () => items,
        identify: () => (i) => i.id.toString(),
        display: () => (i) => i.name,
      });

      expect(state.valueLabel()).toBe('One');
      expect(state.options()[0].id).toBe('1');
    });

    it('should detect individual option being selected via valueIds', () => {
        const state = createMultiSelectState(['a'], {
            options: () => ['a', 'b']
        });
        expect(state.options()[0].value).toBe('a');
        // Currently selected 'a', so it's not disabled if we were to toggle it?
        // Actually MultiSelectState.options() disabled signal:
        // if (valueIds().has(o.id)) return false;
        expect(state.options()[0].disabled()).toBe(false);
    });
  });

  describe('injectCreateMultiSelectState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate array validation (minLength/maxLength)', () => {
      TestBed.runInInjectionContext(() => {
        const createMulti = injectCreateMultiSelectState();
        const state = createMulti<string[]>([], {
          label: () => 'Choices',
          options: () => ['a', 'b', 'c'],
          validation: () => ({ minLength: 1, maxLength: 2 }),
        });

        expect(state.error()).toBe('Min 1 items');
        expect(state.required()).toBe(true);
        
        state.value.set(['a']);
        expect(state.error()).toBe('');

        state.value.set(['a', 'b', 'c']);
        expect(state.error()).toBe('Max 2 items');
      });
    });
  });
});
