import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createChipsState, injectCreateChipsState } from './chips';

describe('Chips Adapter', () => {
  describe('createChipsState (standalone)', () => {
    it('should initialize with array value and query', () => {
      const state = createChipsState(['angular', 'nx'], {
        options: () => ['angular', 'nx', 'vitest', 'rxjs'],
        separatorCodes: () => [13, 188],
      });

      expect(state.value()).toEqual(['angular', 'nx']);
      expect(state.query()).toBe('');
      expect(state.type).toBe('chips');
      expect(state.separatorCodes()).toEqual([13, 188]);
    });

    it('should compute labeledValue summaries', () => {
        const state = createChipsState(['a', 'b'], {
            display: () => (v) => v.toUpperCase()
        });
        expect(state.labeledValue()).toEqual([
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' }
        ]);
    });

    it('should filter selectable options based on query signal', () => {
        const state = createChipsState([], {
            options: () => ['Apple', 'Banana', 'Cherry']
        });
        expect(state.options()).toHaveLength(3);
        
        state.query.set('ban');
        expect(state.options()).toHaveLength(1);
        expect(state.options()[0].value).toBe('Banana');
    });
  });

  describe('injectCreateChipsState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate array validation (minLength/maxLength)', () => {
      TestBed.runInInjectionContext(() => {
        const createChips = injectCreateChipsState();
        const state = createChips([], {
          label: () => 'Tags',
          validation: () => ({ minLength: 1 }),
        });

        expect(state.error()).toBe('Min 1 items');
        
        state.value.set(['tag1']);
        expect(state.error()).toBe('');
      });
    });
  });
});
