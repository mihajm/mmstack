import { hasSlowConnection } from './has-slow-connection';

describe('hasSlowConnection', () => {
  const originalNavigator = window.navigator;

  afterEach(() => {
    Object.defineProperty(window, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it('should return false when connection API is not available', () => {
    expect(hasSlowConnection()).toBe(false);
  });

  it('should return true for 2g connection', () => {
    Object.defineProperty(window, 'navigator', {
      value: {
        connection: { effectiveType: '2g' },
      },
      writable: true,
      configurable: true,
    });

    expect(hasSlowConnection()).toBe(true);
  });

  it('should return true for slow-2g connection', () => {
    Object.defineProperty(window, 'navigator', {
      value: {
        connection: { effectiveType: 'slow-2g' },
      },
      writable: true,
      configurable: true,
    });

    expect(hasSlowConnection()).toBe(true);
  });

  it('should return false for 4g connection', () => {
    Object.defineProperty(window, 'navigator', {
      value: {
        connection: { effectiveType: '4g' },
      },
      writable: true,
      configurable: true,
    });

    expect(hasSlowConnection()).toBe(false);
  });

  it('should return false for 3g connection', () => {
    Object.defineProperty(window, 'navigator', {
      value: {
        connection: { effectiveType: '3g' },
      },
      writable: true,
      configurable: true,
    });

    expect(hasSlowConnection()).toBe(false);
  });
});
