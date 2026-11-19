import { describe, expect, it } from 'vitest';
import { validateEnvelope } from './validate';
import {
  MESH_PROTO_VERSION,
  type Dot,
  type OpEnvelope,
  type SyncOp,
} from './wire';

// The own-cite rule against the relay's validator twin: an envelope from origin O stamped h that
// cites (O, h') with h' > h is rejected whole with 'cites'. The exact self-cite stays accepted.

type Hlc = { readonly p: number; readonly l: number };
const STAMP: Hlc = { p: 5, l: 2 };
const opAt = (path: string, cites: readonly Dot[] = []): SyncOp =>
  ({ kind: 'set', path: [path], next: path, cites, epoch: 0 }) as SyncOp;
const envWith = (cites: readonly Dot[], at: 0 | 1 | 2): OpEnvelope =>
  ({
    proto: MESH_PROTO_VERSION,
    instance: 'g',
    origin: 'O',
    writer: 'w',
    version: 1,
    hlc: STAMP,
    policyVersion: 0,
    ops: (['a', 'b', 'c'] as const).map((p, i) =>
      opAt(p, i === at ? cites : []),
    ),
  }) as OpEnvelope;
const own = (p: number, l: number): Dot => ({ origin: 'O', hlc: { p, l } });
const other = (p: number, l: number): Dot => ({ origin: 'X', hlc: { p, l } });

const ROWS: ReadonlyArray<{
  name: string;
  cites: readonly Dot[];
  want: string | null;
}> = [
  { name: 'own cite above, higher p', cites: [own(6, 0)], want: 'cites' },
  {
    name: 'own cite above, same p, higher l',
    cites: [own(5, 3)],
    want: 'cites',
  },
  {
    name: 'own cite above, far ahead',
    cites: [own(Number.MAX_SAFE_INTEGER, 0)],
    want: 'cites',
  },
  {
    name: 'own cite above among honest cites',
    cites: [other(9, 9), own(4, 0), own(6, 0), other(1, 0)],
    want: 'cites',
  },
  {
    name: 'own cite above after an equal self-cite',
    cites: [own(5, 2), own(5, 3)],
    want: 'cites',
  },
  { name: 'equal own cite', cites: [own(5, 2)], want: null },
  { name: 'own cite below, same p', cites: [own(5, 1)], want: null },
  {
    name: 'own cite below, lower p, higher l',
    cites: [own(4, 99)],
    want: null,
  },
  {
    name: 'another origin above the stamp',
    cites: [other(6, 0), other(5, 3)],
    want: null,
  },
  {
    name: 'honest mix: equal, below, foreign above',
    cites: [own(5, 2), own(1, 0), other(99, 0)],
    want: null,
  },
];

describe('validateEnvelope (relay twin): an own cite above the stamp is rejected whole', () => {
  for (const row of ROWS)
    for (const at of [0, 1, 2] as const)
      it(`${row.name}, op ${['first', 'middle', 'last'][at]} -> ${String(row.want)}`, () => {
        expect(validateEnvelope(envWith(row.cites, at))).toBe(row.want);
      });
});

const BAD_CITE = { origin: 'X', hlc: { p: Number.NaN, l: 0 } } as Dot;
const withOps = (
  edit: (ops: Record<string, unknown>[]) => void,
  cites: readonly Dot[] = [own(6, 0)],
): OpEnvelope => {
  const env = envWith(cites, 1);
  const ops = env.ops.map((o) => ({ ...o })) as Record<string, unknown>[];
  edit(ops);
  return { ...env, ops: ops as unknown as SyncOp[] } as OpEnvelope;
};
const MIXED: ReadonlyArray<{ name: string; env: OpEnvelope; want: string }> = [
  {
    name: 'a malformed cite earlier in the same op',
    env: withOps(() => undefined, [BAD_CITE, own(6, 0)]),
    want: 'cites',
  },
  {
    name: 'a malformed cite later in the same op',
    env: withOps(() => undefined, [own(6, 0), BAD_CITE]),
    want: 'cites',
  },
  {
    name: 'the same op repeats an earlier path',
    env: withOps((ops) => void (ops[1]['path'] = ['a'])),
    want: 'cites',
  },
  {
    name: 'a later op repeats the same path',
    env: withOps((ops) => void (ops[2]['path'] = ['b'])),
    want: 'cites',
  },
  {
    name: 'a later op with an unknown kind',
    env: withOps((ops) => void (ops[2]['kind'] = 'bogus')),
    want: 'cites',
  },
  {
    name: 'a later op with a negative epoch',
    env: withOps((ops) => void (ops[2]['epoch'] = -1)),
    want: 'cites',
  },
  {
    name: 'an earlier op with an unknown kind',
    env: withOps((ops) => void (ops[0]['kind'] = 'bogus')),
    want: 'kind',
  },
];

describe('validateEnvelope (relay twin): an own cite above together with another fault', () => {
  for (const row of MIXED)
    it(`own cite above in the middle op and ${row.name} -> ${row.want}`, () => {
      expect(validateEnvelope(row.env)).toBe(row.want);
    });
});
