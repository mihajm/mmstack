import { inject, InjectionToken } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideAs } from './provide-as';

describe('provideAs', () => {
  it('should create a provider with useValue when value is not a function', () => {
    const token = new InjectionToken<number>('testToken');
    const provider = provideAs(token, 42);
    expect(provider).toEqual({
      provide: token,
      useValue: 42,
    });
  });

  it('should create a provider with useFactory when value is a function', () => {
    const token = new InjectionToken<number>('testToken');
    const factory = () => 42;
    const provider = provideAs(token, factory);
    expect(provider).toEqual({
      provide: token,
      useFactory: factory,
    });
  });

  it('should resolve values through DI', () => {
    const token = new InjectionToken<number>('testToken');

    TestBed.configureTestingModule({
      providers: [provideAs(token, 42)],
    });

    expect(TestBed.inject(token)).toBe(42);
  });

  it('should run factories in an injection context', () => {
    const DEP = new InjectionToken<number>('dep');
    const token = new InjectionToken<number>('testToken');

    TestBed.configureTestingModule({
      providers: [
        { provide: DEP, useValue: 21 },
        provideAs(token, () => inject(DEP) * 2),
      ],
    });

    expect(TestBed.inject(token)).toBe(42);
  });

  it('should provide function VALUES via the wrap pattern', () => {
    type Validator = (v: string) => boolean;
    const token = new InjectionToken<Validator>('validator');
    const impl: Validator = (v) => v.length > 5;

    TestBed.configureTestingModule({
      // a bare function would be treated as a factory — wrap it
      providers: [provideAs(token, () => impl)],
    });

    const resolved = TestBed.inject(token);
    expect(resolved).toBe(impl);
    expect(resolved('long enough')).toBe(true);
  });
});
