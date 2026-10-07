import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { store } from '../store/store';
import { transactional } from './active-transaction';
import { guessable } from './optimistic';
import { createTransaction } from './transaction';

describe('tx.set / tx.update: writes that belong to the transaction, before or after an await', () => {
  it('records a plain signal, even written with no slice running (after an await)', async () => {
    const name = signal('a');
    const tx = createTransaction();
    await Promise.resolve();
    tx.set(name, 'b');
    expect(name()).toBe('b');
    expect(tx.entries()).toHaveLength(1);
    tx.restore();
    expect(name()).toBe('a');
  });

  it('a plain signal set directly after an await is not recorded (what tx.set fixes)', async () => {
    const name = signal('a');
    const tx = createTransaction();
    await Promise.resolve();
    name.set('b');
    tx.restore();
    expect(name()).toBe('b');
  });

  it('a transactional signal is recorded once per write, not twice', () => {
    const base = signal(1);
    const t = transactional(base);
    const tx = createTransaction();
    tx.set(t, 2);
    expect(tx.entries()).toHaveLength(1); // the wrapper records itself; tx.set adds nothing
    tx.update(t, (v) => v + 1);
    expect(t()).toBe(3);
    expect(tx.entries()).toHaveLength(2); // a second slice, a second entry
    tx.restore();
    expect(base()).toBe(1);
  });

  it('a store leaf records at its root', () => {
    const s = TestBed.runInInjectionContext(() =>
      store({ user: { name: 'a' }, n: 1 }),
    );
    const tx = createTransaction();
    tx.set(s.user.name, 'b');
    expect(s().user.name).toBe('b');
    expect(tx.entries().map((e) => e.target)).not.toContain(s.user.name);
    expect(tx.entries()).toHaveLength(1); // the root's source, once
    tx.restore();
    expect(s().user.name).toBe('a');
  });

  it('on a guessable it resolves this transaction guess; abort reverts truth and guess', () => {
    const n = guessable(signal('n0'));
    const tx = createTransaction();
    tx.guess(n, 'g');
    tx.set(n, 'server');
    expect([n(), n.truth()]).toEqual(['server', 'server']);
    tx.restore();
    expect([n(), n.truth()]).toEqual(['n0', 'n0']);
  });

  it('update applies to the current value and is undone too', () => {
    const count = signal(1);
    const tx = createTransaction();
    tx.update(count, (v) => v * 10);
    expect(count()).toBe(10);
    tx.restore();
    expect(count()).toBe(1);
  });

  it('commit keeps the writes', () => {
    const count = signal(1);
    const tx = createTransaction();
    tx.set(count, 2);
    tx.clear();
    expect(count()).toBe(2);
  });

  it('throws once the transaction is closed, like enter', () => {
    const tx = createTransaction();
    tx.clear();
    expect(() => tx.set(signal(0), 1)).toThrow(/closed/);
    expect(() => tx.update(signal(0), (v) => v)).toThrow(/closed/);
  });
});
