import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createTimeState, injectCreateTimeState } from './time';

describe('Time Adapter', () => {
  describe('createTimeState (standalone)', () => {
    it('should initialize with time type and handle min/max on current day', () => {
      const now = new Date('2024-03-20T10:00:00Z');
      const min = new Date('2024-03-22T08:00:00Z'); // different day
      const max = new Date('2024-03-22T12:00:00Z'); // different day

      const state = createTimeState(now, {
        locale: 'en-US',
        min: () => min,
        max: () => max,
      });

      expect(state.value()).toEqual(now);
      expect(state.type).toBe('time');
      
      // Expected: min time should be same as 'min' BUT on the 'now' day
      expect(state.min()?.getFullYear()).toBe(now.getFullYear());
      expect(state.min()?.getMonth()).toBe(now.getMonth());
      expect(state.min()?.getDate()).toBe(now.getDate());
      expect(state.min()?.getHours()).toBe(min.getHours());
      
      // Expected: max time should be same as 'max' BUT on the 'now' day
      expect(state.max()?.getHours()).toBe(max.getHours());
    });
  });

  describe('injectCreateTimeState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate validation and localization', () => {
      TestBed.runInInjectionContext(() => {
        const createTime = injectCreateTimeState();
        const minVal = new Date('2024-03-20T08:00:00Z');
        const state = createTime<Date>(null, {
          label: () => 'Start Time',
          validation: () => ({ required: true, min: minVal }),
        });

        expect(state.error()).toBe('Start Time is required');
        
        const okVal = new Date('2024-03-20T10:00:00Z');
        state.value.set(okVal);
        expect(state.error()).toBe('');

        const tooEarly = new Date('2024-03-20T07:00:00Z');
        state.value.set(tooEarly);
        expect(state.error()).toBe('Must be after Mar 20, 2024');
      });
    });
  });
});
