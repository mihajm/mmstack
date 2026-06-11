import { TestBed } from '@angular/core/testing';
import { forkStore, merge3, type ReconcileFn } from './fork-store';
import { mutableStore, store } from './store';

const set = <T>(node: unknown, value: T) =>
  (node as { set(v: T): void }).set(value);
const inInjectionContext = <T>(fn: () => T) =>
  TestBed.runInInjectionContext(fn);

// ───────────────────────────── merge3 (pure 3-way merge) ─────────────────────────────
describe('merge3', () => {
  it('takes theirs for paths the fork did not edit, keeps mine for paths it did', () => {
    const ancestor = { a: 1, b: 2, c: 3 };
    const mine = { a: 1, b: 99, c: 3 }; // edited b
    const theirs = { a: 1, b: 2, c: 30 }; // base changed c
    expect(merge3(ancestor, mine, theirs)).toEqual({ a: 1, b: 99, c: 30 });
  });

  it('mine wins on a genuine leaf conflict (both changed the same path)', () => {
    expect(merge3({ x: 1 }, { x: 2 }, { x: 3 })).toEqual({ x: 2 });
  });

  describe('depth', () => {
    it('keeps a 3-level-deep edit while taking a sibling base change at the same depth', () => {
      const ancestor = { a: { b: { c: 1, d: 2 } } };
      const mine = { a: { b: { c: 99, d: 2 } } }; // edited a.b.c
      const theirs = { a: { b: { c: 1, d: 20 } } }; // base changed a.b.d
      expect(merge3(ancestor, mine, theirs)).toEqual({
        a: { b: { c: 99, d: 20 } },
      });
    });

    it('merges edits made on DIFFERENT deep paths within the same subtree', () => {
      const ancestor = { u: { name: 'a', addr: { city: 'X', zip: '1' } } };
      const mine = { u: { name: 'b', addr: { city: 'X', zip: '1' } } }; // edit name
      const theirs = { u: { name: 'a', addr: { city: 'Y', zip: '1' } } }; // base edits addr.city
      expect(merge3(ancestor, mine, theirs)).toEqual({
        u: { name: 'b', addr: { city: 'Y', zip: '1' } },
      });
    });

    it('mine wins on a deep leaf conflict', () => {
      const ancestor = { a: { b: { c: 1 } } };
      const mine = { a: { b: { c: 2 } } };
      const theirs = { a: { b: { c: 3 } } };
      expect(merge3(ancestor, mine, theirs)).toEqual({ a: { b: { c: 2 } } });
    });
  });

  describe('add / delete keys', () => {
    it('keeps a key the fork added (present in mine only)', () => {
      expect(merge3({ a: 1 }, { a: 1, b: 2 }, { a: 1 })).toEqual({
        a: 1,
        b: 2,
      });
    });

    it('flows through a key the base added (present in theirs only)', () => {
      expect(merge3({ a: 1 }, { a: 1 }, { a: 1, b: 9 })).toEqual({
        a: 1,
        b: 9,
      });
    });

    it('a base addition AND a local addition both land', () => {
      expect(merge3({ a: 1 }, { a: 1, m: 1 }, { a: 1, t: 2 })).toEqual({
        a: 1,
        m: 1,
        t: 2,
      });
    });

    it("a fork edit beats the base's deletion of the same key (conflict → mine)", () => {
      // ancestor has k; base deleted it (theirs lacks k); fork edited k → fork wins
      expect(merge3({ k: 1 }, { k: 99 }, {})).toEqual({ k: 99 });
    });

    it("the base's deletion of a clean key wins (key gone / undefined)", () => {
      // fork didn't touch k; base deleted it → take theirs (no k)
      const out = merge3<{ k?: number }>({ k: 1 }, { k: 1 }, {});
      expect(out.k).toBeUndefined();
    });
  });

  describe('type / shape changes (honoring the structural-sharing contract)', () => {
    it('keeps a fork edit that changes an object into a primitive', () => {
      const shared = { y: 1 };
      const ancestor = { x: shared };
      const mine = { x: 5 as unknown as { y: number } }; // fork replaced the subtree with a leaf
      const theirs = { x: shared }; // base left x alone → same ref
      expect(merge3(ancestor, mine, theirs)).toEqual({ x: 5 });
    });

    it('takes a base shape change on a path the fork left alone', () => {
      const shared = { y: 1 };
      const ancestor = { x: shared };
      const mine = { x: shared }; // fork left x alone → same ref (the contract)
      const theirs = { x: 5 as unknown as { y: number } }; // base replaced subtree with a leaf
      expect(merge3(ancestor, mine, theirs)).toEqual({ x: 5 });
    });

    it('handles null/undefined without throwing', () => {
      expect(
        merge3({ a: null }, { a: null }, { a: 1 as unknown as null }),
      ).toEqual({ a: 1 });
      expect(
        merge3({ a: 1 }, { a: null as unknown as number }, { a: 1 }),
      ).toEqual({ a: null });
    });
  });

  describe('the reference-identity contract', () => {
    it('a fresh-ref "clean" node vs a base type-change resolves to mine (documented limitation)', () => {
      // VIOLATING the contract on purpose: mine.x is a fresh reference equal to ancestor.x.
      // merge3 cannot distinguish that from a real edit, so against a base type-change it keeps
      // mine's (stale) value rather than taking theirs. The fork never hits this — toStore shares
      // the reference for untouched paths — but a hand-built caller must uphold the same.
      const ancestor = { x: { y: 1 } };
      const mine = { x: { y: 1 } }; // fresh ref, not ancestor.x
      const theirs = { x: 5 as unknown as { y: number } };
      expect(merge3(ancestor, mine, theirs)).toEqual({ x: { y: 1 } }); // NOT { x: 5 }
    });

    it('equal primitive leaves are still seen as unchanged (value compare at the leaf)', () => {
      // fresh-ref containers, but the leaf primitives compare by value — so an unedited leaf
      // correctly takes the base change.
      const ancestor = { x: { y: 1 } };
      const mine = { x: { y: 1 } }; // fresh ref, leaf unchanged
      const theirs = { x: { y: 2 } }; // base changed the leaf
      expect(merge3(ancestor, mine, theirs)).toEqual({ x: { y: 2 } });
    });
  });

  describe('arrays (atomic — no positional merge)', () => {
    it('mine wins on an array conflict', () => {
      expect(merge3({ l: [1] }, { l: [1, 2] }, { l: [1, 3] })).toEqual({
        l: [1, 2],
      });
    });

    it("takes the base's array when the fork left it untouched", () => {
      const original = [1, 2];
      const ancestor = { l: original };
      const mine = { l: original }; // untouched (same ref)
      const theirs = { l: [9, 9] };
      expect(merge3(ancestor, mine, theirs)).toEqual({ l: [9, 9] });
    });
  });

  describe('structural sharing / identity pruning', () => {
    it('returns theirs wholesale when the fork never diverged (mine === ancestor)', () => {
      const ancestor = { a: 1 };
      const theirs = { a: 2 };
      expect(merge3(ancestor, ancestor, theirs)).toBe(theirs); // identity, not a rebuild
    });

    it("returns the base's branch by reference for an untouched subtree", () => {
      const sharedBranch = { y: 1 };
      const ancestor = { x: sharedBranch, z: 1 };
      const mine = { x: sharedBranch, z: 2 }; // edited z only; x is the same ref
      const theirsX = { y: 1 };
      const theirs = { x: theirsX, z: 1 };
      const out = merge3(ancestor, mine, theirs);
      expect(out.x).toBe(theirsX); // untouched branch pruned → base's ref, not a new object
      expect(out.z).toBe(2);
    });
  });
});

