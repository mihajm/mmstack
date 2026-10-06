import { computed, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { derived } from '../derived';
import { keepPrevious } from '../keep-previous';
import { mutable } from '../mutable';
import { mutableStore, store, toStore } from '../store/store';
import { pausableSignal } from './pausable';
import {
  activeTransaction,
  createTransaction,
  transactional,
} from './transaction';

const inCtx = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
const targets = (t: ReturnType<typeof createTransaction>) =>
  t.entries().map((e) => e.target);

describe('store root recording', () => {
  it('a leaf write through the store API records the ROOT once; abort restores it', () => {
    const root = signal({ a: { p: 1, q: 1 }, b: { r: 1 } });
    const s = inCtx(() => toStore(root));
    const before = root();
    const t = createTransaction();
    t.enter(() => {
      s.a.p.set(2);
      s.a.q.update((v) => v + 1);
      s.b.r.set(5);
    });
    expect(targets(t)).toEqual([root]); // one entry, the root, however many paths
    expect(root()).toEqual({ a: { p: 2, q: 2 }, b: { r: 5 } });
    t.restore();
    expect(root()).toEqual(before);
    expect(root().a).toBe(before.a); // merge3 hands back the pre-write references
  });

  it('root-level set/update on the store proxy record the root', () => {
    const root = signal({ n: 1 });
    const s = inCtx(() => toStore(root));
    const t = createTransaction();
    t.enter(() => s.set({ n: 2 }));
    t.enter(() => s.update((v) => ({ n: v.n + 1 })));
    expect(root()).toEqual({ n: 3 });
    t.restore();
    expect(root()).toEqual({ n: 1 });
  });

  it('overlap through the store API: abort reverts only its own paths, a later writer keeps its paths', () => {
    const root = signal({ a: { p: 0 }, b: { r: 0 }, c: 0 });
    const s = inCtx(() => toStore(root));
    let rRuns = 0;
    const r = computed(() => (rRuns++, s.b.r()));
    expect(r()).toBe(0);

    const a = createTransaction();
    a.enter(() => {
      s.a.p.set(1);
      s.c.set(1);
    });
    const b = createTransaction();
    b.enter(() => {
      s.b.r.set(2);
      s.c.set(2);
    });
    b.clear();
    expect(r()).toBe(2);
    const runs = rRuns;

    a.restore();
    expect(root()).toEqual({ a: { p: 0 }, b: { r: 2 }, c: 2 });
    expect(r()).toBe(2);
    expect(rRuns).toBe(runs); // b.r's reference survived the merge: its reader did not rerun
  });

  it('writes outside a transaction record nothing', () => {
    const s = inCtx(() => store({ x: 1 }));
    expect(activeTransaction()).toBeNull();
    s.x.set(2);
    const t = createTransaction();
    expect(t.entries()).toEqual([]);
  });

  it('a mutable store root is snapshotted (clone kept) and restored', () => {
    const s = inCtx(() => mutableStore({ list: [1, 2] }));
    const t = createTransaction();
    t.enter(() => s.list.mutate((l) => (l.push(3), l)));
    expect(s.list()).toEqual([1, 2, 3]);
    t.restore();
    expect(s.list()).toEqual([1, 2]);
  });
});

describe('forwarding primitives record their source once', () => {
  it('derived: a write records the source, not the derived signal', () => {
    const src = signal({ x: 1, y: 1 });
    const x = derived(src, 'x');
    const t = createTransaction();
    t.enter(() => {
      x.set(2);
      x.set(3);
    });
    expect(targets(t)).toEqual([src]);
    t.restore();
    expect(src()).toEqual({ x: 1, y: 1 });
    expect(x()).toBe(1);
  });

  it('a chain of deriveds records only the first plain source', () => {
    const src = signal({ a: { b: 1 } });
    const b = derived(derived(src, 'a'), 'b');
    const t = createTransaction();
    t.enter(() => b.set(2));
    expect(targets(t)).toEqual([src]);
    t.restore();
    expect(b()).toBe(1);
  });

  it('keepPrevious: set and update record the source', () => {
    const src = signal<number | undefined>(1);
    const kept = keepPrevious(src);
    const t = createTransaction();
    t.enter(() => {
      kept.set(2);
      kept.update((v) => (v ?? 0) + 1);
    });
    expect(targets(t)).toEqual([src]);
    t.restore();
    expect(kept()).toBe(1);
  });

  it('keepPrevious over a derived: the derived records its own source, once', () => {
    const src = signal({ v: 1 as number | undefined });
    const kept = keepPrevious(derived(src, 'v'));
    const t = createTransaction();
    t.enter(() => kept.set(5));
    expect(targets(t)).toEqual([src]);
    t.restore();
    expect(kept()).toBe(1);
  });

  it('pausableSignal: a write while paused records the source and abort undoes it', () => {
    const paused = signal(true);
    const p = inCtx(() => pausableSignal(1, { pause: paused }));
    expect(p()).toBe(1);
    const t = createTransaction();
    t.enter(() => p.set(2));
    expect(t.entries()).toHaveLength(1);
    t.restore();
    paused.set(false);
    expect(p()).toBe(1);
  });

  it('mutable(): a direct write stays unrecorded (the clone happens only when recorded)', () => {
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const list = mutable([1]);
    const t = createTransaction();
    t.enter(() => list.inline((a) => a.push(2)));
    expect(t.entries()).toEqual([]);
    expect(clone).not.toHaveBeenCalled();
    clone.mockRestore();
  });
});

describe('transactional()', () => {
  it('records before forwarding; direct writes on the wrapped signal stay unrecorded', () => {
    const raw = signal(1);
    const tx = transactional(raw);
    const t = createTransaction();
    t.enter(() => {
      tx.set(2);
      tx.update((v) => v + 1);
    });
    expect(targets(t)).toEqual([raw as WritableSignal<unknown>]);
    t.enter(() => raw.set(10)); // unrecorded, and a later value than ours: abort yields
    t.restore();
    expect(raw()).toBe(10);

    const u = createTransaction();
    u.enter(() => tx.set(4));
    u.restore();
    expect([raw(), tx()]).toEqual([10, 10]);
  });

  it('over a mutable: mutate records a clone first, the wrapper notifies on in-place writes', () => {
    const raw = mutable([1]);
    const tx = transactional(raw);
    let runs = 0;
    const len = computed(() => (runs++, tx().length));
    expect(len()).toBe(1);
    const t = createTransaction();
    t.enter(() => tx.inline((a) => a.push(2)));
    expect(len()).toBe(2);
    t.restore();
    expect(raw()).toEqual([1]);
    expect(len()).toBe(1);
    expect(runs).toBe(3);
  });

  it('outside a transaction it is a plain forwarder', () => {
    const raw = signal(1);
    const tx = transactional(raw);
    tx.set(2);
    expect([raw(), tx(), tx.asReadonly()()]).toEqual([2, 2, 2]);
  });
});
