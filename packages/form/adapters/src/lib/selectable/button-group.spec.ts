import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createButtonGroupState, injectCreateButtonGroupState } from './button-group';

describe('ButtonGroup Adapter', () => {
  describe('createButtonGroupState (standalone)', () => {
    it('should initialize with options', () => {
      const state = createButtonGroupState('a', {
        options: () => ['a', 'b', 'c'],
      });

      expect(state.value()).toBe('a');
      expect(state.options()).toHaveLength(3);
      expect(state.type).toBe('button-group');
    });

    it('should support object identification', () => {
        const items = [{ id: 1 }, { id: 2 }];
        const state = createButtonGroupState(items[0], {
            options: () => items,
            identify: () => (i) => i.id.toString()
        });
        expect(state.options()[0].id).toBe('1');
    });
  });

  describe('injectCreateButtonGroupState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate required validation', () => {
      TestBed.runInInjectionContext(() => {
        const createBtnGroup = injectCreateButtonGroupState();
        const state = createBtnGroup<string | null>(null, {
          label: () => 'Choice',
          options: () => ['a', 'b'],
          validation: () => ({ required: true }),
        } as any);

        expect(state.error()).toBe('Choice is required');
        
        state.value.set('a');
        expect(state.error()).toBe('');
      });
    });
  });
});
