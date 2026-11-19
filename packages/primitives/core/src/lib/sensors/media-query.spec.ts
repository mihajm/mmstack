import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  mediaQuery,
  prefersDarkMode,
  prefersReducedMotion,
} from './media-query';

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
      })),
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
      expect(window.matchMedia).toHaveBeenCalledWith(
        '(prefers-color-scheme: dark)',
      );
    });
  });

  it('should provide prefersReducedMotion wrapper', () => {
    TestBed.runInInjectionContext(() => {
      const query = prefersReducedMotion();
      expect(query()).toBe(false);
      expect(window.matchMedia).toHaveBeenCalledWith(
        '(prefers-reduced-motion: reduce)',
      );
    });
  });

  describe('with a MediaQueryList event target', () => {
    let mql: EventTarget & { matches: boolean };
    let matchMedia: ReturnType<typeof vi.fn>;

    const change = (matches: boolean) => {
      mql.matches = matches;
      mql.dispatchEvent(Object.assign(new Event('change'), { matches }));
    };

    beforeEach(() => {
      mql = Object.assign(new EventTarget(), { matches: false });
      matchMedia = vi.fn(() => mql);
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: matchMedia,
      });
    });

    it('follows change events', () => {
      const q = TestBed.runInInjectionContext(() => mediaQuery('(x)'));
      change(true);
      expect(q()).toBe(true);
      change(false);
      expect(q()).toBe(false);
    });

    it('stops following after destroy', () => {
      const child = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      );
      const q = mediaQuery('(x)', { injector: child });
      child.destroy();
      change(true);
      expect(q()).toBe(false);
    });

    it('is false on the server and never queries', () => {
      mql.matches = true;
      TestBed.configureTestingModule({
        providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
      });
      const q = TestBed.runInInjectionContext(() => mediaQuery('(x)'));
      expect(q()).toBe(false);
      expect(matchMedia).not.toHaveBeenCalled();
    });

    it('is false when matchMedia is missing', () => {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: undefined,
      });
      const q = TestBed.runInInjectionContext(() => mediaQuery('(x)'));
      expect(q()).toBe(false);
    });
  });
});
