import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createSelectState, injectCreateSelectState } from './select';

describe('Select Adapter', () => {
  describe('createSelectState (standalone)', () => {
    it('should initialize with options', () => {
      const state = createSelectState('a', {
        options: () => ['a', 'b', 'c'],
      });

      expect(state.value()).toBe('a');
      expect(state.valueLabel()).toBe('a');
      expect(state.options()).toHaveLength(3);
      expect(state.options()[0].label()).toBe('a');
      expect(state.type).toBe('select');
    });

    it('should identify and display objects', () => {
      const users = [
        { id: '1', name: 'Alice' },
        { id: '2', name: 'Bob' },
      ];
      const state = createSelectState(users[0], {
        options: () => users,
        identify: () => (u) => u.id,
        display: () => (u) => u.name,
      });

      expect(state.valueLabel()).toBe('Alice');
      expect(state.options()).toHaveLength(2);
      expect(state.options()[1].label()).toBe('Bob');
      expect(state.options()[1].id).toBe('2');
    });

    it('should ensure current value is present in options even if not in source', () => {
      const state = createSelectState('external', {
        options: () => ['a', 'b'],
      });

      expect(state.options()).toHaveLength(3);
      expect(state.options()).toContainEqual(
        expect.objectContaining({ value: 'external', label: expect.anything() })
      );
    });

    it('should accurately report disabled state for options', () => {
      const disabled = signal(false);
      const state = createSelectState('a', {
        options: () => ['a', 'b', 'c'],
        disableOption: () => (v) => v === 'b',
        disable: () => disabled(),
      });

      expect(state.options()[0].disabled()).toBe(false); // current value never disabled
      expect(state.options()[1].disabled()).toBe(true);  // as per disableOption
      expect(state.options()[2].disabled()).toBe(false);

      disabled.set(true);
      expect(state.options()[0].disabled()).toBe(false); // current value is still enabled for display but whole control is disabled
    });
  });

  describe('injectCreateSelectState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate required validation', () => {
      TestBed.runInInjectionContext(() => {
        const createSelect = injectCreateSelectState();
        const state = createSelect<string | null>(null, {
          label: () => 'Choice',
          options: () => ['a', 'b'],
          validation: () => ({ required: true }),
        });

        expect(state.error()).toBe('Choice is required');
        
        state.value.set('a');
        expect(state.error()).toBe('');
      });
    });
  });
});
