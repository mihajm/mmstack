import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { combineWith, distinct, filter, map, select, tap } from './operators';
import { pipeable } from './pipeble';

describe('operators', () => {
  describe('select', () => {
    it('should project source value', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal(5);
        const ps = pipeable(source);
        const doubled = ps.pipe(select((n) => n * 2));

        expect(doubled()).toBe(10);

        source.set(3);
        expect(doubled()).toBe(6);
      });
    });
  });

  describe('map', () => {
    it('should transform source value', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal('hello');
        const ps = pipeable(source);
        const upper = ps.pipe(map((s) => s.toUpperCase()));

        expect(upper()).toBe('HELLO');

        source.set('world');
        expect(upper()).toBe('WORLD');
      });
    });
  });

  describe('combineWith', () => {
    it('should combine two signals with a projector', () => {
      TestBed.runInInjectionContext(() => {
        const a = signal(2);
        const b = signal(3);
        const ps = pipeable(a);
        const product = ps.pipe(combineWith(b, (x, y) => x * y));

        expect(product()).toBe(6);

        a.set(4);
        expect(product()).toBe(12);

        b.set(10);
        expect(product()).toBe(40);
      });
    });
  });

  describe('distinct', () => {
    it('should use custom equality to suppress redundant emissions', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal({ id: 1, name: 'Alice' });
        const ps = pipeable(source);
        const byId = ps.pipe(distinct((a, b) => a.id === b.id));

        const first = byId();
        expect(first).toEqual({ id: 1, name: 'Alice' });

        // Same id, different name — should return same reference
        source.set({ id: 1, name: 'Alice Updated' });
        expect(byId()).toBe(first);

        // Different id — should update
        source.set({ id: 2, name: 'Bob' });
        expect(byId()).toEqual({ id: 2, name: 'Bob' });
        expect(byId()).not.toBe(first);
      });
    });
  });

  describe('filter', () => {
    it('should keep the last passing value when predicate fails', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal(2);
        const ps = pipeable(source);
        const evens = ps.pipe(filter((n) => n % 2 === 0));

        expect(evens()).toBe(2);

        source.set(3); // odd — filtered out
        expect(evens()).toBe(2); // keeps last even

        source.set(4); // even — passes
        expect(evens()).toBe(4);
      });
    });

    it('should return undefined when first value is filtered', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal(1);
        const ps = pipeable(source);
        const evens = ps.pipe(filter((n) => n % 2 === 0));

        expect(evens()).toBeUndefined(); // first value filtered

        source.set(2);
        expect(evens()).toBe(2);
      });
    });
  });

  describe('tap', () => {
    it('should run a side effect without changing the value', () => {
      TestBed.runInInjectionContext(() => {
        const spy = vi.fn();
        const source = signal(10);
        const ps = pipeable(source);
        const tapped = ps.pipe(tap(spy));

        TestBed.tick();
        expect(spy).toHaveBeenCalledWith(10);
        expect(tapped()).toBe(10);

        source.set(20);
        TestBed.tick();
        expect(spy).toHaveBeenCalledWith(20);
        expect(tapped()).toBe(20);
      });
    });
  });

  describe('chaining operators', () => {
    it('should compose multiple operators via pipe', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal(5);
        const ps = pipeable(source);

        const result = ps.pipe(
          map((n) => n * 2),
          select((n) => `#${n}`),
        );

        expect(result()).toBe('#10');

        source.set(7);
        expect(result()).toBe('#14');
      });
    });
  });
});
