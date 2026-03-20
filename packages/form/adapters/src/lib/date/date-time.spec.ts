import { TestBed } from '@angular/core/testing';
import { provideValidatorConfig } from '@mmstack/form-validation';
import { createDateTimeState, injectCreateDateTimeState } from './date-time';

describe('DateTime Adapter', () => {
  describe('createDateTimeState (standalone)', () => {
    it('should initialize with both date and time controls', () => {
      const initialDate = new Date('2024-03-20T10:00:00Z');
      const state = createDateTimeState(initialDate, {
        locale: 'en-US',
      });

      expect(state.value()).toEqual(initialDate);
      expect(state.type).toBe('datetime');
      
      expect(state.dateControl).toBeDefined();
      expect(state.timeControl).toBeDefined();
      expect(state.dateControl.value()).toBe(initialDate);
      expect(state.timeControl.value()).toBe(initialDate);
    });

    it('should synchronize values between controls', () => {
      const initialDate = new Date('2024-03-20T10:00:00Z');
      const state = createDateTimeState(initialDate, {
        locale: 'en-US',
      });

      const nextDate = new Date('2024-03-22T12:00:00Z');
      state.value.set(nextDate);
      
      expect(state.dateControl.value()).toBe(nextDate);
      expect(state.timeControl.value()).toBe(nextDate);
    });
  });

  describe('injectCreateDateTimeState (injected)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideValidatorConfig(() => undefined)],
      });
    });

    it('should integrate validation and children options', () => {
      TestBed.runInInjectionContext(() => {
        const createDateTime = injectCreateDateTimeState();
        const state = createDateTime<Date>(null, {
          label: () => 'Event',
          timeLabel: () => 'Event Time',
          validation: () => ({ required: true }),
        });

        expect(state.error()).toBe('Event is required');
        
        expect(state.dateControl.label()).toBe('Event');
        expect(state.timeControl.label()).toBe('Event Time');
        
        state.value.set(new Date('2024-03-20T10:00:00Z'));
        expect(state.error()).toBe('');
      });
    });
  });
});
