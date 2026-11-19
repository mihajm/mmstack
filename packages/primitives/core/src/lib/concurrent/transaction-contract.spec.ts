import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { isMutable, mutable } from '../mutable';
import { optimistic } from './optimistic-overlay';
import {
  createTransaction,
  injectStartTransaction,
  transactional,
  type AsyncTransactionRef,
  type TransactionRef,
} from './transaction';
import { abortTransaction } from './transaction-driver';
import { provideTransitionScope } from './transition-scope';

function starter() {
  TestBed.configureTestingModule({ providers: [provideTransitionScope()] });
  return TestBed.runInInjectionContext(() => injectStartTransaction());
}

describe('transactional', () => {
  it('over a mutable: mutate writes in place and is undone by restore', () => {
    const list = transactional(mutable([1]));
    const t = createTransaction();
    t.enter(() =>
      list.mutate((a) => {
        a.push(2);
        return a;
      }),
    );
    expect(list()).toEqual([1, 2]);
    t.restore();
    expect(list()).toEqual([1]);
  });

  it('over a plain signal: stays plain', () => {
    expect(isMutable(transactional(signal(1)))).toBe(false);
  });
});

describe('createTransaction', () => {
  it('every entry gets a fresh, increasing generation', () => {
    const t = createTransaction();
    const sigs = [signal(0), signal(0), signal(0)];
    for (const s of sigs) t.record(s as WritableSignal<unknown>);
    const g = t.entries().map((e) => e.generation);
    expect(g.length).toBe(3);
    expect(g[0] < g[1] && g[1] < g[2]).toBe(true);
    t.clear();
  });

  it('releasing a retain twice releases it once', () => {
    const t = createTransaction();
    const r1 = t.retain();
    const r2 = t.retain();
    r1();
    r1();
    expect(t.retained()).toBe(1);
    r2();
    expect(t.retained()).toBe(0);
    t.clear();
  });

  it('a fork opened after a transaction folds over it: the later one wins', () => {
    const base = signal(0);
    const view = optimistic(base);
    const t = createTransaction();
    const m = view.fork();
    t.overlay(view).set(1);
    m.value.set(2);
    expect(view()).toBe(2);
    m.discard();
    t.clear();
  });
});

describe('startTransaction: body results', () => {
  it('a body returning null or a plain object is synchronous', async () => {
    const start = starter();
    const results = [
      start(() => null as unknown as void),
      start(() => ({ then: 1 }) as unknown as void),
    ];
    for (const r of results) {
      r.abort();
      await expect(r.done).resolves.toBeUndefined();
    }
  });

  it('nested inside a raw createTransaction().enter, it opens its own transaction', () => {
    const start = starter();
    const raw = createTransaction();
    let inner!: TransactionRef;
    expect(() =>
      raw.enter(() => (inner = start(() => undefined))),
    ).not.toThrow();
    expect(typeof inner.abort).toBe('function');
    inner.abort();
    raw.clear();
  });

  it('inside a body whose transaction was already settled, a new start opens its own', () => {
    const start = starter();
    const s = signal(0);
    let late!: TransactionRef;
    start(() => {
      start(() => undefined).abort();
      late = start((tx) => tx.set(s, 5));
    });
    expect(s()).toBe(5);
    late.abort();
    expect(s()).toBe(0);
  });
});

describe('abortTransaction: the reasoned abort seam', () => {
  it('on a sync ref, undoes its writes', () => {
    const start = starter();
    const s = signal(0);
    const t = start((tx) => {
      tx.set(s, 1);
      tx.retain();
    });
    abortTransaction(t, 'superseded');
    expect(s()).toBe(0);
  });

  for (const nested of ['sync', 'async'] as const) {
    it(`on a ${nested} nested ref, aborts the outer with that reason`, async () => {
      const start = starter();
      const s = signal(0);
      let inner!: TransactionRef | AsyncTransactionRef;
      const outer = start(async (tx) => {
        tx.set(s, 1);
        inner =
          nested === 'sync'
            ? start(() => undefined)
            : start(() => new Promise<void>(() => undefined));
        await new Promise<void>(() => undefined);
      });
      abortTransaction(inner, 'superseded');
      await expect(outer.done).resolves.toEqual({
        kind: 'aborted',
        reason: 'superseded',
      });
      expect(s()).toBe(0);
    });
  }
});
