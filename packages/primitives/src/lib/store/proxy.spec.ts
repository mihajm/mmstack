import { Injector, isSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { mutableStore, store } from './proxy';

describe('store', () => {
  let injector: Injector;

  beforeEach(() => {
    TestBed.runInInjectionContext(() => {
      injector = TestBed.inject(Injector);
    });
  });

  it('should create a store', () => {
    const src = { a: 1 };
    const s = store(src, {
      injector,
    });
    expect(s).toBeDefined();
    expect(s()).toBe(src);
  });

  it('should support deep reactivity', () => {
    const src = { a: { b: 1 } };
    const s = store(src, { injector });
    expect(s().a.b).toBe(1);
    s.a.b.set(2);
    expect(s().a.b).toBe(2);
    expect(s()).not.toBe(src);
    expect(s()).toEqual({ a: { b: 2 } });
  });

  it('should support mutable reactivity', () => {
    const src = { a: { b: 1 } };
    const s = mutableStore(src, {
      injector,
    });
    expect(s().a.b).toBe(1);
    s.a.b.set(2);
    expect(s().a.b).toBe(2);
    expect(s()).toBe(src);
    expect(s()).toEqual({ a: { b: 2 } });
  });

  it('should return signals', () => {
    const src = { a: 1 };
    const s = store(src, { injector });
    expect(s.a).toBeDefined();
    expect(isSignal(s.a)).toBe(true);
  });

  it('should support key iteration', () => {
    const src = { a: 1, b: 2 };
    const s = store(src, { injector });
    const keys = Object.keys(s);
    expect(keys).toEqual(['a', 'b']);
  });

  it('should support key in object', () => {
    const src = { a: 1, b: 2 };
    const s = store(src, { injector });
    expect('a' in s).toBe(true);
    expect('c' in s).toBe(false);
  });

  it('should suport getOwnPropertyDescriptor', () => {
    const src = { a: 1 };
    const s = store(src, { injector });
    const descriptor = Object.getOwnPropertyDescriptor(s, 'a');
    expect(descriptor).toBeDefined();
    expect(descriptor?.enumerable).toBe(true);
    expect(descriptor?.configurable).toBe(true);
  });

  it('should return stable computations', () => {
    const src = { a: 1 };
    const s = store(src, { injector });
    const a1 = s.a;
    const a2 = s.a;
    expect(a1).toBe(a2);
  });

  it('should return a new readonly store when asReadonlyStore is called', () => {
    const src = { a: 1 };
    const s = store(src, { injector });
    const readonly = s.asReadonlyStore();
    expect(readonly).not.toBe(s);

    // setter exists but is noop
    (readonly.a as any).set(2);
    expect(readonly.a()).toBe(1);
  });
});
