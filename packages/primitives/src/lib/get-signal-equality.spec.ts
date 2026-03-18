import { signal } from '@angular/core';
import { getSignalEquality } from './get-signal-equality';

describe('getSignalEquality', () => {
  it('should return defaultEquals or Object.is behavior by default when no custom equality is provided', () => {
    const sig = signal<number>(0);
    const eq = getSignalEquality(sig);

    expect(typeof eq).toBe('function');
    expect(eq(1, 1)).toBe(true);
    expect(eq(1, 2)).toBe(false);
  });

  it('should return the custom equality function if provided during signal creation', () => {
    const customEqual = (a: number, b: number) => Math.abs(a - b) < 0.1;
    const sig = signal<number>(0, { equal: customEqual });

    const eq = getSignalEquality(sig);

    expect(eq).toBe(customEqual);
    expect(eq(0.1, 0.15)).toBe(true);
    expect(eq(0.1, 0.3)).toBe(false);
  });
});
