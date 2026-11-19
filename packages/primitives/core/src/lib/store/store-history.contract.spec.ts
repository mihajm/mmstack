import { Injector, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  diffOps,
  type EmitContext,
  type OpBatch,
  type OpLogDriver,
  type StoreOp,
} from './op-log';
import { store } from './store';
import { storeHistory, type StoreHistoryOptions } from './store-history';

type Root = Record<string, unknown>;
const EPOCH = 1_700_000_000_000;
const tick = () => TestBed.tick();
const noDriver: OpLogDriver = () => ({ destroy: () => undefined });

/** A hand-driven track: `mine` is recorded as my change, `peer` writes the store unrecorded. */
function tracked<T extends object>(
  initial: T,
  opt: Omit<StoreHistoryOptions, 'track'> = {},
) {
  const source: WritableSignal<T> = signal(initial);
  let cb: ((b: OpBatch, ctx?: EmitContext) => void) | null = null;
  const unsubscribe = vi.fn(() => (cb = null));
  const clock = { at: EPOCH };
  const history = storeHistory(source, {
    driver: noDriver,
    now: () => clock.at,
    ...opt,
    track: { subscribe: (fn) => ((cb = fn), unsubscribe) },
  });
  let version = 0;
  const mine = (next: T, withCtx = true) => {
    const ops = diffOps(source(), next, { arrays: 'unit' });
    source.set(next);
    const batch = { origin: 'me', version: ++version, ops };
    if (withCtx) cb?.(batch, { root: next });
    else cb?.(batch);
  };
  const emit = (ops: StoreOp[]) =>
    cb?.({ origin: 'me', version: ++version, ops });
  const peer = (next: T) => source.set(next);
  return { source, history, mine, peer, emit, clock, unsubscribe };
}

describe('storeHistory: options and lifecycle', () => {
  it('works with no options at all', () => {
    const s = TestBed.runInInjectionContext(() => store({ title: 'init' }));
    const history = TestBed.runInInjectionContext(() => storeHistory(s));
    s.title.set('edited');
    tick();
    expect(history.canUndo()).toBe(true);
    history.undo();
    expect(s().title).toBe('init');
    history.redo();
    expect(s().title).toBe('edited');
  });

  it('runs outside an injection context with an explicit injector', () => {
    const s = TestBed.runInInjectionContext(() => store({ title: 'init' }));
    const history = storeHistory(s, { injector: TestBed.inject(Injector) });
    s.title.set('edited');
    tick();
    history.undo();
    expect(s().title).toBe('init');
  });

  it('a fresh history has nothing to undo or redo, and both are no-ops', () => {
    const { source, history } = tracked<Root>({ a: 1 });
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    history.redo();
    history.undo();
    expect(source()).toStrictEqual({ a: 1 });
  });

  it('limit keeps only the most recent entries', () => {
    const { source, history, mine } = tracked<Root>({ x: 0 }, { limit: 2 });
    for (const x of [1, 2, 3]) mine({ x });
    history.undo();
    history.undo();
    expect(source()).toStrictEqual({ x: 1 });
    expect(history.canUndo()).toBe(false);
    history.undo();
    expect(source()).toStrictEqual({ x: 1 });
  });

  it('limit counts entries exactly: as many edits as the limit all undo', () => {
    const { source, history, mine } = tracked<Root>({ x: 0 }, { limit: 2 });
    mine({ x: 1 });
    mine({ x: 2 });
    history.undo();
    history.undo();
    expect(source()).toStrictEqual({ x: 0 });
  });

  it('the default limit is 100 entries', () => {
    const { source, history, mine } = tracked<Root>({ x: 0 });
    for (let x = 1; x <= 101; x++) mine({ x });
    let undos = 0;
    while (history.canUndo()) {
      history.undo();
      undos++;
    }
    expect(undos).toBe(100);
    expect(source()).toStrictEqual({ x: 1 });
  });

  it('keeps tracking after clear()', () => {
    const { history, mine } = tracked<Root>({ x: 0 });
    mine({ x: 1 });
    history.clear();
    expect(history.canUndo()).toBe(false);
    mine({ x: 2 });
    expect(history.canUndo()).toBe(true);
    mine({ x: 3 });
    history.undo();
    history.undo();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });

  it('destroy() empties both stacks and stops recording self-diffed changes', () => {
    const s = TestBed.runInInjectionContext(() => store({ x: 0 }));
    const history = TestBed.runInInjectionContext(() => storeHistory(s));
    s.x.set(1);
    tick();
    history.undo();
    s.x.set(2);
    tick();
    expect(history.canUndo()).toBe(true);
    history.destroy();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    s.x.set(3);
    tick();
    expect(history.canUndo()).toBe(false);
  });

  it('destroy() unsubscribes from the track and stops the driver it was given', () => {
    const stop = vi.fn();
    const { history, mine, unsubscribe } = tracked<Root>(
      { x: 0 },
      { driver: () => ({ destroy: stop }) },
    );
    mine({ x: 1 });
    history.destroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    mine({ x: 2 });
    expect(history.canUndo()).toBe(false);
  });

  it('falls back to reading the store when the track passes no EmitContext', () => {
    const { source, history, mine } = tracked<Root>({ x: 0 });
    mine({ x: 1 }, false);
    history.undo();
    expect(source()).toStrictEqual({ x: 0 });
  });

  it('a tracked batch that changes no value leaves nothing to undo', () => {
    const { history, emit } = tracked<Root>({ a: 1 });
    emit([{ kind: 'clear', path: ['a'] }]);
    expect(history.canUndo()).toBe(false);
  });
});

