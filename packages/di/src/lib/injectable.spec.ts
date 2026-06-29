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

  it('provides a function VALUE via the wrap pattern (factory returns it, not invoked as one)', () => {
    type Validator = (v: string) => boolean;
    const fn: Validator = (v) => v.length > 5;
    const [injectValidator, provideValidator] =
      injectable<Validator>('Validator');

    TestBed.configureTestingModule({
      // a bare function is read as a factory — wrap a function VALUE as `() => fn`
      providers: [provideValidator(() => fn)],
    });

    TestBed.runInInjectionContext(() => {
      expect(injectValidator()).toBe(fn); // factory returned the function value
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

  // --- provide() value-vs-factory disambiguation (the no-`[]` factory change) ---

  describe('provide() provider shape', () => {
    it('a non-function value builds a useValue provider', () => {
      const [, provideFn, TOKEN] = injectable<{ v: number }>('obj');
      expect(provideFn({ v: 1 })).toEqual({
        provide: TOKEN,
        useValue: { v: 1 },
      });
    });

    it('a zero-arg factory builds a useFactory provider with NO deps (no `[]` required)', () => {
      const [, provideFn, TOKEN] = injectable<{ v: number }>('obj');
      const factory = () => ({ v: 1 });
      const provider = provideFn(factory);
      // the crux: a bare function is a factory, not a value, and carries no deps
      expect(provider).toEqual({ provide: TOKEN, useFactory: factory });
      expect('useValue' in provider).toBe(false);
      expect('deps' in provider).toBe(false);
    });

    it('a factory + deps builds a useFactory provider with those deps', () => {
      const [, provideFn, TOKEN] = injectable<string>('t');
      const DEP = new InjectionToken<string>('DEP');
      const factory = (d: string) => `v ${d}`;
      expect(provideFn(factory, [DEP])).toEqual({
        provide: TOKEN,
        useFactory: factory,
        deps: [DEP],
      });
    });

    it('an explicit empty deps array still builds a factory (backward compatible)', () => {
      const [, provideFn, TOKEN] = injectable<{ v: number }>('obj');
      const factory = () => ({ v: 1 });
      expect(provideFn(factory, [])).toEqual({
        provide: TOKEN,
        useFactory: factory,
        deps: [],
      });
    });
  });

  it('resolves a zero-arg factory provided without deps', () => {
    const [injectFn, provideFn] = injectable<{ v: number }>('obj');

    TestBed.configureTestingModule({
      providers: [provideFn(() => ({ v: 42 }))], // no `[]`
    });

    TestBed.runInInjectionContext(() => {
      expect(injectFn()).toEqual({ v: 42 });
    });
  });

  it('runs a no-dep factory lazily in an injection context, once per injector', () => {
    const DEP = new InjectionToken<string>('dep');
    let calls = 0;
    const [injectFn, provideFn] = injectable<{ id: number; greeting: string }>(
      'obj',
    );

    TestBed.configureTestingModule({
      providers: [
        { provide: DEP, useValue: 'world' },
        provideFn(() => ({ id: ++calls, greeting: `hi ${inject(DEP)}` })),
      ],
    });

    TestBed.runInInjectionContext(() => {
      const a = injectFn();
      const b = injectFn();
      expect(a).toBe(b); // cached
      expect(calls).toBe(1); // factory ran exactly once
      expect(a?.greeting).toBe('hi world'); // ran in an injection context
    });
  });

  it('prefers a no-dep factory over the configured fallback', () => {
    const [injectFn, provideFn] = injectable<string>('t', {
      fallback: 'fallbackValue',
    });

    TestBed.configureTestingModule({
      providers: [provideFn(() => 'made')],
    });

    TestBed.runInInjectionContext(() => {
      expect(injectFn()).toBe('made');
    });
  });

  it('injects multiple deps in order for a deps factory', () => {
    const A = new InjectionToken<number>('A');
    const B = new InjectionToken<string>('B');
    const [injectFn, provideFn] = injectable<string>('t');

    TestBed.configureTestingModule({
      providers: [
        { provide: A, useValue: 2 },
        { provide: B, useValue: 'x' },
        provideFn((a, b) => `${b}${a}`, [A, B]),
      ],
    });

    TestBed.runInInjectionContext(() => {
      expect(injectFn()).toBe('x2');
    });
  });
});
