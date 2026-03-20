import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createDateRangeState, injectCreateDateRangeState } from './date-range';

describe('DateRange Adapter', () => {
  describe('createDateRangeState (standalone)', () => {
    it('should initialize with date range children and handle min/max', () => {
      const initial = { start: new Date('2024-03-20'), end: new Date('2024-03-25') };
      const minVal = new Date('2024-03-18');
      const maxVal = new Date('2024-03-28');

      const state = createDateRangeState(initial, {
        locale: 'en-US',
        min: () => minVal,
        max: () => maxVal,
        start: { placeholder: () => 'From' },
        end: { placeholder: () => 'To' },
      });

      expect(state.value()).toEqual(initial);
      expect(state.type).toBe('date-range');
      
      expect(state.children().start.value()).toEqual(initial.start);
      expect(state.children().end.value()).toEqual(initial.end);
      expect(state.children().start.placeholder()).toBe('From');
      expect(state.children().end.placeholder()).toBe('To');
      
      expect(state.min()).toEqual(minVal);
      expect(state.max()).toEqual(maxVal);
    });

    it('should handle string min/max in standalone factory', () => {
        const state = createDateRangeState({ start: null, end: null }, {
            locale: 'en-US',
            min: () => '2024-03-20',
            max: () => '2024-03-30',
        });
        expect(state.min()).toBeInstanceOf(Date);
        expect(state.min()?.getFullYear()).toBe(2024);
        expect(state.max()?.getFullYear()).toBe(2024);
    });
  });

  describe('injectCreateDateRangeState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate validation and derive range limits', () => {
      TestBed.runInInjectionContext(() => {
        const createDateRange = injectCreateDateRangeState();
        const minVal = new Date('2024-03-20');
        const state = createDateRange<Date>({ start: null, end: null }, {
          label: () => 'Stay',
          validation: () => ({ required: true, min: minVal }),
        });

        expect(state.error()).toBe('Stay is required');
        expect(state.min()).toEqual(minVal);
        
        state.value.set({ start: new Date('2024-03-21'), end: new Date('2024-03-25') });
        expect(state.error()).toBe('');
      });
    });

    it('should synchronize children value changes to group value', () => {
        TestBed.runInInjectionContext(() => {
            const createDateRange = injectCreateDateRangeState();
            const state = createDateRange<Date>({ start: null, end: null });
            
            const startVal = new Date('2024-03-20');
            state.children().start.value.set(startVal);
            
            expect(state.value().start).toEqual(startVal);
            expect(state.value().end).toBeNull();
        });
    });
  });
});
