import { TestBed } from '@angular/core/testing';
import { windowSize } from './window-size';

describe('windowSize', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should track window resize with throttle', () => {
    TestBed.runInInjectionContext(() => {
      const defaultSize = { width: window.innerWidth, height: window.innerHeight };
      const size = windowSize({ throttle: 100 });
      
      expect(size()).toEqual(defaultSize);

      Object.assign(window, { innerWidth: 1024, innerHeight: 768 });
      window.dispatchEvent(new Event('resize'));

      expect(size.unthrottled()).toEqual({ width: 1024, height: 768 });
      expect(size()).toEqual(defaultSize);

      vi.advanceTimersByTime(100);

      expect(size()).toEqual({ width: 1024, height: 768 });
    });
  });
});