// ───────────────────────────── fork (integration, real store) ─────────────────────────────
describe('fork', () => {
  function setup(
    strategy?: 'fine' | 'coarse' | ReconcileFn<{ a: number; b: number }>,
  ) {
    return inInjectionContext(() => {
      const base = store<{ a: number; b: number }>({ a: 1, b: 2 });
      return {
        base,
        ...forkStore(base, strategy ? { strategy } : undefined),
      };
    });
  }

  it('writes stay isolated — the base is untouched', () => {
    const { base, store: f } = setup();
    set(f.a, 99);
    expect(f.a()).toBe(99);
    expect(base.a()).toBe(1);
  });

  it('unedited keys read through to the base', () => {
    const { base, store: f } = setup();
    set(f.a, 99);
    expect(f.b()).toBe(2);
    expect(base.b()).toBe(2);
  });

  describe("'fine' (default) — per-key 3-way merge", () => {
    it('keeps the edited key and picks up a base change to a DIFFERENT key', () => {
      const { base, store: f } = setup();
      set(f.a, 99);
      set(base.b, 5);
      expect(f.a()).toBe(99);
      expect(f.b()).toBe(5);
      expect(base.a()).toBe(1);
    });

    it('several independent local edits all survive a base change', () => {
      const base = inInjectionContext(() =>
        store<{ a: number; b: number; c: number }>({ a: 1, b: 2, c: 3 }),
      );
      const { store: f } = inInjectionContext(() => forkStore(base));
      set(f.a, 10);
      set(f.b, 20);
      set(base.c, 99); // base touches the one key the fork didn't
      expect(f.a()).toBe(10);
      expect(f.b()).toBe(20);
      expect(f.c()).toBe(99);
    });

    it('a same-key edit beats a concurrent base change (conflict → fork wins)', () => {
      const { base, store: f } = setup();
      set(f.a, 99);
      set(base.a, 7); // both touch a
      expect(f.a()).toBe(99); // fork wins
      expect(base.a()).toBe(7); // base still has its own value
    });

    it('survives MULTIPLE sequential base changes (continuous re-baseline)', () => {
      const base = inInjectionContext(() =>
        store<{ a: number; b: number; c: number }>({ a: 1, b: 2, c: 3 }),
      );
      const { store: f } = inInjectionContext(() => forkStore(base));
      set(f.a, 99);
      set(base.b, 20);
      expect(f.a()).toBe(99);
      set(base.c, 30);
      expect(f.a()).toBe(99); // edit still held after a 2nd base change
      expect(f.b()).toBe(20);
      expect(f.c()).toBe(30);
    });

    it('deep: keeps a nested edit while taking a sibling base change', () => {
      const base = inInjectionContext(() =>
        store<{ user: { name: string; age: number } }>({
          user: { name: 'Ada', age: 1 },
        }),
      );
      const { store: f } = inInjectionContext(() => forkStore(base));
      set(f.user.name, 'Grace');
      set(base.user.age, 2);
      expect(f.user.name()).toBe('Grace');
      expect(f.user.age()).toBe(2);
    });

    it('3-level deep: edit a.b.c, base changes a.b.d — both land, base.a.b.c untouched', () => {
      const base = inInjectionContext(() =>
        store<{ a: { b: { c: number; d: number } } }>({
          a: { b: { c: 1, d: 2 } },
        }),
      );
      const { store: f } = inInjectionContext(() => forkStore(base));
      set(f.a.b.c, 99);
      set(base.a.b.d, 20);
      expect(f.a.b.c()).toBe(99);
      expect(f.a.b.d()).toBe(20);
      expect(base.a.b.c()).toBe(1); // base's c never touched
    });

    it('deep read-through: an unedited nested path follows the live base', () => {
      const base = inInjectionContext(() =>
        store<{ a: { b: number } }>({ a: { b: 1 } }),
      );
      const { store: f } = inInjectionContext(() => forkStore(base));
      expect(f.a.b()).toBe(1);
      set(base.a.b, 5); // no fork edit anywhere
      expect(f.a.b()).toBe(5); // follows base
    });
  });

  describe("'coarse' — whole-value reset", () => {
    it('a base change resets the WHOLE fork (drops staged writes)', () => {
      const { base, store: f } = setup('coarse');
      set(f.a, 99);
      expect(f.a()).toBe(99);
      set(base.b, 5);
      expect(f.a()).toBe(1); // staged write dropped
      expect(f.b()).toBe(5);
    });
  });

  describe('custom ReconcileFn', () => {
    it('uses the provided merge on a base change', () => {
      const baseWins: ReconcileFn<{ a: number; b: number }> = (
        _anc,
        _mine,
        theirs,
      ) => theirs;
      const { base, store: f } = setup(baseWins);
      set(f.a, 99);
      set(base.b, 5);
      expect(f.a()).toBe(1); // base wins → local edit discarded
      expect(f.b()).toBe(5);
    });
  });

  describe('commit', () => {
    it('flushes the fork onto the base, then the fork mirrors the base', () => {
      const { base, store: f, commit } = setup();
      set(f.a, 42);
      expect(base.a()).toBe(1);
      commit();
      expect(base.a()).toBe(42);
      expect(f.a()).toBe(42);
    });

    it('preserves a concurrent base change to a DIFFERENT key (merge, not clobber)', () => {
      const { base, store: f, commit } = setup();
      set(f.a, 99); // fork edits a
      set(base.b, 20); // base changes b underneath
      commit();
      expect(base.a()).toBe(99); // fork's edit applied
      expect(base.b()).toBe(20); // base's concurrent change NOT clobbered
    });

    it('the fork stays usable after a commit (re-baselined)', () => {
      const { base, store: f, commit } = setup();
      set(f.a, 42);
      commit();
      set(f.a, 100); // edit again post-commit
      expect(f.a()).toBe(100);
      expect(base.a()).toBe(42); // not yet re-committed
    });
  });

  describe('mutable base', () => {
    it("defaults to 'coarse' — a base change resets the whole fork (identity checks can't work)", () => {
      const base = inInjectionContext(() =>
        mutableStore<{ a: number; b: number }>({ a: 1, b: 2 }),
      );
      const { store: f } = inInjectionContext(() => forkStore(base)); // no strategy → coarse for mutable
      set(f.a, 99);
      set(base.b, 5); // in-place base mutation
      expect(f.a()).toBe(1); // reset (coarse); 'fine' would wrongly keep 99 and ignore the base
      expect(f.b()).toBe(5);
    });

    it("warns and switches to 'coarse' when 'fine' is explicitly requested", () => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        const base = inInjectionContext(() =>
          mutableStore<{ a: number; b: number }>({ a: 1, b: 2 }),
        );
        const { store: f } = inInjectionContext(() =>
          forkStore(base, { strategy: 'fine' }),
        );
        expect(warn).toHaveBeenCalledTimes(1);
        set(f.a, 99);
        set(base.b, 5);
        expect(f.a()).toBe(1); // behaved as coarse, not fine
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('store config: vivify / unions', () => {
    it('forwards vivify — a write through a null path creates the container (matching the base)', () => {
      const base = inInjectionContext(() =>
        store<{ a: { b: number } | null }>({ a: null }, { vivify: 'object' }),
      );
      const { store: f } = inInjectionContext(() =>
        forkStore(base, { vivify: 'object' }),
      );
      set((f as { a: { b: unknown } }).a.b, 1); // write through the null `a`
      expect(f.a()).toEqual({ b: 1 }); // vivified locally
      expect(base.a()).toBeNull(); // base untouched
    });

    it('WITHOUT vivify the same write is dropped — the fork does not inherit base store config', () => {
      const base = inInjectionContext(() =>
        store<{ a: { b: number } | null }>({ a: null }, { vivify: 'object' }),
      );
      const { store: f } = inInjectionContext(() => forkStore(base)); // vivify NOT forwarded
      set((f as { a: { b: unknown } }).a.b, 1);
      expect(f.a()).toBeNull(); // dropped — vivify off on the fork
    });

    it('a union node flipping leaf→substore in the base flows through (fork left it alone)', () => {
      const base = inInjectionContext(() =>
        store<{ v: number | { x: number } }>({ v: 1 }),
      );
      const { store: f } = inInjectionContext(() => forkStore(base));
      expect(f.v()).toBe(1);
      set(base.v, { x: 9 }); // base flips v from a number to an object
      expect(f.v()).toEqual({ x: 9 }); // unedited → follows the base across the type flip
    });

    it('a union conflict (both flip the node) resolves to the fork', () => {
      const base = inInjectionContext(() =>
        store<{ v: number | { x: number } }>({ v: 1 }),
      );
      const { store: f } = inInjectionContext(() => forkStore(base));
      set(f.v, { x: 2 }); // fork flips v to an object
      set(base.v, 5); // base also changes v (still a number)
      expect(f.v()).toEqual({ x: 2 }); // conflict → fork wins
    });
  });

  describe('discard', () => {
    it('drops staged writes — the fork reads the base again', () => {
      const { base, store: f, discard } = setup();
      set(f.a, 42);
      expect(f.a()).toBe(42);
      discard();
      expect(f.a()).toBe(1);
      expect(base.a()).toBe(1);
    });

    it('after discard the fork follows subsequent base changes', () => {
      const { base, store: f, discard } = setup();
      set(f.a, 42);
      discard();
      set(base.a, 7);
      expect(f.a()).toBe(7); // no local edit → follows base
    });
  });
});
