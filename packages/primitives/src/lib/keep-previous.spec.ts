import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { keepPrevious } from './keep-previous';

describe('keepPrevious', () => {
  it('holds the last defined value when the source drops to undefined', () => {
    TestBed.runInInjectionContext(() => {
      const src = signal<number | undefined>(1);
      const held = keepPrevious(src);

      expect(held()).toBe(1);

      src.set(undefined); // mid-reload gap → hold previous, do not flash empty
      expect(held()).toBe(1);

      src.set(2); // new defined value flows through
      expect(held()).toBe(2);

      src.set(undefined);
      expect(held()).toBe(2);
    });
  });

  it('passes the initial value through even if undefined (no previous to hold yet)', () => {
    TestBed.runInInjectionContext(() => {
      const src = signal<number | undefined>(undefined);
      const held = keepPrevious(src);
      expect(held()).toBeUndefined();

      src.set(5);
      expect(held()).toBe(5);
    });
  });

  it('forwards set/update to a writable source (stays a drop-in replacement)', () => {
    TestBed.runInInjectionContext(() => {
      const src = signal<number | undefined>(1);
      const held = keepPrevious(src);

      held.set(9); // write goes through to the source
      expect(src()).toBe(9);
      expect(held()).toBe(9);

      held.update((v) => (v ?? 0) + 1);
      expect(src()).toBe(10);
    });
  });
});
