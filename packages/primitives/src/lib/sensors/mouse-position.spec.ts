import { ElementRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { mousePosition } from './mouse-position';

describe('mousePosition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should track mouse movements with throttling', () => {
    TestBed.runInInjectionContext(() => {
      const pos = mousePosition({ throttle: 100 });
      
      expect(pos()).toEqual({ x: 0, y: 0 });

      // Simulate mousemove on window
      const mockEvent = new MouseEvent('mousemove', { clientX: 100, clientY: 200 });
      window.dispatchEvent(mockEvent);

      expect(pos.unthrottled()).toEqual({ x: 100, y: 200 });
      expect(pos()).toEqual({ x: 0, y: 0 }); // Since it's throttled and time hasn't passed

      vi.advanceTimersByTime(100);

      expect(pos()).toEqual({ x: 100, y: 200 }); // Now it should update
    });
  });

  it('should handle custom element target and page coordinate space', () => {
    TestBed.runInInjectionContext(() => {
      const el = document.createElement('div');
      const pos = mousePosition({ target: el, coordinateSpace: 'page', throttle: 0 });
      
      expect(pos()).toEqual({ x: 0, y: 0 });

      const mockEvent = new MouseEvent('mousemove');
      Object.defineProperty(mockEvent, 'pageX', { value: 300 });
      Object.defineProperty(mockEvent, 'pageY', { value: 400 });
      
      el.dispatchEvent(mockEvent);

      vi.advanceTimersByTime(0);

      expect(pos()).toEqual({ x: 300, y: 400 });
    });
  });

  it('should attach to a signal target once it resolves (viewChild pattern)', () => {
    TestBed.runInInjectionContext(() => {
      const el = document.createElement('div');
      const target = signal<ElementRef<HTMLDivElement> | null>(null);
      const pos = mousePosition({ target, throttle: 0 });

      expect(pos()).toEqual({ x: 0, y: 0 });

      target.set(new ElementRef(el));
      TestBed.tick(); // run the attach effect

      const mockEvent = new MouseEvent('mousemove', { clientX: 7, clientY: 9 });
      el.dispatchEvent(mockEvent);
      vi.advanceTimersByTime(0);

      expect(pos()).toEqual({ x: 7, y: 9 });
    });
  });
});
