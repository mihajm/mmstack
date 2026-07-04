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
