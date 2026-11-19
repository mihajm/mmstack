import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createHlcClock } from './hlc';
import {
  OP_PROTO_VERSION,
  opSync,
  syncedFork,
  validateEnvelope,
  type OpEnvelope,
  type OpSync,
  type SyncOp,
} from './op-sync';
import { store } from './store';

// The own-cite rule against the real client: the validator rows, the hydrate counterexample and an
// honest-emission property. The predicate below is the model's (own-cite.model.spec.ts), copied, not
// the real validator.

type Hlc = { readonly p: number; readonly l: number };
type Dot = { readonly origin: string; readonly hlc: Hlc };
const cmp = (a: Hlc, b: Hlc): number =>
  a.p !== b.p ? (a.p < b.p ? -1 : 1) : a.l === b.l ? 0 : a.l < b.l ? -1 : 1;
const ownCiteAbove = (env: OpEnvelope): boolean =>
  env.ops.some((op) =>
    ((op as SyncOp).cites ?? []).some(
      (c) => c.origin === env.origin && cmp(c.hlc, env.hlc) > 0,
    ),
  );

const STAMP: Hlc = { p: 5, l: 2 };
const opAt = (path: string, cites: readonly Dot[] = []): SyncOp =>
  ({ kind: 'set', path: [path], next: path, cites, epoch: 0 }) as SyncOp;
const envWith = (cites: readonly Dot[], at: 0 | 1 | 2): OpEnvelope => ({
  proto: OP_PROTO_VERSION,
  instance: 'g',
  origin: 'O',
  writer: 'w',
  version: 1,
  hlc: STAMP,
  policyVersion: 0,
  ops: (['a', 'b', 'c'] as const).map((p, i) => opAt(p, i === at ? cites : [])),
});
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

