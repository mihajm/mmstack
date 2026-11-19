import { TestBed } from '@angular/core/testing';
import { applyOps } from './op-log';
import {
  compareSiblings,
  createConvergingApply,
  isConflicted,
  mergeThree,
  OP_PROTO_VERSION,
  opSync,
  policyStrategy,
  preserve,
  replace,
  type Conflicted,
  type Dot,
  type FoldPolicyEntry,
  type MergePolicyEntry,
  type OpEnvelope,
  type SyncOp,
  type SyncSibling,
} from './op-sync';
import { store } from './store';
import { storeHistory } from './store-history';

type P = (string | number)[];
const env = (ops: SyncOp[], origin: string, p: number): OpEnvelope => ({
  proto: OP_PROTO_VERSION,
  instance: 'g',
  origin,
  writer: 'w-' + origin,
  version: 1,
  hlc: { p, l: 0 },
  policyVersion: 0,
  ops,
});
const d = (origin: string, p: number): Dot => ({ origin, hlc: { p, l: 0 } });
const set = (
  path: P,
  next: unknown,
  cites: Dot[] = [],
  epoch = 0,
  prev?: unknown,
): SyncOp =>
  (prev === undefined
    ? { kind: 'set', path, next, cites, epoch }
    : { kind: 'set', path, next, prev, cites, epoch }) as SyncOp;
const clear = (path: P, cites: Dot[]): SyncOp => ({
  kind: 'clear',
  path,
  cites,
  epoch: 0,
});
const del = (path: P, cites: Dot[]): SyncOp => ({
  kind: 'delete',
  path,
  prev: undefined,
  cites,
  epoch: 0,
});

// every delivery order of the envelopes gives the same root, equal to the register materialization
function converge(policies: MergePolicyEntry[], envs: OpEnvelope[]): unknown {
  const orders = [envs, [...envs].reverse(), [...envs.slice(1), envs[0]]];
  const roots = orders.map((order) => {
    const conv = createConvergingApply({ policies });
    let root: unknown = {};
    for (const e of order) root = applyOps(root, conv.ingest(e));
    expect(root).toStrictEqual(conv.materialize());
    return root;
  });
  for (const r of roots) expect(r).toStrictEqual(roots[0]);
  return roots[0];
}

describe('preserve and merge folds — delete, clear and epoch siblings', () => {
  const POLICY_KINDS: Array<[string, (path: string) => MergePolicyEntry[]]> = [
    ['preserve', (path) => [{ path, merge: preserve }]],
    ['mergeThree', (path) => [{ path, merge: mergeThree }]],
  ];

  it.each(POLICY_KINDS)(
    '%s: a parent replace that observed the child clears it; the new parent shows',
    (_n, pol) => {
      const root = converge(pol('doc.title'), [
        env([set(['doc'], { title: 't0', body: 'b' })], 'o1', 1),
        env([set(['doc', 'title'], 't1')], 'o2', 2),
        env(
          [
            set(['doc'], { title: 'new' }, [d('o1', 1)]),
            clear(['doc', 'title'], [d('o2', 2)]),
          ],
          'o3',
          3,
        ),
      ]);
      expect(root).toStrictEqual({ doc: { title: 'new' } });
    },
  );

  it.each(POLICY_KINDS)(
    '%s: a delete at the path removes the key on every peer',
    (_n, pol) => {
      const root = converge(pol('r.k'), [
        env([set(['r'], { k: 1, j: 2 })], 'o1', 1),
        env([set(['r', 'k'], 5)], 'o2', 2),
        env([del(['r', 'k'], [d('o2', 2)])], 'o3', 3),
      ]);
      expect(root).toStrictEqual({ r: { j: 2 } });
    },
  );

  it('preserve: an edit concurrent with a parent replace survives as a plain value, not a conflict', () => {
    const root = converge(
      [{ path: 'doc.title', merge: preserve }],
      [
        env([set(['doc'], { title: 't0' })], 'o1', 1),
        env([set(['doc', 'title'], 'e0')], 'o4', 2),
        env([set(['doc', 'title'], 'edit', [d('o4', 2)])], 'o2', 3),
        env(
          [
            set(['doc'], { title: 'A' }, [d('o1', 1)]),
            clear(['doc', 'title'], [d('o4', 2)]),
          ],
          'o3',
          4,
        ),
      ],
    ) as { doc: { title: unknown } };
    expect(root).toStrictEqual({ doc: { title: 'edit' } });
  });

  it('preserve: a lower-epoch sibling never surfaces next to an override', () => {
    const root = converge(
      [{ path: 'v', merge: preserve }],
      [
        env([set(['v'], 'bumped', [], 1)], 'o2', 3),
        env([set(['v'], 'stale', [], 0)], 'o1', 5),
      ],
    ) as { v: unknown };
    expect(isConflicted(root.v)).toBe(false);
    expect(root.v).toBe('bumped');
  });

  it('mergeThree: an override on one field is not merged with a stale edit of another', () => {
    const base = { a: 1, b: 1 };
    const root = converge(
      [{ path: 'rec', merge: mergeThree }],
      [
        env([set(['rec'], base)], 'o1', 1),
        env([set(['rec'], { a: 2, b: 1 }, [d('o1', 1)], 1, base)], 'o2', 3),
        env([set(['rec'], { a: 1, b: 9 }, [d('o1', 1)], 0, base)], 'o3', 2),
      ],
    );
    expect(root).toStrictEqual({ rec: { a: 2, b: 1 } });
  });

  it('a policy deeper than a register never applies to that register (one segment per segment)', () => {
    const root = converge(
      [{ path: 'doc.title', merge: preserve }],
      [
        env([set(['doc'], { title: 'x' })], 'o1', 1),
        env([set(['doc'], { title: 'y' })], 'o2', 2),
      ],
    ) as { doc: unknown };
    expect(isConflicted(root.doc)).toBe(false);
    expect(root.doc).toStrictEqual({ title: 'y' });
  });
});

