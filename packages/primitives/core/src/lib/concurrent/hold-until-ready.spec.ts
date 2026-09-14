import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { holdUntilReady } from './hold-until-ready';

describe('holdUntilReady', () => {
  it('passes the first value straight through', () => {
    TestBed.runInInjectionContext(() => {
      const target = signal('A');
      const ready = signal(false);
      const held = holdUntilReady(target, ready);
      expect(held()).toBe('A'); // nothing to hold yet
    });
  });

  it('holds the previous value until ready, then swaps', () => {
    TestBed.runInInjectionContext(() => {
      const target = signal('A');
      const ready = signal(true);
      const held = holdUntilReady(target, ready);
      expect(held()).toBe('A');

      // structural change requested, but the incoming tree isn't ready yet
      ready.set(false);
      target.set('B');
      expect(held()).toBe('A'); // still showing the old structure

      // incoming settles → swap
      ready.set(true);
      expect(held()).toBe('B');
    });
  });

  it('keeps holding across multiple not-ready target changes (latest wins on release)', () => {
    TestBed.runInInjectionContext(() => {
      const target = signal('A');
      const ready = signal(true);
      const held = holdUntilReady(target, ready);
      expect(held()).toBe('A');

      ready.set(false);
      target.set('B');
      expect(held()).toBe('A');
      target.set('C'); // superseded before B ever showed
      expect(held()).toBe('A');

      ready.set(true);
      expect(held()).toBe('C'); // releases to the latest target, not B
    });
  });
});
