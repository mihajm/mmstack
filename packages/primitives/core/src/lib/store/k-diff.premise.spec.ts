import { applyOps, diffOps, type StoreOp } from './op-log';
import {
  createConvergingApply,
  keyedArray,
  OP_PROTO_VERSION,
  type MergePolicyEntry,
  type OpEnvelope,
} from './op-sync';

// PREMISE EVIDENCE for the K-diff arc (`~/Desktop/ab-docs/_mmstack-kdiff-charter.md` §0), probed
// against the REAL register. Each case runs two replicas that write concurrently against one seeded
// array, exchange envelopes, and converge; the assertion is about WHAT they converge on. The cases
// separate the hazards an emission change can fix from the ones only element identity on the wire
// can fix. These are descriptions of today's behaviour, not laws.

type Todo = { id: string; t: string };
const base: Todo[] = [
  { id: 'a', t: 'A' },
  { id: 'b', t: 'B' },
  { id: 'c', t: 'C' },
];
const [a, b, c] = base;

const baseEnv: OpEnvelope = {
  proto: OP_PROTO_VERSION,
  instance: 'g',
  origin: 'BASE',
  writer: 'BASE',
  version: 1,
  hlc: { p: 1, l: 0 },
  policyVersion: 0,
  ops: [{ kind: 'set', path: ['todos'], next: base, cites: [], epoch: 0 }],
};

function replica(origin: string, p: number, policies?: MergePolicyEntry[]) {
  const conv = createConvergingApply({ policies, origin });
  let root: unknown = {};
  const receive = (env: OpEnvelope): void => {
    root = applyOps(root, conv.ingest(env));
  };
  receive(baseEnv);
  return {
    /** Stamp + register local ops as one envelope, as `opSync.emitLocal` does. */
    emit(ops: StoreOp[]): OpEnvelope {
      const env: OpEnvelope = {
        proto: OP_PROTO_VERSION,
        instance: 'g',
        origin,
        writer: origin,
        version: 1,
        hlc: { p, l: 0 },
        policyVersion: 0,
        ops: conv.stamp(ops),
      };
      root = applyOps(root, ops);
      conv.ingest(env, { local: true });
      return env;
    },
    receive,
    folded: () => root as { todos: Todo[] },
    state: () => conv.materialize() as { todos: Todo[] },
  };
}

const textById = (todos: readonly Todo[]): Record<string, string> =>
  Object.fromEntries(todos.map((t) => [t.id, t.t]));
const ids = (todos: readonly Todo[]): string[] => todos.map((t) => t.id).sort();

const wholeArraySet = (next: Todo[]): StoreOp[] => [
  { kind: 'set', path: ['todos'], prev: base, next },
];

