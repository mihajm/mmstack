import { ApplicationRef, computed, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { derived, isDerivation } from './derived';
import { isMutable, mutable } from './mutable';
import { isStored, stored } from './stored';
import { toWritable } from './to-writable';
import { traced } from './traced';

let cause: string | undefined;

beforeEach(() => {
  cause = undefined;
});

function memoryStore() {
  const memory = new Map<string, string>();
  return {
    memory,
    store: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
    },
  };
}

describe('traced', () => {
  describe('(a) surface preservation per family member', () => {
    it('plain signal: writes land, reads track, asReadonly is source-side', () => {
      const src = signal(0);
      const twin = traced(src, () => cause);

      let runs = 0;
      const consumer = computed(() => {
        runs++;
        return twin();
      });

      expect(consumer()).toBe(0);
      expect(runs).toBe(1);

      twin.set(1);
      expect(consumer()).toBe(1);
      expect(runs).toBe(2);

      twin.update((v) => v + 1);
      expect(consumer()).toBe(2);

      src.set(5);
      expect(consumer()).toBe(5);

      const ro = twin.asReadonly();
      expect(ro()).toBe(src());
      expect('set' in ro).toBe(false);
    });

    it('mutable: same-reference mutate/inline notify an equal:false consumer', () => {
      const src = mutable([1, 2]);
      const twin = traced(src, () => cause);

      expect(isMutable(twin)).toBe(true);

      let runs = 0;
      const consumer = computed(
        () => {
          runs++;
          return twin();
        },
        { equal: () => false },
      );

      expect(consumer()).toEqual([1, 2]);
      expect(runs).toBe(1);

      twin.mutate((arr) => {
        arr.push(3);
        return arr;
      });
      expect(consumer()).toEqual([1, 2, 3]);
      expect(runs).toBe(2);

      twin.inline((arr) => {
        arr.push(4);
      });
      expect(consumer()).toEqual([1, 2, 3, 4]);
      expect(runs).toBe(3);
    });

    it('derived over signal: writes reach the source, `from` survives', () => {
      const user = signal({ name: 'John', age: 30 });
      const name = derived(user, 'name');
      const twin = traced(name, () => cause);

      expect(twin()).toBe('John');
      expect(isDerivation(twin)).toBe(true);
      expect(typeof (twin as unknown as { from: unknown }).from).toBe(
        'function',
      );

      twin.set('Jane');
      expect(user().name).toBe('Jane');
      expect(twin()).toBe('Jane');
    });

    it('derived over mutable: mutate writes through and notifies', () => {
      const user = mutable({ tags: ['a'] });
      const tags = derived(user, 'tags');
      const twin = traced(tags, () => cause);

      expect(isMutable(twin)).toBe(true);

      let runs = 0;
      const consumer = computed(
        () => {
          runs++;
          return twin();
        },
        { equal: () => false },
      );

      expect(consumer()).toEqual(['a']);
      expect(runs).toBe(1);

      twin.mutate((arr) => {
        arr.push('b');
        return arr;
      });
      expect(user().tags).toEqual(['a', 'b']);
      expect(consumer()).toEqual(['a', 'b']);
      expect(runs).toBe(2);
    });

    it('toWritable (pure): custom set runs through the twin', () => {
      const orig = signal({ a: 1 });
      const w = toWritable(
        computed(() => orig().a),
        (v) => orig.update((prev) => ({ ...prev, a: v })),
      );
      const twin = traced(w, () => cause);

      expect(twin()).toBe(1);

      twin.set(5);
      expect(orig().a).toBe(5);
      expect(twin()).toBe(5);

      twin.update((v) => v + 5);
      expect(orig().a).toBe(10);
      expect(twin()).toBe(10);
    });

    it('toWritable (impure): custom set runs and asReadonly is source-side', () => {
      const base = signal(1);
      const view = computed(() => base());
      const w = toWritable(view, (v) => base.set(v), undefined, {
        pure: false,
      });
      const twin = traced(w, () => cause);

      expect(twin()).toBe(1);

      twin.set(7);
      expect(base()).toBe(7);
      expect(twin()).toBe(7);
      expect(twin.asReadonly()()).toBe(view());
    });

    it('stored: writes land through the twin and reads track', () => {
      const { store } = memoryStore();

      TestBed.runInInjectionContext(() => {
        const src = stored(0, {
          key: 'k',
          store,
          injector: TestBed.inject(Injector),
        });
        const twin = traced(src, () => cause);

        expect(twin()).toBe(0);

        twin.set(7);
        expect(twin()).toBe(7);
        expect(twin.asReadonly()()).toBe(7);
      });
    });

    it('stored: clear through the twin resets to fallback and removes from storage', async () => {
      const { memory, store } = memoryStore();

      await TestBed.runInInjectionContext(async () => {
        const src = stored(0, {
          key: 'k',
          store,
          injector: TestBed.inject(Injector),
        });
        const twin = traced(src, () => cause);

        twin.set(7);
        TestBed.tick();
        await TestBed.inject(ApplicationRef).whenStable();
        expect(memory.get('k')).toBe('7');

        twin.clear();
        expect(twin()).toBe(0);

        TestBed.tick();
        await TestBed.inject(ApplicationRef).whenStable();
        expect(memory.has('k')).toBe(false);
      });
    });

    it('stored: key survives the pure facade', () => {
      const { store } = memoryStore();

      TestBed.runInInjectionContext(() => {
        const src = stored(0, {
          key: 'k',
          store,
          injector: TestBed.inject(Injector),
        });
        const twin = traced(src, () => cause);

        expect(twin).not.toBe(src);
        expect(isStored(twin)).toBe(true);
        expect(twin.key).toBe(src.key);
        expect(twin.key()).toBe('k');
      });
    });
  });

  describe('(b) attribution', () => {
    it('records the ambient cause; last-writer-wins; undefined clears', () => {
      const twin = traced(signal(0), () => cause);

      cause = 'A';
      twin.set(1);
      expect(twin.causedBy()).toBe('A');

      cause = 'B';
      twin.update((v) => v + 1);
      expect(twin.causedBy()).toBe('B');

      cause = undefined;
      twin.set(9);
      expect(twin.causedBy()).toBeUndefined();
    });

    it('a write after the ambient clears records undefined (sync-only caveat)', async () => {
      const twin = traced(signal(0), () => cause);

      cause = 'during';
      const pending = (async () => {
        await Promise.resolve();
        twin.set(1);
      })();
      cause = undefined;
      await pending;

      expect(twin.causedBy()).toBeUndefined();
    });

    it('clear() captures; last-writer-wins across set-then-clear', () => {
      const { store } = memoryStore();

      TestBed.runInInjectionContext(() => {
        const src = stored(0, {
          key: 'k',
          store,
          injector: TestBed.inject(Injector),
        });
        const twin = traced(src, () => cause);

        cause = 'set-cause';
        twin.set(1);
        expect(twin.causedBy()).toBe('set-cause');

        cause = 'clear-cause';
        twin.clear();
        expect(twin.causedBy()).toBe('clear-cause');
        expect(twin()).toBe(0);
      });
    });

    it('causedBy is non-reactive: a cause-only change never invalidates a consumer', () => {
      const twin = traced(signal(0), () => cause);

      let runs = 0;
      const consumer = computed(() => {
        runs++;
        twin();
        return twin.causedBy();
      });

      cause = 'first';
      twin.set(1);
      expect(consumer()).toBe('first');
      const runsAfterWrite = runs;

      cause = 'second';
      expect(consumer()).toBe('first');
      expect(runs).toBe(runsAfterWrite);

      twin.set(2);
      expect(consumer()).toBe('second');
      expect(runs).toBe(runsAfterWrite + 1);
    });
  });

  describe('(c) facade vs patch', () => {
    it('pure default returns a new twin and leaves the original untouched', () => {
      const src = signal(0);
      const originalSet = src.set;
      const twin = traced(src, () => cause);

      expect(twin).not.toBe(src);
      expect('causedBy' in src).toBe(false);
      expect(src.set).toBe(originalSet);

      cause = 'X';
      twin.set(1);
      expect(src()).toBe(1);
      expect(
        (src as unknown as { causedBy?: unknown }).causedBy,
      ).toBeUndefined();
    });

    it('pure:false patches the same object in place', () => {
      const src = signal(0);
      const twin = traced(src, () => cause, { pure: false });

      expect(twin).toBe(src);

      cause = 'Y';
      src.set(1);
      expect(
        (src as unknown as { causedBy(): string | undefined }).causedBy(),
      ).toBe('Y');
    });

    it('pure:false patches clear in place: clears on the original capture', () => {
      const { store } = memoryStore();

      TestBed.runInInjectionContext(() => {
        const src = stored(0, {
          key: 'k',
          store,
          injector: TestBed.inject(Injector),
        });
        const twin = traced(src, () => cause, { pure: false });

        expect(twin).toBe(src);

        cause = 'Z';
        src.clear();
        expect(twin.causedBy()).toBe('Z');
        expect(src()).toBe(0);
      });
    });
  });
});
