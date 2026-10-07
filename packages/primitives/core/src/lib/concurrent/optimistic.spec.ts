import {
  Component,
  computed,
  Injector,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import * as barrel from '../../index';
import { mutable } from '../mutable';
import { recordTargetOf } from './active-transaction';
import { guessable } from './optimistic';
import { createTransaction, injectStartTransaction } from './transaction';
import {
  createTransitionScope,
  injectTransitionScope,
  provideTransitionScope,
} from './transition-scope';

const scope = () =>
  TestBed.runInInjectionContext(() =>
    createTransitionScope({ injector: TestBed.inject(Injector) }),
  );

describe('guessable (live tier): pins', () => {
  it('phantom row after a failed POST: the temporary row is gone; a refetch that landed mid-flight stays', () => {
    const rows = guessable(signal(['a', 'b']));
    const post = createTransaction();
    post.guess(rows, ['a', 'b', 'tmp']);
    expect(rows()).toEqual(['a', 'b', 'tmp']);
    expect(rows.truth()).toEqual(['a', 'b']);
    post.restore(); // the POST failed
    expect(rows()).toEqual(['a', 'b']);

    // the server list arrives through a linkedSignal over a query value
    const server = signal(['a', 'b']);
    const live = guessable(linkedSignal(() => server()));
    const again = createTransaction();
    again.guess(live, ['a', 'b', 'tmp']);
    expect(live()).toEqual(['a', 'b', 'tmp']);
    server.set(['a', 'b', 'c']); // a refetch lands while the POST is in flight
    expect(live()).toEqual(['a', 'b', 'c']);
    again.restore();
    expect(live()).toEqual(['a', 'b', 'c']);
  });

  it('two overlapping bodies, the newer settles first: readers keep the older guess, then truth', () => {
    const n = guessable(signal('n0'));
    const a = createTransaction();
    a.guess(n, '1');
    const b = createTransaction();
    b.guess(n, '2');
    expect(n()).toBe('2');
    b.restore();
    expect(n()).toBe('1');
    a.clear();
    expect(n()).toBe('n0');
  });

  it('two overlapping bodies, the older settles first: the newer guess stays, then truth, never the older guess', () => {
    const n = guessable(signal('n0'));
    const a = createTransaction();
    a.guess(n, '1');
    const b = createTransaction();
    b.guess(n, '2');
    a.clear();
    expect(n()).toBe('2');
    b.restore();
    expect(n()).toBe('n0');
  });

  it('an older body guessing under a newer open guess does not take the screen', () => {
    const n = guessable(signal('n0'));
    const a = createTransaction();
    const b = createTransaction();
    b.guess(n, '2');
    a.guess(n, '3');
    expect(n()).toBe('2');
    b.restore();
    expect(n()).toBe('3');
  });

  it('a reconcile on the node resolves its own guess and replaces every other open guess at once', () => {
    const n = guessable(signal('n0'));
    const a = createTransaction();
    a.guess(n, '1');
    const b = createTransaction();
    b.guess(n, '2');
    b.enter(() => n.set('truthB'));
    expect(n()).toBe('truthB');
    b.clear();
    a.clear();
    expect(n()).toBe('truthB');
  });

  it('a user write between the reconcile and the revert wins, on completion and on abort', () => {
    for (const settle of ['clear', 'restore'] as const) {
      const n = guessable(signal('n0'));
      const t = createTransaction();
      t.guess(n, 'g');
      t.enter(() => n.set('server'));
      n.set('user');
      t[settle]();
      expect([settle, n()]).toEqual([settle, 'user']);
    }
  });

  it('a user write before the reconcile: completion keeps the reconcile, abort restores the user value', () => {
    for (const [settle, want] of [
      ['clear', 'server'],
      ['restore', 'user'],
    ] as const) {
      const n = guessable(signal('n0'));
      const t = createTransaction();
      t.guess(n, 'g');
      n.set('user');
      t.enter(() => n.set('server'));
      t[settle]();
      expect([settle, n()]).toEqual([settle, want]);
    }
  });

  it('a buried guess never comes back after the burying writer aborts', () => {
    const n = guessable(signal('n0'));
    const a = createTransaction();
    a.guess(n, 'g');
    const b = createTransaction();
    b.enter(() => n.set('w'));
    expect(n()).toBe('w');
    b.restore();
    expect(n()).toBe('n0');
    expect(n.truth()).toBe('n0');
    a.restore();
    expect(n()).toBe('n0');
  });

  it('a second writer records the truth beneath a guess; its abort restores that truth under a later guess', () => {
    const n = guessable(signal('n0'));
    const a = createTransaction();
    a.guess(n, 'g');
    const b = createTransaction();
    n.set('t1'); // a refetch buries g
    a.guess(n, 'g2');
    b.enter(() => n.set('w')); // buries g2; b recorded t1, not g2
    a.guess(n, 'g3');
    b.restore(); // a restore buries nothing
    expect([n(), n.truth()]).toEqual(['g3', 't1']);
    a.restore();
    expect(n()).toBe('t1');
  });

  it('an equal-value authoritative write is seen: it buries the guess and survives completion', () => {
    const n = guessable(signal('off'));
    const t = createTransaction();
    t.guess(n, 'on');
    n.set('off'); // the server answers with the value the guess covered
    expect(n()).toBe('off');
    t.clear();
    expect(n()).toBe('off');

    // a confirmation equal to the guess, written while the body's own write is in effect
    const m = guessable(signal('off'));
    const u = createTransaction();
    u.enter(() => m.set('on'));
    m.set('on'); // the server confirms the same value
    u.restore();
    expect(m()).toBe('on');
  });

  it('LIMIT: an equal-value set made directly on the wrapped signal is not seen', () => {
    const inner = signal('off');
    const n = guessable(inner);
    const t = createTransaction();
    t.guess(n, 'on');
    inner.set('off'); // bypasses the guessable: no notification, no stamp
    expect(n()).toBe('on');
    t.clear();
    expect(n()).toBe('off');
  });
});

describe('guessable: writes inside the guessing transaction', () => {
  it('resolve the guess to the value the signal stored, even when its equality rejects the write', () => {
    const original = { id: 1, label: 'original' };
    const truth = signal(original, { equal: (a, b) => a.id === b.id });
    const n = guessable(truth);
    const t = createTransaction();
    t.guess(n, { id: 1, label: 'optimistic' });
    expect(n().label).toBe('optimistic');
    t.enter(() => n.set({ id: 1, label: 'server' }));
    expect(truth()).toBe(original); // rejected as equal
    expect(n()).toBe(original); // the resolved guess is what the signal holds
    t.clear();
    expect(n()).toBe(original);
  });

  it('resolve the guess to an accepted write', () => {
    const n = guessable(signal('n0'));
    const t = createTransaction();
    t.guess(n, 'g');
    t.enter(() => n.set('server'));
    expect([n(), n.truth()]).toEqual(['server', 'server']);
    t.clear();
    expect(n()).toBe('server');
  });

  it('update resolves the guess too, and applies to the truth, not the guess on screen', () => {
    const n = guessable(signal('n0'));
    const t = createTransaction();
    t.guess(n, 'g');
    t.enter(() => n.update((v) => `${v}!`));
    expect([n(), n.truth()]).toEqual(['n0!', 'n0!']);
    t.restore();
    expect(n()).toBe('n0'); // aborted: the truth rolls back and the guess ends
  });

  it('a write outside tx.enter (after an await, say) is outside the transaction: it buries the guess', () => {
    const n = guessable(signal('n0'));
    const t = createTransaction();
    t.guess(n, 'g');
    n.set('server'); // no slice of t is running
    expect(n()).toBe('server');
    t.guess(n, 'g2');
    expect(n()).toBe('g2'); // a later guess shows over the plain truth
    t.clear();
    expect(n()).toBe('server');
  });
});

describe('guessable under hold() and commit()', () => {
  it('a held reader shows a guess laid during the hold live, and its frozen frame is the truth', () => {
    const s = scope();
    const n = guessable(signal('n0'));
    const held = s.hold(n);
    expect(held()).toBe('n0');
    s.beginHold();
    const t = createTransaction();
    t.guess(n, 'g');
    expect(held()).toBe('g');
    n.set('t1'); // buries the guess; the frame stays at the pre-hold truth
    expect([n(), held()]).toEqual(['t1', 'n0']);
    t.guess(n, 'g2');
    expect(held()).toBe('g2');
    t.restore();
    expect([n(), held()]).toEqual(['t1', 'n0']);
    s.endHold();
    expect(held()).toBe('t1');
  });

  it('a hold opened over a guess never keeps the reverted guess', () => {
    const s = scope();
    const n = guessable(signal('n0'));
    const held = s.hold(n);
    const t = createTransaction();
    t.guess(n, 'g');
    expect(held()).toBe('g');
    s.beginHold();
    expect(held()).toBe('g');
    t.restore();
    expect(held()).toBe('n0');
    s.endHold();
    expect(held()).toBe('n0');
  });

  it('commit() shows a guess live and freezes the truth while the scope is pending', () => {
    const s = scope();
    const status = signal<'resolved' | 'loading'>('resolved');
    s.add({
      status,
      isLoading: computed(() => status() === 'loading'),
      hasValue: () => true,
    });
    const n = guessable(signal('n0'));
    const committed = s.commit(n);
    expect(committed()).toBe('n0');
    status.set('loading');
    n.set('t1');
    expect(committed()).toBe('n0');
    const t = createTransaction();
    t.guess(n, 'g');
    expect(committed()).toBe('g');
    t.restore();
    expect(committed()).toBe('n0');
    status.set('resolved');
    expect(committed()).toBe('t1');
  });

  @Component({
    selector: 'mm-optimistic-host',
    template: ``,
    providers: [provideTransitionScope()],
  })
  class Host {
    readonly scope = injectTransitionScope();
    readonly start = injectStartTransaction();
    readonly n = guessable(signal('n0'));
    readonly held = this.scope.hold(this.n);
  }

  it('a reader mounted mid-transaction starts from the truth before the hold, never a cell or a guess', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    expect(host.held()).toBe('n0');
    let release!: () => void;
    const ref = host.start((tx) => {
      release = tx.retain();
      host.n.set('w');
      tx.guess(host.n, 'g');
    });
    const late = host.scope.hold(host.n);
    expect(host.held()).toBe('g');
    expect(late()).toBe('g');
    ref.abort();
    expect([host.n(), host.held(), late()]).toEqual(['n0', 'n0', 'n0']);
    release();

    const ref2 = host.start((tx) => {
      release = tx.retain();
      host.n.set('w2');
    });
    const mounted = host.scope.hold(host.n);
    expect([host.n(), host.held(), mounted()]).toEqual(['w2', 'n0', 'n0']);
    release();
    ref2.abort();
  });
});