describe('K-diff premise: what array emission can and cannot fix', () => {
  it('[CONTROL] concurrent field edits at different slots both survive: per-index descent is right when every slot still holds its element', () => {
    const A = replica('A', 10);
    const B = replica('B', 20);
    const envA = A.emit(diffOps({ todos: base }, { todos: [{ ...a, t: 'A2' }, b, c] }));
    const envB = B.emit(diffOps({ todos: base }, { todos: [a, { ...b, t: 'B2' }, c] }));
    A.receive(envB);
    B.receive(envA);
    expect(A.state()).toEqual(B.state());
    expect(A.folded()).toEqual(A.state());
    expect(textById(A.state().todos)).toEqual({ a: 'A2', b: 'B2', c: 'C' });
  });

  it('[PREMISE-1] a field edit concurrent with a reorder lands on the SLOT, not the element, under per-slot emission AND under whole-array emission', () => {
    for (const emission of ['per-slot', 'whole-array'] as const) {
      const A = replica('A', 10);
      const B = replica('B', 20);
      const reordered = [b, a, c];
      const envA = A.emit(
        emission === 'per-slot'
          ? diffOps({ todos: base }, { todos: reordered })
          : wholeArraySet(reordered),
      );
      // B edits the element it sees at slot 0, which is `a`
      const envB = B.emit(diffOps({ todos: base }, { todos: [{ ...a, t: 'A2' }, b, c] }));
      A.receive(envB);
      B.receive(envA);
      expect(A.state(), emission).toEqual(B.state());
      expect(A.folded(), emission).toEqual(A.state());
      // converged, on the wrong element: the edit meant for `a` sits on `b`
      expect(textById(A.state().todos), emission).toEqual({ a: 'A', b: 'A2', c: 'C' });
    }
  });

  it('[PREMISE-2] two partial concurrent reorders: per-slot emission folds to a NON-permutation (one element duplicated, one lost); whole-array emission folds to one side', () => {
    const perSlot = (() => {
      const A = replica('A', 10);
      const B = replica('B', 20);
      const envA = A.emit(diffOps({ todos: base }, { todos: [b, a, c] })); // swaps slots 0,1
      const envB = B.emit(diffOps({ todos: base }, { todos: [a, c, b] })); // swaps slots 1,2
      A.receive(envB);
      B.receive(envA);
      expect(A.state()).toEqual(B.state());
      return A.state().todos;
    })();
    expect(ids(perSlot)).toEqual(['b', 'b', 'c']); // `b` twice, `a` gone

    for (const policies of [undefined, [{ path: 'todos', merge: keyedArray((t) => (t as Todo).id) }]]) {
      const A = replica('A', 10, policies);
      const B = replica('B', 20, policies);
      const envA = A.emit(wholeArraySet([b, a, c]));
      const envB = B.emit(wholeArraySet([a, c, b]));
      A.receive(envB);
      B.receive(envA);
      expect(A.state()).toEqual(B.state());
      expect(ids(A.state().todos)).toEqual(['a', 'b', 'c']);
      expect(A.state().todos).toEqual([a, c, b]); // the total-order winner's array, whole
    }
  });

  it('[PREMISE-3] an element replaced in place (same length, new identity) concurrent with a field edit at that slot: the edit lands on the replacement under both emissions', () => {
    for (const emission of ['per-slot', 'whole-array'] as const) {
      const A = replica('A', 10);
      const B = replica('B', 20);
      const replaced = [{ id: 'z', t: 'Z' }, b, c];
      const envA = A.emit(
        emission === 'per-slot'
          ? diffOps({ todos: base }, { todos: replaced })
          : wholeArraySet(replaced),
      );
      const envB = B.emit(diffOps({ todos: base }, { todos: [{ ...a, t: 'A2' }, b, c] }));
      A.receive(envB);
      B.receive(envA);
      expect(A.state(), emission).toEqual(B.state());
      expect(textById(A.state().todos), emission).toEqual({ z: 'A2', b: 'B', c: 'C' });
    }
  });

  it('[PREMISE-4] the same edit-vs-reorder race, arrays as UNITS under a keyedArray policy: the edit lands on the right element; order follows the total-order winner', () => {
    const policies = [{ path: 'todos', merge: keyedArray((t) => (t as Todo).id) }];
    for (const [pA, pB] of [[10, 20], [20, 10]]) {
      const A = replica('A', pA, policies);
      const B = replica('B', pB, policies);
      const envA = A.emit(wholeArraySet([b, a, c]));
      const envB = B.emit(wholeArraySet([{ ...a, t: 'A2' }, b, c]));
      A.receive(envB);
      B.receive(envA);
      expect(A.state(), `${pA}/${pB}`).toEqual(B.state());
      expect(A.folded(), `${pA}/${pB}`).toEqual(A.state());
      expect(textById(A.state().todos), `${pA}/${pB}`).toEqual({ a: 'A2', b: 'B', c: 'C' });
      expect(A.state().todos.map((t) => t.id), `${pA}/${pB}`).toEqual(
        pB > pA ? ['a', 'b', 'c'] : ['b', 'a', 'c'],
      );
    }
  });

  it('[PREMISE-5] replacement-vs-edit as UNITS under keyedArray: the edited element survives beside the replacement (edit beats removal), never under it', () => {
    const policies = [{ path: 'todos', merge: keyedArray((t) => (t as Todo).id) }];
    const A = replica('A', 10, policies);
    const B = replica('B', 20, policies);
    const envA = A.emit(wholeArraySet([{ id: 'z', t: 'Z' }, b, c]));
    const envB = B.emit(wholeArraySet([{ ...a, t: 'A2' }, b, c]));
    A.receive(envB);
    B.receive(envA);
    expect(A.state()).toEqual(B.state());
    expect(textById(A.state().todos)).toEqual({ a: 'A2', b: 'B', c: 'C', z: 'Z' });
  });
});
