import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import * as barrel from '../../index';
import { optimisticStore } from '../store/optimistic-store';
import { store } from '../store/store';
import { optimistic } from './optimistic-overlay';
import { createTransaction } from './transaction';

type Todo = { list: string[]; title: { text: string }; done: { n: number } };
const make = () =>
  TestBed.runInInjectionContext(() => {
    const base = store<Todo>({
      list: ['a', 'b'],
      title: { text: 't0' },
      done: { n: 0 },
    });
    return { base, opt: optimisticStore(base) };
  });

describe('optimisticStore (overlay tier): pins', () => {
  it('phantom row after a failed POST: base readers never see it, the facade drops it', () => {
    const { base, opt } = make();
    const before = base();
    const t = createTransaction();
    t.enter(() => t.overlay(opt).list.set(['a', 'b', 'tmp']));
    expect(opt.store.list()).toEqual(['a', 'b', 'tmp']);
    expect(base.list()).toEqual(['a', 'b']);
    t.restore();
    expect(opt.store.list()).toEqual(['a', 'b']);
    expect(base()).toBe(before);
  });

  it('discard never writes the base, on completion or abort', () => {
    for (const settle of ['clear', 'restore'] as const) {
      const { base, opt } = make();
      const before = base();
      const t = createTransaction();
      t.enter(() => {
        t.overlay(opt).title.text.set('guess');
        t.overlay(opt).done.n.set(5);
      });
      expect(t.entries()).toEqual([]); // the fork is not an undoable write
      t[settle]();
      expect([settle, base()]).toEqual([settle, before]);
      expect(opt.store()).toBe(before);
    }
  });

  it('base moved on an untouched path: the facade shows the move at once and keeps the guess', () => {
    const { base, opt } = make();
    const t = createTransaction();
    t.overlay(opt).title.text.set('guess');
    base.done.n.set(7);
    expect([opt.store.title.text(), opt.store.done.n()]).toEqual(['guess', 7]);
    t.clear();
    expect([opt.store.title.text(), opt.store.done.n()]).toEqual(['t0', 7]);
  });

  it('base moved on a guessed path: the guess shadows the move until settlement, then the move shows', () => {
    const { base, opt } = make();
    const t = createTransaction();
    t.overlay(opt).list.set(['a', 'b', 'tmp']);
    base.list.set(['a', 'b', 'c']); // a refetch
    expect(opt.store.list()).toEqual(['a', 'b', 'tmp']);
    t.clear();
    expect(opt.store.list()).toEqual(['a', 'b', 'c']);
  });

  it('a reconcile function merges a moved base into a guessed path', () => {
    TestBed.runInInjectionContext(() => {
      const base = store({ list: ['a', 'b'] });
      const union = (
        anc: { list: string[] },
        mine: typeof anc,
        theirs: typeof anc,
      ) => ({
        list: [
          ...theirs.list,
          ...mine.list.filter(
            (x) => !anc.list.includes(x) && !theirs.list.includes(x),
          ),
        ],
      });
      const opt = optimisticStore(base, { reconcile: union });
      const t = createTransaction();
      t.overlay(opt).list.set(['a', 'b', 'tmp']);
      base.list.set(['a', 'b', 'c']);
      expect(opt.store.list()).toEqual(['a', 'b', 'c', 'tmp']);
      t.restore();
      expect(opt.store.list()).toEqual(['a', 'b', 'c']);
    });
  });

  it('two open bodies fold in open order: a later body wins a shared path, each keeps its own', () => {
    const { opt } = make();
    const a = createTransaction();
    const b = createTransaction();
    b.overlay(opt).title.text.set('B'); // b's fork opened first, a's body is older
    a.overlay(opt).title.text.set('A');
    a.overlay(opt).done.n.set(1);
    expect([opt.store.title.text(), opt.store.done.n()]).toEqual(['B', 1]);
    b.restore();
    expect([opt.store.title.text(), opt.store.done.n()]).toEqual(['A', 1]);
    a.clear();
    expect([opt.store.title.text(), opt.store.done.n()]).toEqual(['t0', 0]);
  });

  it('a guess equal to the value it covers is no change: a later base move there shows through', () => {
    const { base, opt } = make();
    const t = createTransaction();
    t.overlay(opt).title.text.set('t0');
    base.title.text.set('t1');
    expect(opt.store.title.text()).toBe('t1');
    t.clear();
  });

  it('a user write between the reconcile and the discard wins, on completion and on abort', () => {
    for (const settle of ['clear', 'restore'] as const) {
      const { base, opt } = make();
      const t = createTransaction();
      t.overlay(opt).title.text.set('g');
      t.enter(() => base.title.text.set('server'));
      base.title.text.set('user');
      t[settle]();
      expect([settle, opt.store.title.text(), base.title.text()]).toEqual([
        settle,
        'user',
        'user',
      ]);
    }
  });

  it('one fork per body, a manual fork, a closed body throws', () => {
    const { opt } = make();
    const t = createTransaction();
    expect(t.overlay(opt)).toBe(t.overlay(opt));
    const f = opt.fork();
    f.store.title.text.set('manual');
    expect(opt.store.title.text()).toBe('manual');
    f.discard();
    f.discard();
    expect(opt.store.title.text()).toBe('t0');
    t.clear();
    expect(() => t.overlay(opt)).toThrow('closed transaction');
    expect(() =>
      createTransaction().overlay(signal(1) as unknown as typeof opt),
    ).toThrow('optimistic overlay');
  });

  it('a reader of one facade leaf does not recompute for a guess on another path', () => {
    const { opt } = make();
    let runs = 0;
    const n = computed(() => (runs++, opt.store.done.n()));
    expect([n(), runs]).toEqual([0, 1]);
    const t = createTransaction();
    t.overlay(opt).title.text.set('g');
    expect([n(), runs]).toEqual([0, 1]);
    t.overlay(opt).done.n.set(3);
    expect([n(), runs]).toEqual([3, 2]);
    t.restore();
    expect([n(), runs]).toEqual([0, 3]);
  });
});

describe('optimistic (overlay tier for a plain signal)', () => {
  it('only readers of the view see a guess; two bodies fold; settlement discards', () => {
    const liked = signal(false);
    const view = optimistic(liked);
    const base = computed(() => liked());
    const a = createTransaction();
    a.enter(() => a.overlay(view).set(true));
    expect([view(), base(), liked()]).toEqual([true, false, false]);
    expect(a.entries()).toEqual([]);
    const b = createTransaction();
    b.overlay(view).set(false);
    expect(view()).toBe(true); // b's guess equals the base: no change
    liked.set(true); // the server confirms
    b.overlay(view).set(false);
    expect(view()).toBe(false);
    b.restore();
    expect(view()).toBe(true);
    a.clear();
    expect([view(), liked()]).toEqual([true, true]);
  });

  it('is on the public barrel', () => {
    expect(barrel.optimistic).toBe(optimistic);
    expect(barrel.optimisticStore).toBe(optimisticStore);
  });
});
