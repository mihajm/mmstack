import { effect, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { unwrap } from './unwrap';

describe('unwrap', () => {
  it('should return the primitive value as is', () => {
    expect(unwrap('hello')).toBe('hello');
    expect(unwrap(42)).toBe(42);
    expect(unwrap(true)).toBe(true);
    expect(unwrap(null)).toBe(null);
    expect(unwrap(undefined)).toBe(undefined);
  });

  it('should unwrap object values as is', () => {
    const obj = { key: 'value' };
    expect(unwrap(obj)).toBe(obj);
  });

  it('should unwrap signals and return their value', () => {
    const strSignal = signal('hello signal');
    const numSignal = signal(100);
    const objSignal = signal({ obj: true });

    TestBed.runInInjectionContext(() => {
      expect(unwrap(strSignal)).toBe('hello signal');
      expect(unwrap(numSignal)).toBe(100);
      expect(unwrap(objSignal)).toEqual({ obj: true });
    });
  });

  it('should preserve reactivity when unwrapping a signal inside an effect', () => {
    const valSignal = signal(0);
    let runCount = 0;

    TestBed.runInInjectionContext(() => {
      effect(() => {
        unwrap(valSignal);
        runCount++;
      });
    });

    TestBed.tick();
    expect(runCount).toBe(1);

    valSignal.set(1);
    TestBed.tick();
    expect(runCount).toBe(2);
  });
});