describe('two-sided policies (policyStrategy)', () => {
  it('preserve keeps both values as siblings, winner (the fork) first', () => {
    const merged = policyStrategy<{ v: string }>([
      { path: 'v', merge: preserve },
    ])({ v: 'anc' }, { v: 'mine' }, { v: 'theirs' });
    const c = merged.v as unknown as Conflicted<string>;
    expect(isConflicted(c)).toBe(true);
    expect(c.siblings).toEqual(['mine', 'theirs']);
    expect([c.mine, c.theirs, c.ancestor]).toEqual(['mine', 'theirs', 'anc']);
  });

  it('replace keeps the fork value whole when both sides changed the path', () => {
    const merged = policyStrategy<{ v: string; w: string }>([
      { path: 'v', merge: replace },
    ])({ v: 'anc', w: 'w0' }, { v: 'mine', w: 'w0' }, { v: 'theirs', w: 'w1' });
    expect(merged).toStrictEqual({ v: 'mine', w: 'w1' });
  });
});

describe('compareSiblings is a strict order down to the origin', () => {
  const sib = (origin: string): SyncSibling => ({
    kind: 'set',
    value: origin,
    writer: 'same',
    origin,
    hlc: { p: 1, l: 0 },
    epoch: 0,
  });
  it('siblings that differ only in origin compare nonzero, antisymmetric, larger origin on top', () => {
    const a = sib('a');
    const b = sib('b');
    expect(Math.sign(compareSiblings(a, b))).toBe(-1);
    expect(Math.sign(compareSiblings(b, a))).toBe(1);
    expect(compareSiblings(a, a)).toBe(0);
  });
});

describe('undo dispatch through storeHistory with sync folds and policies', () => {
  function rig(
    opt: { policies?: MergePolicyEntry[]; folds?: FoldPolicyEntry[] },
    init: { v: unknown },
  ) {
    return TestBed.runInInjectionContext(() => {
      const a = store<{ v: unknown }>(init);
      const b = store<{ v: unknown }>(init);
      const syncA = opSync(a, { writer: 'wa', origin: 'a', ...opt });
      const syncB = opSync(b, { writer: 'wb', origin: 'b', ...opt });
      const history = storeHistory(a, { origin: 'a', track: syncA, ...opt });
      syncA.subscribe((e) => syncB.receive(e));
      syncB.subscribe((e) => syncA.receive(e));
      return { a, b, syncA, syncB, history };
    });
  }

  it('an undo at a custom-fold array path restores my value whole; with no fold it merges by slot', () => {
    const lawful: FoldPolicyEntry = {
      path: 'v',
      fold: (siblings) => {
        const top = siblings.reduce((x, y) =>
          compareSiblings(x, y) >= 0 ? x : y,
        );
        return top.kind === 'set'
          ? { kind: 'set', value: top.value }
          : { kind: top.kind };
      },
    };
    const run = (folds?: FoldPolicyEntry[]) => {
      const x = rig({ folds }, { v: [0, 0] });
      x.a.v.set([1, 0]);
      TestBed.tick();
      x.b.v.set([1, 5]);
      TestBed.tick();
      x.history.undo();
      TestBed.tick();
      const out = { a: x.a().v, b: x.b().v };
      x.syncA.destroy();
      x.syncB.destroy();
      return out;
    };
    expect(run([lawful])).toEqual({ a: [0, 0], b: [0, 0] });
    expect(run()).toEqual({ a: [0, 5], b: [0, 5] });
  });

  it('an undo at a preserve path writes a plain value, never a conflict', () => {
    const x = rig({ policies: [{ path: 'v', merge: preserve }] }, { v: 'p' });
    x.a.v.set('n');
    TestBed.tick();
    x.b.v.set('c');
    TestBed.tick();
    x.history.undo();
    TestBed.tick();
    expect(isConflicted(x.a().v)).toBe(false);
    expect(isConflicted(x.b().v)).toBe(false);
    expect(x.a().v).toBe('p');
    expect(x.b().v).toBe('p');
    x.syncA.destroy();
    x.syncB.destroy();
  });
});
