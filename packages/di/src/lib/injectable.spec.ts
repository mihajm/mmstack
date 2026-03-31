import { InjectionToken } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { injectable } from './injectable';

describe('injectable', () => {
  it('should create inject and provide fns for a token', () => {
    const [injectFn, provideFn] = injectable<string>('testToken');

    TestBed.configureTestingModule({
      providers: [provideFn('testValue')],
    });

    TestBed.runInInjectionContext(() => {
      expect(injectFn()).toBe('testValue');
    });
  });

  it('should return null when not provided and no options are passed', () => {
    const [injectFn] = injectable<string>('testToken');

    TestBed.configureTestingModule({});

    TestBed.runInInjectionContext(() => {
      expect(injectFn()).toBeNull();
    });
  });

  it('should return fallback value when not provided', () => {
    const [injectFn] = injectable<string>('testToken', {
      fallback: 'fallbackValue',
    });

    TestBed.configureTestingModule({});

    TestBed.runInInjectionContext(() => {
      expect(injectFn()).toBe('fallbackValue');
    });
  });

  it('should return lazily evaluated fallback value when not provided', () => {
    let mockCalled = 0;
    const [injectFn] = injectable<string>('testToken', {
      lazyFallback: () => {
        mockCalled++;
        return 'lazyValue';
      },
    });

    TestBed.configureTestingModule({});

    TestBed.runInInjectionContext(() => {
      expect(injectFn()).toBe('lazyValue');
      expect(injectFn()).toBe('lazyValue');
      expect(mockCalled).toBe(1); // Should be called only once
    });
  });

  it('should throw error when not provided and errorMessage is set', () => {
    const [injectFn] = injectable<string>('testToken', {
      errorMessage: 'Custom error message',
    });

    TestBed.configureTestingModule({});

    TestBed.runInInjectionContext(() => {
      expect(() => injectFn()).toThrow('Custom error message');
    });
  });

  it('should correctly build provider with dependencies using useFactory', () => {
    const [injectFn, provideFn] = injectable<string>('testToken');
    const depToken = new InjectionToken<string>('depToken');

    TestBed.configureTestingModule({
      providers: [
        { provide: depToken, useValue: 'depValue' },
        provideFn((dep: string) => `value with ${dep}`, [depToken]),
      ],
    });

    TestBed.runInInjectionContext(() => {
      expect(injectFn()).toBe('value with depValue');
    });
  });

  it('should support injectFn options (iOpt)', () => {
    const [injectFn, provideFn] = injectable<string>('testToken');

    TestBed.configureTestingModule({
      providers: [provideFn('skipSelfValue')],
    });

    TestBed.runInInjectionContext(() => {
      expect(injectFn({ skipSelf: false })).toBe('skipSelfValue');
    });
  });

  it('should support inlining the factory', () => {
    const [inejctFn] = injectable(() => 'yay');

    TestBed.runInInjectionContext(() => {
      expect(inejctFn()).toBe('yay');
    });
  });
});
