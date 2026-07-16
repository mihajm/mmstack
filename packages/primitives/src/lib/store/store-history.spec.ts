import { TestBed } from '@angular/core/testing';
import { opSync } from './op-sync';
import { store } from './store';
import { storeHistory } from './store-history';

describe('storeHistory', () => {
  function setup() {
    return TestBed.runInInjectionContext(() => {
      const s = store<{ title: string; n: { a: number } }>({
        title: 'init',
        n: { a: 0 },
      });
      const history = storeHistory(s, { origin: 'local' });
      return { s, history };
    });
  }
  const flush = () => TestBed.tick();

  it('undoes and redoes a single change', () => {
    const { s, history } = setup();
    expect(history.canUndo()).toBe(false);

    s.title.set('edited');
    flush();
    expect(history.canUndo()).toBe(true);

    history.undo();
    expect(s().title).toBe('init');
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);

    history.redo();
    expect(s().title).toBe('edited');
    expect(history.canRedo()).toBe(false);
  });

  it('walks a multi-step linear timeline', () => {
    const { s, history } = setup();
    s.title.set('a');
    flush();
    s.title.set('b');
    flush();
    s.n.a.set(5);
    flush();

    history.undo(); // n.a → 0
    expect(s().n.a).toBe(0);
    expect(s().title).toBe('b');
    history.undo(); // title → a
    expect(s().title).toBe('a');
    history.redo(); // title → b
    expect(s().title).toBe('b');
    history.redo(); // n.a → 5
    expect(s().n.a).toBe(5);
    expect(history.canRedo()).toBe(false);
  });

  it('a fresh edit after an undo forks the timeline (clears redo)', () => {
    const { s, history } = setup();
    s.title.set('a');
    flush();
    history.undo();
    expect(history.canRedo()).toBe(true);

    s.title.set('divergent');
    flush();
    expect(history.canRedo()).toBe(false);
    history.undo();
    expect(s().title).toBe('init');
  });

  it('undo restores a deleted key exactly (invert semantics)', () => {
    const s = TestBed.runInInjectionContext(() =>
      store<Record<string, unknown>>({ keep: 1, drop: 2 }),
    );
    const history = TestBed.runInInjectionContext(() =>
      storeHistory(s, { origin: 'local' }),
    );
    s.update((v) => {
      const next = { ...v };
      delete next['drop'];
      return next;
    });
    flush();
    expect(s()).toEqual({ keep: 1 });

    history.undo();
    expect(s()).toEqual({ keep: 1, drop: 2 }); // key comes back with its value
  });

  it('collaborative (track: syncClient): a remote peer edit is NOT undoable, a local one is', () => {
    const relayPipe = TestBed.runInInjectionContext(() => {
      const a = store<{ v: string }>({ v: 'init' });
      const b = store<{ v: string }>({ v: 'init' });
      const syncA = opSync(a, { writer: 'wa', origin: 'a' });
      const syncB = opSync(b, { writer: 'wb', origin: 'b' });
      // track A's LOCAL stream only
      const history = storeHistory(a, { origin: 'a', track: syncA });
      syncA.subscribe((env) => syncB.receive(env));
      syncB.subscribe((env) => syncA.receive(env));
      return { a, b, history };
    });

    // remote peer writes → lands on A's store, but must not enter A's history
    relayPipe.b.v.set('from-b');
    flush();
    expect(relayPipe.a().v).toBe('from-b'); // replicated
    expect(relayPipe.history.canUndo()).toBe(false); // but not undoable here

    relayPipe.a.v.set('from-a'); // local edit is undoable
    flush();
    expect(relayPipe.history.canUndo()).toBe(true);
    relayPipe.history.undo();
    expect(relayPipe.a().v).toBe('from-b'); // reverts to the remote value it was built on
    flush();
    expect(relayPipe.b().v).toBe('from-b'); // and the undo propagated to the peer
  });

  it('clear() empties both stacks', () => {
    const { s, history } = setup();
    s.title.set('x');
    flush();
    history.clear();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});

describe('storeHistory — coalescing (typing runs undo as a unit)', () => {
  function setup(coalesce?: { ms: number; samePath?: boolean }) {
    let at = 0;
    const clock = { now: () => at, tick: (ms: number) => (at += ms) };
    const bundle = TestBed.runInInjectionContext(() => {
      const s = store<{ title: string; n: { a: number } }>({
        title: 'init',
        n: { a: 0 },
      });
      const history = storeHistory(s, {
        origin: 'local',
        coalesce: coalesce ?? { ms: 1000 },
        now: clock.now,
      });
      return { s, history };
    });
    return { ...bundle, clock };
  }
  const flush = () => TestBed.tick();

  it('a same-field typing run collapses into ONE entry: one undo restores the pre-run value', () => {
    const { s, history, clock } = setup();
    for (const v of ['h', 'he', 'hel', 'hell', 'hello']) {
      s.title.set(v);
      flush();
      clock.tick(100);
    }
    history.undo();
    expect(s().title).toBe('init');
    expect(history.canUndo()).toBe(false); // the whole run was one entry

    history.redo();
    expect(s().title).toBe('hello'); // and redo restores the run's final state
    expect(history.canRedo()).toBe(false);
  });

  it('merged undo/redo is exactly equivalent to sequential undo/redo of the same edits', () => {
    const run = (coalesce?: { ms: number }) => {
      const s = TestBed.runInInjectionContext(() =>
        store<Record<string, unknown>>({ n: { a: 0 }, keep: 1 }),
      );
      const history = TestBed.runInInjectionContext(() =>
        storeHistory(s, {
          origin: 'local',
          ...(coalesce
            ? { coalesce: { ...coalesce, samePath: false }, now: () => 0 }
            : undefined),
        }),
      );
      // a multi-shape burst: leaf edit, key add, key delete — same paths+kinds never repeat,
      // so merge on time alone
      s.update((v) => ({ ...v, n: { a: 5 } }));
      flush();
      s.update((v) => ({ ...v, added: 'x' }));
      flush();
      s.update((v) => {
        const next = { ...v };
        delete next['keep'];
        return next;
      });
      flush();
      return { s, history };
    };

    const merged = run({ ms: 1000 });
    const sequential = run();

    merged.history.undo(); // one entry
    while (sequential.history.canUndo()) sequential.history.undo();
    expect(merged.s()).toEqual(sequential.s());
    expect(merged.s()).toEqual({ n: { a: 0 }, keep: 1 });

    merged.history.redo();
    while (sequential.history.canRedo()) sequential.history.redo();
    expect(merged.s()).toEqual(sequential.s());
    expect(merged.s()).toEqual({ n: { a: 5 }, added: 'x' });
  });

  it('merge order is exact under overlapping paths: a leaf edit then a wholesale ancestor replace undo to the ORIGINAL leaf', () => {
    const s = TestBed.runInInjectionContext(() =>
      store<Record<string, unknown>>({ n: { a: 0 } }),
    );
    const history = TestBed.runInInjectionContext(() =>
      storeHistory(s, {
        origin: 'local',
        coalesce: { ms: 1000, samePath: false },
        now: () => 0,
      }),
    );
    s.update((v) => ({ ...v, n: { a: 5 } })); // leaf: ['n','a'] 0 → 5
    flush();
    s.update((v) => ({ ...v, n: 3 })); // type change forces one op at ['n']
    flush();

    history.undo(); // must apply the ancestor's inverse LAST, restoring a: 0 (not a: 5)
    expect(s()).toEqual({ n: { a: 0 } });
    history.redo();
    expect(s()).toEqual({ n: 3 });
  });

  it('a different path or a different op kind breaks the run', () => {
    const { s, history, clock } = setup();
    s.title.set('a');
    flush();
    clock.tick(10);
    s.n.a.set(5); // different path within the window → its own entry
    flush();

    history.undo();
    expect(s()).toEqual({ title: 'a', n: { a: 0 } });
    history.undo();
    expect(s()).toEqual({ title: 'init', n: { a: 0 } });

    // kind change at the SAME path: a set run then a key delete are separate actions
    const s2 = TestBed.runInInjectionContext(() =>
      store<Record<string, unknown>>({ x: 1 }),
    );
    const h2 = TestBed.runInInjectionContext(() =>
      storeHistory(s2, { origin: 'local', coalesce: { ms: 1000 }, now: () => 0 }),
    );
    s2.update((v) => ({ ...v, x: 2 }));
    flush();
    s2.update((v) => {
      const next = { ...v };
      delete next['x'];
      return next;
    });
    flush();
    h2.undo();
    expect(s2()).toEqual({ x: 2 }); // only the delete undone: the set was a separate entry
  });

  it('exceeding the window breaks the run', () => {
    const { s, history, clock } = setup({ ms: 300 });
    s.title.set('a');
    flush();
    clock.tick(301);
    s.title.set('b');
    flush();

    history.undo();
    expect(s().title).toBe('a'); // two entries, not one
    history.undo();
    expect(s().title).toBe('init');
  });

  it('checkpoint() closes the run (the blur boundary)', () => {
    const { s, history, clock } = setup();
    s.title.set('a');
    flush();
    history.checkpoint();
    clock.tick(10);
    s.title.set('b'); // same path, inside the window — but past the checkpoint
    flush();

    history.undo();
    expect(s().title).toBe('a');
    history.undo();
    expect(s().title).toBe('init');
  });

  it('an undo/redo closes the run: the next edit never merges into a restored entry', () => {
    const { s, history, clock } = setup();
    s.title.set('a');
    flush();
    clock.tick(10);
    history.undo();
    history.redo(); // title back to 'a'
    clock.tick(10);
    s.title.set('ab'); // same path, inside the window — but across an undo/redo boundary
    flush();

    history.undo();
    expect(s().title).toBe('a'); // NOT 'init': the post-redo edit was its own entry
  });

  it('samePath: false merges edits across different paths into one entry', () => {
    const { s, history, clock } = setup({ ms: 1000, samePath: false });
    s.title.set('a');
    flush();
    clock.tick(10);
    s.n.a.set(5);
    flush();

    history.undo();
    expect(s()).toEqual({ title: 'init', n: { a: 0 } }); // both reverted at once
    expect(history.canUndo()).toBe(false);
  });

  it('collaborative: a coalesced run undoes as a unit and the undo propagates to the peer', () => {
    const wired = TestBed.runInInjectionContext(() => {
      const a = store<{ v: string }>({ v: 'init' });
      const b = store<{ v: string }>({ v: 'init' });
      const syncA = opSync(a, { writer: 'wa', origin: 'a' });
      const syncB = opSync(b, { writer: 'wb', origin: 'b' });
      const history = storeHistory(a, {
        origin: 'a',
        track: syncA,
        coalesce: { ms: 1000 },
        now: () => 0,
      });
      syncA.subscribe((env) => syncB.receive(env));
      syncB.subscribe((env) => syncA.receive(env));
      return { a, b, history };
    });

    for (const v of ['h', 'he', 'hey']) {
      wired.a.v.set(v);
      flush();
    }
    expect(wired.b().v).toBe('hey');

    wired.history.undo(); // one step past the whole run
    flush();
    expect(wired.a().v).toBe('init');
    expect(wired.b().v).toBe('init'); // the undo emitted and replicated
    expect(wired.history.canUndo()).toBe(false);
  });
});
