import { signal } from '@angular/core';
import { diffOps, type OpBatch, type OpLogDriver } from './op-log';
import { storeHistory } from './store-history';

// Oracle for selective undo after a peer write, written from the rules alone:
// - undoing my edit applies only while its path is still there (leaf and every ancestor);
// - undoing my delete restores only while every ancestor still holds a plain record or array;
// - undoing my add removes the key only while it still holds what I added.
// Values here are primitives and plain records, so a found-but-changed leaf merges to my
// before-value (a leaf conflict keeps mine), the same as applying my inverse as is.

type Path = readonly string[];
type Root = Record<string, unknown>;
type MyOp =
  | { kind: 'edit'; path: Path; before: unknown; after: unknown }
  | { kind: 'delete'; path: Path; before: unknown }
  | { kind: 'add'; path: Path; value: unknown };

const isPlainContainer = (v: unknown): boolean =>
  Array.isArray(v) ||
  (v !== null &&
    typeof v === 'object' &&
    (Object.getPrototypeOf(v) === Object.prototype ||
      Object.getPrototypeOf(v) === null));

function at(root: unknown, path: Path): { has: boolean; value?: unknown } {
  let cur = root;
  for (const seg of path) {
    if (!isPlainContainer(cur) || !Object.hasOwn(cur as object, seg))
      return { has: false };
    cur = (cur as Root)[seg];
  }
  return { has: true, value: cur };
}

const ancestorsAreContainers = (root: unknown, path: Path): boolean => {
  for (let i = 0; i < path.length; i++) {
    const anc = at(root, path.slice(0, i));
    if (!anc.has || !isPlainContainer(anc.value)) return false;
  }
  return true;
};

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b) && typeof a === typeof b;

function write(
  root: unknown,
  path: Path,
  value: unknown,
  remove = false,
): Root {
  const [head, ...rest] = path;
  const copy: Root = { ...(root as Root) };
  if (rest.length === 0) {
    if (remove) delete copy[head];
    else copy[head] = value;
  } else copy[head] = write(copy[head], rest, value, remove);
  return copy;
}

function modelUndo(
  current: Root,
  mine: readonly MyOp[],
): { root: Root; applied: number } {
  let root = current;
  let applied = 0;
  for (const op of [...mine].reverse()) {
    if (op.kind === 'edit') {
      if (!at(root, op.path).has) continue;
      root = write(root, op.path, op.before);
    } else if (op.kind === 'delete') {
      if (!ancestorsAreContainers(root, op.path)) continue;
      root = write(root, op.path, op.before);
    } else {
      const here = at(root, op.path);
      if (!here.has || !same(here.value, op.value)) continue;
      root = write(root, op.path, undefined, true);
    }
    applied++;
  }
  return { root, applied };
}

const INITIAL: Root = { u: { name: 'a', age: 1 }, k: 1 };

const MINE: Record<string, readonly MyOp[]> = {
  'edit u.name': [
    { kind: 'edit', path: ['u', 'name'], before: 'a', after: 'b' },
  ],
  'delete u.name': [{ kind: 'delete', path: ['u', 'name'], before: 'a' }],
  'add u.extra': [{ kind: 'add', path: ['u', 'extra'], value: 'x' }],
  'edit k': [{ kind: 'edit', path: ['k'], before: 1, after: 2 }],
  'delete k': [{ kind: 'delete', path: ['k'], before: 1 }],
  'delete u': [{ kind: 'delete', path: ['u'], before: { name: 'a', age: 1 } }],
  'replace u': [
    { kind: 'edit', path: ['u', 'name'], before: 'a', after: 'z' },
    { kind: 'delete', path: ['u', 'age'], before: 1 },
  ],
};

function applyMine(root: Root, ops: readonly MyOp[]): Root {
  let next = root;
  for (const op of ops)
    next =
      op.kind === 'edit'
        ? write(next, op.path, op.after)
        : op.kind === 'add'
          ? write(next, op.path, op.value)
          : write(next, op.path, undefined, true);
  return next;
}

const PEER: Record<string, (r: Root) => Root> = {
  none: (r) => r,
  'set u.name p': (r) => (at(r, ['u']).has ? write(r, ['u', 'name'], 'p') : r),
  'set u.name b': (r) => (at(r, ['u']).has ? write(r, ['u', 'name'], 'b') : r),
  'delete u.name': (r) =>
    at(r, ['u', 'name']).has ? write(r, ['u', 'name'], undefined, true) : r,
  'set u.extra y': (r) =>
    at(r, ['u']).has ? write(r, ['u', 'extra'], 'y') : r,
  'delete u': (r) => write(r, ['u'], undefined, true),
  'u = null': (r) => write(r, ['u'], null),
  'u = 5': (r) => write(r, ['u'], 5),
  'u = {}': (r) => write(r, ['u'], {}),
  'u = Date': (r) => write(r, ['u'], new Date(0)),
  'set k 9': (r) => write(r, ['k'], 9),
  'delete k': (r) => write(r, ['k'], undefined, true),
};

const noDriver: OpLogDriver = () => ({ destroy: () => undefined });

function harness() {
  const source = signal<Root>(INITIAL);
  let emit: ((b: OpBatch) => void) | null = null;
  const history = storeHistory(source, {
    driver: noDriver,
    track: { subscribe: (cb) => ((emit = cb), () => (emit = null)) },
  });
  let version = 0;
  const local = (next: Root) => {
    const prev = source();
    source.set(next);
    emit?.({
      origin: 'me',
      version: ++version,
      ops: diffOps(prev, next, { arrays: 'unit' }),
    });
  };
  const peer = (next: Root) => source.set(next);
  return { source, history, local, peer };
}

describe('storeHistory proofs: undo after a peer write follows the skip rules', () => {
  const cases = Object.keys(MINE).flatMap((m) =>
    Object.keys(PEER).map((p) => [m, p] as const),
  );

  it.each(cases)('mine: %s, peer: %s', (m, p) => {
    const { source, history, local, peer } = harness();
    local(applyMine(INITIAL, MINE[m]));
    const current = PEER[p](source());
    peer(current);

    const expected = modelUndo(current, MINE[m]);
    history.undo();
    expect(source()).toStrictEqual(expected.root);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(expected.applied > 0);

    history.redo();
    expect(source()).toStrictEqual(
      expected.applied > 0 ? current : expected.root,
    );
  });

  it('THEOREM: an undo never vivifies a container the current root lacks', () => {
    for (const [m, p] of cases) {
      const { source, history, local, peer } = harness();
      local(applyMine(INITIAL, MINE[m]));
      const current = PEER[p](source());
      peer(current);
      history.undo();
      const after = source();
      for (const op of MINE[m]) {
        if (at(after, op.path).has && !at(current, op.path).has)
          expect(ancestorsAreContainers(current, op.path)).toBe(true);
      }
      const restoresU = MINE[m].some(
        (o) => o.path.length === 1 && o.path[0] === 'u',
      );
      if (!isPlainContainer(current['u']) && !restoresU)
        expect(after['u']).toBe(current['u']);
    }
  });

  it('PIN: an edit under a record a peer deleted is skipped, not resurrected as a partial record', () => {
    const { source, history, local, peer } = harness();
    local(write(INITIAL, ['u', 'name'], 'b'));
    peer(write(source(), ['u'], undefined, true));
    history.undo();
    expect(source()).toStrictEqual({ k: 1 });
    expect(history.canRedo()).toBe(false);
  });
});
