import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createSearchState, injectCreateSearchState } from './search';

describe('Search Adapter', () => {
  describe('createSearchState (standalone)', () => {
    it('should initialize with query and request', () => {
      vi.useFakeTimers();
      const toRequest = vi.fn().mockImplementation((q) => q ? { url: `/users?q=${q}` } : undefined);
      const state = createSearchState(null, {
        toRequest: () => toRequest,
      });

      expect(state.query()).toBe('');
      expect(state.request()).toBeUndefined();
      
      state.query.set('Joh');
      vi.runAllTimers();
      
      expect(state.request()).toEqual({ url: '/users?q=Joh' });
      expect(toRequest).toHaveBeenCalledWith('Joh');
      vi.useRealTimers();
    });

    it('should handle onSelected callback', () => {
      const onSelected = vi.fn();
      const state = createSearchState(null, {
        toRequest: () => () => undefined,
        onSelected,
      });

      state.onSelected({ id: 1, name: 'Alice' } as any);
      expect(onSelected).toHaveBeenCalledWith({ id: 1, name: 'Alice' });
    });

    it('should identify selected object valueLabel', () => {
        const state = createSearchState({ id: 1, name: 'Alice' } as any, {
          toRequest: () => () => undefined,
          displayWith: () => (i: any) => i.name,
        });
        expect(state.valueLabel()).toBe('Alice');
    });
  });

  describe('injectCreateSearchState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate required validation for selected value', () => {
      TestBed.runInInjectionContext(() => {
        const createSearch = injectCreateSearchState();
        const state = createSearch(null, {
          label: () => 'Contact',
          toRequest: () => () => undefined,
          validation: () => ({ required: true }),
        });

        expect(state.error()).toBe('Contact is required');
        
        state.value.set({ id: 1 } as any);
        expect(state.error()).toBe('');
      });
    });
  });
});
