import { signal } from '@angular/core';
import { mutable } from '../mutable';
import { opaque } from './opaque';
import {
  createFallbackOnChange,
  hasOwnKey,
  isLeafValue,
  isRecord,
  isWritableSignal,
  resolveVivify,
} from './predicates';

describe('isRecord', () => {
  it('is true for plain and null-proto objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('is false for non-plain values', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord('a')).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord(new Date())).toBe(false);

    class Foo {}
    expect(isRecord(new Foo())).toBe(false);
  });

  it('is false for opaque objects', () => {
    expect(isRecord(opaque({ a: 1 }))).toBe(false);
  });
});

describe('isLeafValue', () => {
  it('treats primitives and built-ins as leaves', () => {
    expect(isLeafValue(1, false)).toBe(true);
    expect(isLeafValue('x', true)).toBe(true);
    expect(isLeafValue(new Date(), false)).toBe(true);
  });

  it('treats records and arrays as substores', () => {
    expect(isLeafValue({}, false)).toBe(false);
    expect(isLeafValue([], false)).toBe(false);
  });

  it('treats opaque values as leaves even when they are arrays', () => {
    expect(isLeafValue(opaque([1, 2]), false)).toBe(true);
  });

  it('treats nullish as a leaf only when vivify is off', () => {
    expect(isLeafValue(null, false)).toBe(true);
    expect(isLeafValue(null, true)).toBe(false);
    expect(isLeafValue(undefined, true)).toBe(false);
  });
});

describe('resolveVivify', () => {
  it('stays off when the option is off', () => {
    expect(resolveVivify([], false)).toBe(false);
    expect(resolveVivify({}, false)).toBe(false);
  });

  it('keeps the shape of a present container', () => {
    expect(resolveVivify([], 'auto')).toBe('array');
    expect(resolveVivify({}, 'auto')).toBe('object');
  });

  it('defers unknown values to auto', () => {
    expect(resolveVivify(null, 'auto')).toBe('auto');
    expect(resolveVivify(5, 'object')).toBe('auto');
  });
});

describe('hasOwnKey', () => {
  it('is false for nullish containers', () => {
    expect(hasOwnKey(null, 'a')).toBe(false);
    expect(hasOwnKey(undefined, 'a')).toBe(false);
  });

  it('is true only for own keys', () => {
    expect(hasOwnKey({ a: 1 }, 'a')).toBe(true);
    expect(hasOwnKey({ a: 1 }, 'b')).toBe(false);
    expect(hasOwnKey({}, 'toString')).toBe(false);
  });
});

describe('isWritableSignal', () => {
  it('distinguishes writable from readonly signals', () => {
    const w = signal(1);
    expect(isWritableSignal(w)).toBe(true);
    expect(isWritableSignal(w.asReadonly())).toBe(false);
  });
});

describe('createFallbackOnChange', () => {
  it('copies the container on write for an immutable source', () => {
    const original = { a: 1 };
    const target = signal<{ a: number }>(original);
    const onChange = createFallbackOnChange(target, 'a', (v) => v, false);

    onChange(2);

    expect(target().a).toBe(2);
    expect(target()).not.toBe(original);
    expect(original.a).toBe(1);
  });

  it('writes in place through mutate for a mutable source', () => {
    const target = mutable<{ a: number }>({ a: 1 });
    const onChange = createFallbackOnChange(target, 'a', (v) => v, true);

    onChange(9);

    expect(target().a).toBe(9);
  });

  it('drops the write when vivify yields a nullish container', () => {
    const target = signal<{ a: number } | null>(null);
    const onChange = createFallbackOnChange(target, 'a', () => null, false);

    onChange(5);

    expect(target()).toBe(null);
  });
});