describe('storeHistory: selective undo', () => {
  it('delete, undo, redo leaves the key absent (never present holding undefined)', () => {
    const { source, history, mine } = tracked<Root>({ keep: 1, drop: 2 });
    mine({ keep: 1 });
    history.undo();
    expect(source()).toStrictEqual({ keep: 1, drop: 2 });
    history.redo();
    expect(Object.hasOwn(source(), 'drop')).toBe(false);
  });

  it('undo after a peer replaced the parent with null does not throw and keeps null', () => {
    const { source, history, mine, peer } = tracked<Root>({ a: { b: 1 } });
    mine({ a: { b: 2 } });
    peer({ a: null });
    expect(() => history.undo()).not.toThrow();
    expect(source()).toStrictEqual({ a: null });
  });

  it('undoing my delete restores my value over a peer re-add', () => {
    const { source, history, mine, peer } = tracked<Root>({ a: 1, k: 0 });
    mine({ k: 0 });
    peer({ a: 9, k: 0 });
    history.undo();
    expect(source()).toStrictEqual({ a: 1, k: 0 });
  });

  it('undoing my add after a peer edited it keeps their value and leaves no redo entry', () => {
    const { source, history, mine, peer } = tracked<Root>({});
    mine({ a: 1 });
    peer({ a: 2 });
    history.undo();
    expect(source()).toStrictEqual({ a: 2 });
    expect(history.canRedo()).toBe(false);
  });

  it('an untouched path undoes as is, without asking the merge policy', () => {
    const merge = vi.fn((_a: unknown, _m: unknown, t: unknown) => t);
    const { source, history, mine } = tracked<Root>(
      { n: 1 },
      { policies: [{ path: ['n'], merge }] },
    );
    mine({ n: 2 });
    history.undo();
    expect(source()).toStrictEqual({ n: 1 });
    expect(merge).not.toHaveBeenCalled();
  });

  it('a path another writer changed merges through the policy, which gets the path', () => {
    const merge = vi.fn((_a: unknown, _m: unknown, t: unknown) => t);
    const { source, history, mine, peer } = tracked<Root>(
      { n: 1 },
      { policies: [{ path: ['n'], merge }] },
    );
    mine({ n: 2 });
    peer({ n: 3 });
    history.undo();
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge.mock.calls[0]).toEqual([2, 1, 3, { path: ['n'] }]);
    expect(source()).toStrictEqual({ n: 3 });
  });

  it('undoes a change to a store whose root is an array', () => {
    const s = signal([1, 2]);
    const history = TestBed.runInInjectionContext(() => storeHistory(s));
    s.set([1, 2, 3]);
    tick();
    history.undo();
    expect(s()).toStrictEqual([1, 2]);
  });

  it('undo emits pending writes first: an unflushed edit is its own entry', () => {
    const s = TestBed.runInInjectionContext(() => store({ x: 0 }));
    const history = TestBed.runInInjectionContext(() => storeHistory(s));
    s.x.set(1);
    tick();
    s.x.set(2);
    history.undo();
    expect(s().x).toBe(1);
    history.undo();
    expect(s().x).toBe(0);
  });
});

