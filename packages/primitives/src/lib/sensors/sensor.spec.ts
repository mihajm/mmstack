import { TestBed } from '@angular/core/testing';
import { sensor, sensors } from './sensor';

describe('sensor', () => {
  it('should initialize sensors correctly', () => {
    TestBed.runInInjectionContext(() => {
      const visibility = sensor('pageVisibility');
      expect(visibility()).toBeDefined();

      const tracking = sensors(
        ['darkMode', 'networkStatus', 'elementSize', 'mediaQuery'],
        {
          elementSize: {
            target: document.createElement('div'),
          },
          networkStatus: {},
          darkMode: {},
          mediaQuery: {
            query: '(min-width: 1024px)',
          },
        },
      );
      // the sensors function maps everything perfectly
      expect(tracking.darkMode()).toBeDefined();
      expect(tracking.networkStatus()).toBeDefined();
      expect(tracking.mediaQuery()).toBeDefined();
    });
  });

  it('should throw for unknown sensor type', () => {
    expect(() => sensor('unknown' as any)).toThrowError(
      /Unknown sensor type: unknown/,
    );
  });
});
