import { TestBed } from '@angular/core/testing';
import { mediaQuery, prefersDarkMode, prefersReducedMotion } from './media-query';

describe('mediaQuery & preferences', () => {
  let addListenerMock: any;
  let matchesValue = false;

  beforeEach(() => {
    addListenerMock = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query) => ({
        matches: matchesValue,
        media: query,
        onchange: null,
        addEventListener: addListenerMock,
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    });
  });

  afterEach(() => {
    matchesValue = false;
  });

  it('should return initial matches value', () => {
    matchesValue = true;
    TestBed.runInInjectionContext(() => {
      const query = mediaQuery('(min-width: 600px)');
      expect(query()).toBe(true);
    });
  });

  it('should respond to media query change events', () => {
    TestBed.runInInjectionContext(() => {
      const query = mediaQuery('(min-width: 600px)');
      expect(query()).toBe(false);
      
      const listener = addListenerMock.mock.calls[0][1];
      listener({ matches: true } as MediaQueryListEvent);
      
      expect(query()).toBe(true);
    });
  });

  it('should provide prefersDarkMode wrapper', () => {
    TestBed.runInInjectionContext(() => {
      const query = prefersDarkMode();
      expect(query()).toBe(false);
      expect(window.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    });
  });

  it('should provide prefersReducedMotion wrapper', () => {
    TestBed.runInInjectionContext(() => {
      const query = prefersReducedMotion();
      expect(query()).toBe(false);
      expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    });
  });
});