describe('validateEnvelope: an own cite above the stamp is rejected whole', () => {
  for (const row of ROWS)
    for (const at of [0, 1, 2] as const)
      it(`${row.name}, op ${['first', 'middle', 'last'][at]} -> ${String(row.want)}`, () => {
        expect(validateEnvelope(envWith(row.cites, at))).toBe(row.want);
      });

  it('the verdict reads only the envelope: same verdict before and after the replica ingests other envelopes', () => {
    const env = envWith([own(6, 0)], 1);
    const before = validateEnvelope(env);
    const x = client(() => 1, 'R');
    x.sync.receive({
      ...envWith([], 0),
      origin: 'O',
      version: 1,
      hlc: { p: 9, l: 0 },
    });
    expect(validateEnvelope(env)).toBe(before);
    x.sync.destroy();
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
  return { ...env, ops: ops as unknown as SyncOp[] };
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

describe('validateEnvelope: an own cite above together with another fault', () => {
  for (const row of MIXED)
    it(`own cite above in the middle op and ${row.name} -> ${row.want}`, () => {
      expect(validateEnvelope(row.env)).toBe(row.want);
    });
});

function client(now: () => number, origin = 'me') {
  return TestBed.runInInjectionContext(() => {
    const s = signal<{ v: string }>({ v: 'init' });
    const sync = opSync(s, { writer: 'w', origin, clock: createHlcClock(now) });
    const out: OpEnvelope[] = [];
    sync.subscribe((env) => out.push(env));
    return { s, sync, out };
  });
}

const PENDING: OpEnvelope = {
  proto: OP_PROTO_VERSION,
  instance: '',
  origin: 'me',
  writer: 'w',
  version: 1,
  hlc: { p: 2000, l: 0 },
  policyVersion: 0,
  ops: [
    {
      kind: 'set',
      path: ['v'],
      next: 'pending',
      cites: [],
      epoch: 0,
    } as SyncOp,
  ],
};
const EMPTY = {
  proto: OP_PROTO_VERSION,
  root: { v: 'init' },
  registers: [],
  wm: {},
};

describe('hydrate(state, pending) observes every replayed pending stamp', () => {
  for (const wall of [1000, 2000])
    it(`fresh clock at wall ${wall}, pending me@2000.0: the next write at that path stamps above it`, () => {
      const x = client(() => wall);
      x.sync.hydrate(EMPTY, [PENDING]);
      expect(x.s().v).toBe('pending');
      x.s.set({ v: 'next' });
      x.sync.flush();
      const env = x.out.at(-1)!;
      expect((env.ops[0] as SyncOp).cites).toEqual([
        { origin: 'me', hlc: { p: 2000, l: 0 } },
      ]);
      expect(cmp(env.hlc, PENDING.hlc)).toBe(1);
      expect(ownCiteAbove(env)).toBe(false);
      x.sync.destroy();
    });
});

const pendingAt = (version: number, p: number, next: string): OpEnvelope => ({
  ...PENDING,
  version,
  hlc: { p, l: 0 },
  ops: [{ ...(PENDING.ops[0] as SyncOp), next } as SyncOp],
});
const TAIL = [pendingAt(1, 2000, 'p1'), pendingAt(2, 2001, 'p2')];
const nextWrite = (x: ReturnType<typeof client>, v: string): OpEnvelope => {
  x.s.set({ v });
  x.sync.flush();
  return x.out.at(-1)!;
};

describe('hydrate(state, pending) continues the version past the replayed pending envelopes', () => {
  it('the next local write on a fresh instance is versioned above every replayed pending version', () => {
    const x = client(() => 1000);
    x.sync.hydrate(EMPTY, TAIL);
    expect(x.s().v).toBe('p2');
    const env = nextWrite(x, 'next');
    expect(env.version).toBeGreaterThan(2);
    expect(x.sync.watermark()['me']).toBe(env.version);
    x.sync.destroy();
  });

  it('a receiver that already holds the pending envelopes accepts the new write', () => {
    const r = client(() => 1000, 'R');
    for (const e of TAIL) r.sync.receive(e);
    expect(r.s().v).toBe('p2');
    const x = client(() => 1000);
    x.sync.hydrate(EMPTY, TAIL);
    r.sync.receive(nextWrite(x, 'next'));
    expect(r.s().v).toBe('next');
    x.sync.destroy();
    r.sync.destroy();
  });

  it('a counter already higher from an earlier checkpoint watermark is kept, never lowered', () => {
    const x = client(() => 1000);
    x.sync.hydrate({ ...EMPTY, wm: { me: 7 } });
    x.sync.hydrate(EMPTY, TAIL);
    expect(x.s().v).toBe('p2');
    expect(nextWrite(x, 'next').version).toBeGreaterThan(7);
    x.sync.destroy();
  });

  it("a counter already higher from restore's high-water is kept, never lowered", () => {
    const x = client(() => 1000);
    x.sync.restore([TAIL[0]], 9);
    x.sync.hydrate(EMPTY, TAIL);
    expect(x.s().v).toBe('p2');
    expect(nextWrite(x, 'next').version).toBeGreaterThan(9);
    x.sync.destroy();
  });

  it('hydrate twice with the own origin left out of the watermark replays the pending tail both times and still mints fresh', () => {
    const x = client(() => 1000);
    const peer = { ...EMPTY, wm: { other: 3 } };
    x.sync.hydrate(peer, TAIL);
    expect(x.s().v).toBe('p2');
    x.sync.hydrate(peer, TAIL);
    expect(x.s().v).toBe('p2');
    const env = nextWrite(x, 'next');
    expect(env.version).toBeGreaterThan(2);
    expect(cmp(env.hlc, TAIL[1].hlc)).toBe(1);
    expect(x.s().v).toBe('next');
    x.sync.destroy();
  });
});

type S = { a?: string; b?: string; c?: string };
type Key = 'a' | 'b' | 'c';
type Inst = {
  origin: string;
  wall: { v: number };
  st: ReturnType<typeof store<S>>;
  sync: OpSync<S>;
};
type Act =
  | {
      k: 'write' | 'fork' | 'emitOps' | 'override';
      i: number;
      key: Key;
      v: string;
      wall: number;
    }
  | { k: 'deliver'; to: number; pick: number }
  | { k: 'hydrate'; i: number; j: number; pending: boolean }
  | {
      k: 'reboot';
      i: number;
      j: number;
      wall: number;
      via: 'restore' | 'hydratePending' | 'restoreHydrate' | 'hydratePeer';
    }
  | { k: 'seed'; i: number }
  | { k: 'adopt'; i: number; g: string };

function emissionRig() {
  const all: OpEnvelope[] = [];
  const minted = new Map<string, string>();
  const versioned = new Map<string, string>();
  const findings: string[] = [];
  const outbox = (origin: string) => all.filter((e) => e.origin === origin);
  const make = (origin: string, wall: number): Inst =>
    TestBed.runInInjectionContext(() => {
      const w = { v: wall };
      const st = store<S>({});
      const sync = opSync(st, {
        writer: `w${origin}`,
        origin,
        clock: createHlcClock(() => w.v),
      }) as OpSync<S>;
      sync.subscribe((env) => {
        const dot = `${env.origin}@${env.hlc.p}.${env.hlc.l}`;
        const body = JSON.stringify(env);
        if (ownCiteAbove(env)) findings.push(`own-cite-above ${dot}`);
        const prior = minted.get(dot);
        if (prior !== undefined && prior !== body)
          findings.push(`repeated-dot ${dot}`);
        const seq = `${env.origin}#${env.version}`;
        const priorSeq = versioned.get(seq);
        if (priorSeq !== undefined && priorSeq !== body)
          findings.push(`repeated-version ${seq}`);
        if (priorSeq === undefined) versioned.set(seq, body);
        if (prior === undefined) {
          minted.set(dot, body);
          all.push(env);
        }
      });
      return { origin, wall: w, st, sync };
    });
  // a reboot that keeps its origin but carries no tail and no version high-water cannot be told
  // apart from amnesia, so versions are only compared from that reboot on; dots stay checked
  const forgetVersions = (origin: string) => {
    for (const k of [...versioned.keys()])
      if (k.startsWith(`${origin}#`)) versioned.delete(k);
  };
  return { all, findings, outbox, make, forgetVersions };
}

function play(acts: readonly Act[]): string[] {
  const r = emissionRig();
  const insts = [r.make('A', 1), r.make('B', 1)];
  const snap = (j: number) => insts[j].sync.snapshot();
  for (const a of acts) {
    if (a.k === 'deliver') {
      if (r.all.length) insts[a.to].sync.receive(r.all[a.pick % r.all.length]);
      continue;
    }
    const x = insts[a.i];
    if (
      a.k === 'write' ||
      a.k === 'fork' ||
      a.k === 'emitOps' ||
      a.k === 'override'
    ) {
      x.wall.v = a.wall;
      if (a.k === 'write') x.st[a.key].set(a.v);
      else if (a.k === 'override') x.sync.override(() => x.st[a.key].set(a.v));
      else if (a.k === 'emitOps')
        x.sync.emitOps([{ kind: 'set', path: [a.key], next: a.v }]);
      else {
        const f = syncedFork(x.sync, x.st);
        f.store[a.key].set(a.v);
        f.commit();
      }
    } else if (a.k === 'hydrate')
      x.sync.hydrate(snap(a.j), a.pending ? r.outbox(x.origin) : undefined);
    else if (a.k === 'seed') x.sync.seed();
    else if (a.k === 'adopt') x.sync.adopt(a.g);
    else if (a.k === 'reboot') {
      const peer = a.j === a.i ? EMPTY_S : snap(a.j);
      x.sync.destroy();
      const y = r.make(x.origin, a.wall);
      insts[a.i] = y;
      if (a.via === 'hydratePeer') {
        r.forgetVersions(y.origin);
        const high = r
          .outbox(y.origin)
          .reduce<Hlc | undefined>(
            (m, e) => (!m || cmp(e.hlc, m) > 0 ? e.hlc : m),
            undefined,
          );
        y.sync.restore([], undefined, undefined, high);
        y.sync.hydrate(peer);
      } else {
        if (a.via !== 'hydratePending') y.sync.restore(r.outbox(y.origin));
        if (a.via !== 'restore') y.sync.hydrate(peer, r.outbox(y.origin));
      }
    }
    insts[a.i].sync.flush();
  }
  for (const x of insts) x.sync.destroy();
  return r.findings;
}
const EMPTY_S = {
  proto: OP_PROTO_VERSION,
  root: {} as S,
  registers: [],
  wm: {},
};

const i01 = fc.integer({ min: 0, max: 1 });
const keyArb = fc.constantFrom<Key>('a', 'b', 'c');
const wallArb = fc.integer({ min: 1, max: 4 });
const actArb: fc.Arbitrary<Act> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constantFrom(
        'write' as const,
        'fork' as const,
        'emitOps' as const,
        'override' as const,
      ),
      i: i01,
      key: keyArb,
      v: fc.constantFrom('x', 'y', 'z'),
      wall: wallArb,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('deliver' as const),
      to: i01,
      pick: fc.nat(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('hydrate' as const),
      i: i01,
      j: i01,
      pending: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('reboot' as const),
      i: i01,
      j: i01,
      wall: wallArb,
      via: fc.constantFrom(
        'restore' as const,
        'hydratePending' as const,
        'restoreHydrate' as const,
        'hydratePeer' as const,
      ),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant('seed' as const), i: i01 }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('adopt' as const),
      i: i01,
      g: fc.constantFrom('g1', 'g2'),
    }),
  },
);

describe('honest emission over the real opSync', () => {
  it('every emitted envelope passes the model predicate and no dot or (origin, version) pair is minted twice', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      fc.assert(
        fc.property(
          fc.array(actArb, { minLength: 1, maxLength: 20 }),
          (acts) => {
            expect(play(acts)).toEqual([]);
          },
        ),
        { numRuns: 300, seed: 16 },
      );
    } finally {
      warn.mockRestore();
    }
  });
});