describe('guessable: ledger, API edges, reactivity', () => {
  it('a guess is a guess entry on its own target; the truth is recorded only by authoritative writes', () => {
    const n = guessable(signal('n0'));
    const port = recordTargetOf(n);
    const t = createTransaction();
    t.enter(() => {
      t.guess(n, 'g');
      n.set('v');
      t.guess(n, 'g2');
    });
    const entries = t.entries();
    expect(entries.map((e) => [e.kind, e.target === port])).toEqual([
      ['guess', false],
      ['authoritative', true],
    ]);
    expect(new Set(entries.map((e) => e.generation)).size).toBe(2);
    t.restore();
    expect(n()).toBe('n0');
  });

  it('guess throws on a closed transaction and on a node that is not guessable', () => {
    const n = guessable(signal(0));
    const t = createTransaction();
    t.clear();
    expect(() => t.guess(n, 1)).toThrow('closed transaction');
    const u = createTransaction();
    expect(() => u.guess(signal(0) as unknown as typeof n, 1)).toThrow(
      'guessable',
    );
    expect(() => guessable(mutable({ a: 1 }))).toThrow('mutable');
  });

  it('update applies to the truth, not to a guess on screen', () => {
    const n = guessable(signal(10));
    const t = createTransaction();
    t.guess(n, 11);
    n.update((v) => v + 5);
    expect(n()).toBe(15);
  });

  it('readers recompute once per visible change and not for a guess that is not on top', () => {
    const n = guessable(signal('n0'));
    let runs = 0;
    const d = computed(() => (runs++, n().toUpperCase()));
    const trace: string[] = [];
    const read = () => trace.push(`${d()}#${runs}`);
    read();
    const a = createTransaction();
    const b = createTransaction();
    b.guess(n, 'b');
    read();
    a.guess(n, 'a'); // under b's guess: nothing visible changes
    read();
    b.restore();
    read();
    a.clear();
    read();
    expect(trace).toEqual(['N0#1', 'B#2', 'B#2', 'A#3', 'N0#4']);
  });

  it('settlement drops only the settling body’s guesses, whichever way it ends', () => {
    for (const settle of ['clear', 'restore'] as const) {
      const n = guessable(signal('n0'));
      const m = guessable(signal('m0'));
      const a = createTransaction();
      const b = createTransaction();
      a.guess(n, 'an');
      b.guess(m, 'bm');
      a[settle]();
      expect([settle, n(), m()]).toEqual([settle, 'n0', 'bm']);
      b[settle]();
      expect(untracked(m)).toBe('m0');
    }
  });

  it('is on the public barrel', () => {
    expect(barrel.guessable).toBe(guessable);
  });
});
