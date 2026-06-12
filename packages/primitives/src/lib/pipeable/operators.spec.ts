import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  combineWith,
  distinct,
  filter,
  filterWith,
  map,
  pairwise,
  scan,
  select,
  startWith,
  tap,
} from './operators';
import { pipeable } from './pipeable';

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

    it('should keep the last passing value across consecutive failures', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal(2);
        const ps = pipeable(source);
        const evens = ps.pipe(filter((n) => n % 2 === 0));

        expect(evens()).toBe(2);

        source.set(3); // odd — filtered out
        expect(evens()).toBe(2); // computed here: prev.source becomes 3

        source.set(5); // odd — filtered out again
        // regression: returning prev.source here would resurrect 3
        expect(evens()).toBe(2);

        source.set(6);
        expect(evens()).toBe(6);
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

  describe('filterWith', () => {
    it('should emit initial until predicate passes, then mirror source', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal(1);
        const ps = pipeable(source);
        const evens = ps.pipe(filterWith((n) => n % 2 === 0, -1));

        expect(evens()).toBe(-1); // initial — predicate failed for first value

        source.set(2);
        expect(evens()).toBe(2);

        source.set(3);
        expect(evens()).toBe(2); // keeps last passing

        source.set(4);
        expect(evens()).toBe(4);
      });
    });
  });

  describe('startWith', () => {
    it('should emit initial first, then mirror source', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal(10);
        const ps = pipeable(source);
        const withInitial = ps.pipe(startWith('start'));

        expect(withInitial()).toBe('start');

        source.set(20);
        expect(withInitial()).toBe(20);

        source.set(30);
        expect(withInitial()).toBe(30);
      });
    });
  });

  describe('pairwise', () => {
    it('should emit [prev, curr] tuples', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal(1);
        const ps = pipeable(source);
        const pairs = ps.pipe(pairwise<number>());

        expect(pairs()).toEqual([undefined, 1]);

        source.set(2);
        expect(pairs()).toEqual([1, 2]);

        source.set(5);
        expect(pairs()).toEqual([2, 5]);
      });
    });
  });

  describe('scan', () => {
    it('should accumulate values across emissions', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal(1);
        const ps = pipeable(source);
        const sum = ps.pipe(scan<number, number>((acc, n) => acc + n, 0));

        expect(sum()).toBe(1);

        source.set(2);
        expect(sum()).toBe(3);

        source.set(3);
        expect(sum()).toBe(6);
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