describe('storeHistory: coalescing boundaries', () => {
  const co = { coalesce: { ms: 1000 } };

  it('keeps paths apart in the run signature: m[1][23] and m[12][3] are two entries', () => {
    const grid = () =>
      Array.from({ length: 13 }, () => Array<number>(24).fill(0));
    const s = TestBed.runInInjectionContext(() => signal({ m: grid() }));
    const history = TestBed.runInInjectionContext(() =>
      storeHistory(s, { ...co, now: () => EPOCH }),
    );
    const edit = (r: number, c: number) =>
      s.update(({ m }) => ({
        m: m.map((row, i) =>
          i === r ? row.map((v, j) => (j === c ? 1 : v)) : row,
        ),
      }));
    edit(1, 23);
    tick();
    edit(12, 3);
    tick();
    history.undo();
    expect(s().m[12][3]).toBe(0);
    expect(s().m[1][23]).toBe(1);
  });

  it('keeps ops apart in the run signature: [a, "bset:c"] and ["aset:b", c] are two entries', () => {
    const init = { a: 0, 'bset:c': 0, 'aset:b': 0, c: 0 };
    const { source, history, mine } = tracked<Root>(init, co);
    mine({ ...init, a: 1, 'bset:c': 1 });
    mine({ ...init, a: 1, 'bset:c': 1, 'aset:b': 1, c: 1 });
    history.undo();
    expect(source()).toStrictEqual({ ...init, a: 1, 'bset:c': 1 });
  });

  it('a peer delete then my re-add inside the window starts a new entry', () => {
    const { source, history, mine, peer, clock } = tracked<Root>({ a: 0 }, co);
    mine({ a: 1 });
    clock.at += 10;
    peer({});
    clock.at += 10;
    mine({ a: 5 });
    history.undo();
    expect(Object.hasOwn(source(), 'a')).toBe(false);
  });

  it('a multi-path change with one discontinuous path starts a new entry', () => {
    const { source, history, mine, peer, clock } = tracked<Root>(
      { a: 0, b: 0 },
      co,
    );
    mine({ a: 1, b: 1 });
    clock.at += 10;
    peer({ a: 1, b: 7 });
    clock.at += 10;
    mine({ a: 2, b: 2 });
    history.undo();
    expect(source()['a']).toBe(1);
  });

  it('after a run nets to zero, the next edit does not merge into the older entry', () => {
    const { source, history, mine, clock } = tracked<Root>({ x: 0 }, co);
    mine({ x: 1 });
    clock.at += 5000;
    mine({ x: 2 });
    clock.at += 10;
    mine({ x: 1 });
    clock.at += 10;
    mine({ x: 3 });
    history.undo();
    expect(source()).toStrictEqual({ x: 1 });
    history.undo();
    expect(source()).toStrictEqual({ x: 0 });
  });

  it('an undo closes the run: an edit right after it never merges into the entry below', () => {
    const { source, history, mine, clock } = tracked<Root>({ x: 0 }, co);
    mine({ x: 1 });
    clock.at += 5000;
    mine({ x: 2 });
    clock.at += 10;
    history.undo();
    clock.at += 10;
    mine({ x: 5 });
    history.undo();
    expect(source()).toStrictEqual({ x: 1 });
  });
});

describe('storeHistory: undo() and redo() report whether anything was written', () => {
  it('returns false on an empty stack', () => {
    const { history } = tracked<Root>({ x: 0 });
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(false);
  });

  it('returns true for a normal undo and redo', () => {
    const { source, history, mine } = tracked<Root>({ x: 0 });
    mine({ x: 1 });
    expect(history.undo()).toBe(true);
    expect(source()).toStrictEqual({ x: 0 });
    expect(history.redo()).toBe(true);
    expect(source()).toStrictEqual({ x: 1 });
  });

  it('returns false and pushes no redo entry when every op is skipped', () => {
    const { source, history, mine, peer } = tracked<Root>({ u: { name: 'a' } });
    mine({ u: { name: 'b' } });
    peer({});
    const before = source();
    expect(history.undo()).toBe(false);
    expect(source()).toBe(before);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });

  it('returns false when undoing my add after a peer edited the key', () => {
    const { source, history, mine, peer } = tracked<Root>({});
    mine({ a: 1 });
    peer({ a: 2 });
    expect(history.undo()).toBe(false);
    expect(source()).toStrictEqual({ a: 2 });
    expect(history.canRedo()).toBe(false);
  });

  it('returns true when only part of the entry is skipped', () => {
    const { source, history, mine, peer } = tracked<Root>({
      u: { name: 'a', age: 1 },
    });
    mine({ u: { name: 'z' } });
    peer({ u: {} });
    expect(history.undo()).toBe(true);
    expect(source()).toStrictEqual({ u: { age: 1 } });
    expect(history.canRedo()).toBe(true);
  });

  it('a redo whose every op is skipped returns false', () => {
    const { history, mine, peer } = tracked<Root>({ u: { name: 'a' } });
    mine({ u: { name: 'b' } });
    expect(history.undo()).toBe(true);
    peer({});
    expect(history.redo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.canUndo()).toBe(false);
  });
});
