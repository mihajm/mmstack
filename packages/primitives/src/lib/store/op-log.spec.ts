import { computed, signal, untracked } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { forkStore } from './fork-store';
import { invertBatch, opLog, type OpBatch, type StoreOp } from './op-log';
import { mutableStore, store } from './store';

type Model = {
  user: { name: string; age: number };
  todos: { title: string; done: boolean }[];
  meta: { tags: string[] };
};

const initial = (): Model => ({
  user: { name: 'ann', age: 30 },
  todos: [
    { title: 'a', done: false },
    { title: 'b', done: true },
  ],
  meta: { tags: ['x'] },
});

function setup() {
  return TestBed.runInInjectionContext(() => {
    const s = store<Model>(initial());
    const batches: OpBatch[] = [];
    const log = opLog(s, { origin: 'test' });
    log.subscribe((b) => batches.push(b));
    return { s, log, batches };
  });
}

describe('opLog', () => {
  describe('emission', () => {
    it('emits one minimal op for a deep leaf write, with prev and next', () => {
      const { s, batches } = setup();

      s.user.name.set('bob');
      TestBed.tick();

      expect(batches.length).toBe(1);
      expect(batches[0]).toMatchObject({ origin: 'test', version: 1 });
      expect(batches[0].ops).toEqual([
        { kind: 'set', path: ['user', 'name'], prev: 'ann', next: 'bob' },
      ]);
    });

    it('structural sharing keeps untouched subtrees out of the diff entirely', () => {
      const { s, batches } = setup();
      const todosBefore = untracked(s.todos);

      s.user.age.set(31);
      TestBed.tick();

      expect(untracked(s.todos)).toBe(todosBefore); // CoW shared the sibling…
      expect(batches[0].ops).toEqual([
        { kind: 'set', path: ['user', 'age'], prev: 30, next: 31 },
      ]); // …so the walk never produced ops outside the written path
    });

    it('coalesces a tick into one batch; same-leaf writes compose prev→next', () => {
      const { s, batches } = setup();

      s.user.name.set('mid');
      s.user.name.set('final'); // same leaf, same tick
      s.user.age.set(40); // second leaf, same tick
      TestBed.tick();

      expect(batches.length).toBe(1);
      expect(batches[0].ops).toEqual([
        { kind: 'set', path: ['user', 'name'], prev: 'ann', next: 'final' },
        { kind: 'set', path: ['user', 'age'], prev: 30, next: 40 },
      ]);
    });

    it('delivery is lossless and versioned across ticks', () => {
      const { s, log, batches } = setup();

      s.user.age.set(31);
      TestBed.tick();
      s.user.age.set(32);
      TestBed.tick();

      expect(batches.map((b) => b.version)).toEqual([1, 2]);
      expect(log.latest()?.version).toBe(2); // latest samples the newest only
    });

    it('distinguishes an added key (no prev property) from an undefined-valued write', () => {
      const s = TestBed.runInInjectionContext(() =>
        store<{ a?: number; b?: number }>({ a: undefined }),
      );
      const batches: OpBatch[] = [];
      TestBed.runInInjectionContext(() => opLog(s).subscribe((b) => batches.push(b)));

      s.set({ a: undefined, b: 2 }); // b ADDED
      TestBed.tick();
      expect(batches[0].ops).toEqual([{ kind: 'set', path: ['b'], next: 2 }]);
      expect(Object.hasOwn(batches[0].ops[0], 'prev')).toBe(false);

      s.set({ a: 1, b: 2 }); // a was PRESENT (as undefined) — prev carried
      TestBed.tick();
      expect(batches[1].ops).toEqual([
        { kind: 'set', path: ['a'], prev: undefined, next: 1 },
      ]);
      expect(Object.hasOwn(batches[1].ops[0], 'prev')).toBe(true);
    });

    it('emits delete (with prev) for a removed key — absent is not undefined', () => {
      const s = TestBed.runInInjectionContext(() =>
        store<{ a: number; b?: number }>({ a: 1, b: 2 }),
      );
      const batches: OpBatch[] = [];
      TestBed.runInInjectionContext(() => opLog(s).subscribe((b) => batches.push(b)));

      s.set({ a: 1 });
      TestBed.tick();

      expect(batches[0].ops).toEqual([{ kind: 'delete', path: ['b'], prev: 2 }]);
    });

    it('arrays: same-length edits descend per index; a length change is one whole unit', () => {
      const { s, batches } = setup();

      s.todos[1].done.set(false); // same length → fine-grained
      TestBed.tick();
      expect(batches[0].ops).toEqual([
        { kind: 'set', path: ['todos', 1, 'done'], prev: true, next: false },
      ]);

      const prevTodos = untracked(s.todos);
      s.todos.set([...prevTodos, { title: 'c', done: false }]); // push → whole unit
      TestBed.tick();
      expect(batches[1].ops.length).toBe(1);
      expect(batches[1].ops[0]).toMatchObject({ kind: 'set', path: ['todos'] });
      expect((batches[1].ops[0] as { next: unknown[] }).next.length).toBe(3);
    });

    it('a type change at a node is one unit', () => {
      const s = TestBed.runInInjectionContext(() =>
        store<{ v: { deep: number } | number }>({ v: { deep: 1 } }),
      );
      const batches: OpBatch[] = [];
      TestBed.runInInjectionContext(() => opLog(s).subscribe((b) => batches.push(b)));

      s.v.set(5);
      TestBed.tick();
      expect(batches[0].ops).toEqual([
        { kind: 'set', path: ['v'], prev: { deep: 1 }, next: 5 },
      ]);
    });

    it('unsubscribe stops delivery; destroy stops observation', () => {
      const { s, log, batches } = setup();
      const extra: OpBatch[] = [];
      const unsub = log.subscribe((b) => extra.push(b));

      s.user.age.set(31);
      TestBed.tick();
      expect(extra.length).toBe(1);

      unsub();
      s.user.age.set(32);
      TestBed.tick();
      expect(extra.length).toBe(1);
      expect(batches.length).toBe(2); // the other subscriber still receives

      log.destroy();
      s.user.age.set(33);
      TestBed.tick();
      expect(batches.length).toBe(2);
    });

    it('warns on a mutable store and stays silent for in-place mutations', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { batches, s } = TestBed.runInInjectionContext(() => {
        const s = mutableStore<Model>(initial());
        const batches: OpBatch[] = [];
        opLog(s).subscribe((b) => batches.push(b));
        return { batches, s };
      });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('MUTABLE'));
      s.user.name.set('bob'); // routes through mutate → same root reference
      TestBed.tick();
      expect(batches).toEqual([]); // invisible to ref-diffing, as documented
      warn.mockRestore();
    });
  });

  describe('apply', () => {
    it('applies a batch atomically — one notification wave, values correct', () => {
      const { s, log } = setup();
      let recomputes = 0;
      const watcher = computed(() => {
        recomputes++;
        return `${s().user.name}:${s().user.age}`;
      });
      expect(watcher()).toBe('ann:30');

      log.apply([
        { kind: 'set', path: ['user', 'name'], prev: 'ann', next: 'zoe' },
        { kind: 'set', path: ['user', 'age'], prev: 30, next: 99 },
      ] satisfies StoreOp[]);

      expect(watcher()).toBe('zoe:99');
      expect(recomputes).toBe(2); // initial + exactly one wave for the whole batch
    });

    it('applied batches produce NO echo emission', () => {
      const { log, batches } = setup();

      log.apply([{ kind: 'set', path: ['user', 'age'], prev: 30, next: 99 }]);
      TestBed.tick();

      expect(batches).toEqual([]); // baseline advanced with the write — sync loops terminate
    });

    it('flushes pending local writes BEFORE applying, so they are not swallowed', () => {
      const { s, log, batches } = setup();

      s.user.name.set('local'); // same tick, not yet emitted…
      log.apply([{ kind: 'set', path: ['user', 'age'], prev: 30, next: 99 }]);
      TestBed.tick();

      // the local write emitted as its own batch; the applied ops never echoed
      expect(batches.length).toBe(1);
      expect(batches[0].ops).toEqual([
        { kind: 'set', path: ['user', 'name'], prev: 'ann', next: 'local' },
      ]);
      expect(untracked(s.user.age)).toBe(99); // both landed in the value
      expect(untracked(s.user.name)).toBe('local');
    });

    it('applies delete ops (key becomes absent, not undefined)', () => {
      const s = TestBed.runInInjectionContext(() =>
        store<{ a: number; b?: number }>({ a: 1, b: 2 }),
      );
      const log = TestBed.runInInjectionContext(() => opLog(s));

      log.apply([{ kind: 'delete', path: ['b'], prev: 2 }]);
      expect('b' in untracked(s)).toBe(false);
    });

    it('vivifies missing containers along an op path (object for keys, array for indices)', () => {
      const s = TestBed.runInInjectionContext(() =>
        store<Record<string, unknown>>({}),
      );
      const log = TestBed.runInInjectionContext(() => opLog(s));

      log.apply([
        { kind: 'set', path: ['deep', 'list', 0, 'title'], next: 'made it' },
      ]);
      expect(untracked(s)).toEqual({
        deep: { list: [{ title: 'made it' }] },
      });
    });

    it('works on a plain WritableSignal holding immutably-updated objects', () => {
      const src = TestBed.runInInjectionContext(() =>
        signal<{ n: number }>({ n: 1 }),
      );
      const batches: OpBatch[] = [];
      const log = TestBed.runInInjectionContext(() => {
        const log = opLog(src);
        log.subscribe((b) => batches.push(b));
        return log;
      });

      src.set({ n: 2 });
      TestBed.tick();
      expect(batches[0].ops).toEqual([
        { kind: 'set', path: ['n'], prev: 1, next: 2 },
      ]);

      log.apply([{ kind: 'set', path: ['n'], prev: 2, next: 3 }]);
      expect(untracked(src)).toEqual({ n: 3 });
    });
  });

  describe('invertBatch (undo)', () => {
    it('apply → apply(inverted) round-trips to the original value', () => {
      const { s, batches } = setup();

      s.user.name.set('bob');
      s.todos[0].done.set(true);
      TestBed.tick();

      const before = { user: initial().user, done: false };
      void before;
      const log2 = TestBed.runInInjectionContext(() => opLog(s));
      log2.apply(invertBatch(batches[0]));

      expect(untracked(s.user.name)).toBe('ann');
      expect(untracked(s.todos[0].done)).toBe(false);
    });

    it('inverts an added key into a delete (absence restored, not undefined)', () => {
      const s = TestBed.runInInjectionContext(() =>
        store<Record<string, number>>({ a: 1 }),
      );
      const batches: OpBatch[] = [];
      const log = TestBed.runInInjectionContext(() => {
        const log = opLog(s);
        log.subscribe((b) => batches.push(b));
        return log;
      });

      s.set({ a: 1, b: 2 });
      TestBed.tick();
      log.apply(invertBatch(batches[0]));

      expect('b' in untracked(s)).toBe(false);
    });

    it('inverts a delete into a restoring set', () => {
      const s = TestBed.runInInjectionContext(() =>
        store<Record<string, number>>({ a: 1, b: 2 }),
      );
      const batches: OpBatch[] = [];
      const log = TestBed.runInInjectionContext(() => {
        const log = opLog(s);
        log.subscribe((b) => batches.push(b));
        return log;
      });

      s.set({ a: 1 });
      TestBed.tick();
      log.apply(invertBatch(batches[0]));

      expect(untracked(s)).toEqual({ a: 1, b: 2 });
    });
  });

  describe('composition', () => {
    it('fork.commit() is the transaction primitive: N staged writes → ONE batch', () => {
      const { s, batches } = setup();
      TestBed.tick(); // settle any initial state

      const fork = TestBed.runInInjectionContext(() => forkStore(s));
      fork.store.user.name.set('staged');
      fork.store.user.age.set(50);
      TestBed.tick();
      expect(batches).toEqual([]); // staged writes are invisible to the base's log

      fork.commit();
      TestBed.tick();

      expect(batches.length).toBe(1); // one set → one batch, atomically
      expect(batches[0].ops).toEqual([
        { kind: 'set', path: ['user', 'name'], prev: 'ann', next: 'staged' },
        { kind: 'set', path: ['user', 'age'], prev: 30, next: 50 },
      ]);
    });

    it('two logs on one store sync through apply without loops (mini mesh)', () => {
      // simulate two "peers" as two stores of the same shape, piped via batches
      const { s: a, batches: fromA } = setup();
      const b = TestBed.runInInjectionContext(() => store<Model>(initial()));
      const logB = TestBed.runInInjectionContext(() => opLog(b, { origin: 'peer-b' }));
      const fromB: OpBatch[] = [];
      logB.subscribe((batch) => fromB.push(batch));

      a.user.name.set('from-a');
      TestBed.tick();
      logB.apply(fromA[0]); // ship a → b
      TestBed.tick();

      expect(untracked(b.user.name)).toBe('from-a');
      expect(fromB).toEqual([]); // b never echoed — the loop terminates

      b.todos[0].title.set('from-b');
      TestBed.tick();
      expect(fromB.length).toBe(1); // b's own writes still emit
    });
  });
});
