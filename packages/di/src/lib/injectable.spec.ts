import { inject, InjectionToken } from '@angular/core';
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

  it('does NOT share a lazyFallback instance across applications (SSR isolation)', () => {
    let calls = 0;
    const [injectThing] = injectable<{ id: number }>('testToken', {
      lazyFallback: () => ({ id: ++calls }),
    });

    TestBed.configureTestingModule({});
    const first = TestBed.runInInjectionContext(() => injectThing());
    const firstAgain = TestBed.runInInjectionContext(() => injectThing());
    expect(first.id).toBe(1);
    expect(firstAgain).toBe(first); // cached within the app

    // a fresh application = a fresh root injector — exactly what each SSR
    // request gets. The fallback must NOT leak across that boundary.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const second = TestBed.runInInjectionContext(() => injectThing());
    expect(second).not.toBe(first);
    expect(second.id).toBe(2);
  });

  it('runs the factory overload in an injection context (can use inject())', () => {
    const DEP = new InjectionToken<string>('dep');
    const [injectGreeting] = injectable(
      () => `hello ${inject(DEP)}`,
      'Greeting',
    );

    TestBed.configureTestingModule({
      providers: [{ provide: DEP, useValue: 'world' }],
    });

    TestBed.runInInjectionContext(() => {
      expect(injectGreeting()).toBe('hello world');
    });
  });

  it('prefers a provided value over the fallback', () => {
    const [injectFn, provideFn] = injectable<string>('testToken', {
      fallback: 'fallbackValue',
    });

    TestBed.configureTestingModule({
      providers: [provideFn('providedValue')],
    });

    TestBed.runInInjectionContext(() => {
      expect(injectFn()).toBe('providedValue');
    });
  });

  it('provides a function as a VALUE (useValue), not a factory', () => {
    type Validator = (v: string) => boolean;
    const fn: Validator = (v) => v.length > 5;
    const [injectValidator, provideValidator] =
      injectable<Validator>('Validator');

    TestBed.configureTestingModule({
      providers: [provideValidator(fn)],
    });

    TestBed.runInInjectionContext(() => {
      expect(injectValidator()).toBe(fn); // same reference — never invoked as a factory
      expect(injectValidator()?.('long enough')).toBe(true);
    });
  });

  it('treats an explicitly provided undefined as a provided value (no fallback hijack)', () => {
    const [injectFn, provideFn] = injectable<string | undefined>('maybe', {
      fallback: 'fallbackValue',
    });

    TestBed.configureTestingModule({
      providers: [provideFn(undefined)],
    });

    TestBed.runInInjectionContext(() => {
      expect(injectFn()).toBeUndefined();
    });
  });

  it('falls back when a constrained lookup misses the provider', () => {
    const [injectFn] = injectable<string>('constrained', {
      fallback: 'fallbackValue',
    });

    TestBed.configureTestingModule({});

    TestBed.runInInjectionContext(() => {
      // skipSelf misses everything in the test app — the bare root lookup
      // must still find the fallback factory
      expect(injectFn({ skipSelf: true })).toBe('fallbackValue');
    });
  });

  it('exposes the raw token as the third tuple element for interop', () => {
    const [injectFn, , TOKEN] = injectable<string>('raw');

    TestBed.configureTestingModule({
      providers: [{ provide: TOKEN, useValue: 'direct' }],
    });

    TestBed.runInInjectionContext(() => {
      expect(injectFn()).toBe('direct');
    });
    expect(TOKEN).toBeInstanceOf(InjectionToken);
  });
});
