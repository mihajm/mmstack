import { describe, expect, it } from 'vitest';
import { createRelay, type CutRow, type Relay, type RelayRow, type RoomState } from './relay';
import { createRegisterStore, extentOf, pathKey, type RegisterStore } from './register';
import { validateEnvelope } from './validate';
import {
  MESH_PROTO_VERSION,
  type CompactionMsg,
  type Dot,
  type DropMsg,
  type Hlc,
  type Key,
  type OpEnvelope,
  type RegisterCheckpoint,
  type SeqEnvelope,
  type ServerMsg,
  type SnapshotState,
  type SyncSibling,
  type WelcomeMsg,
} from './wire';

// ─── verifier-owned oracle: the keep rule and the tombstone count over a full scan ─────────────

const isPrefix = (a: readonly Key[], b: readonly Key[]): boolean =>
  a.length < b.length && a.every((s, i) => String(s) === String(b[i]));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const found = (tree: unknown, path: readonly Key[]): boolean => {
  let cur = tree;
  for (const seg of path) {
    if (!isObj(cur) || !Object.hasOwn(cur, String(seg))) return false;
    cur = cur[String(seg)];
  }
  return true;
};
type LiveReg = { readonly path: readonly Key[]; readonly live: readonly SyncSibling[] };
const oracleKeep =
  (all: readonly LiveReg[]) =>
  (x: LiveReg): boolean => {
    const hasSet = (r: LiveReg) => r.live.some((s) => s.kind === 'set');
    const deeper = all.some((d) => isPrefix(x.path, d.path) && hasSet(d));
    const masks = all.some(
      (a) =>
        isPrefix(a.path, x.path) &&
        a.live.some((s) => s.kind === 'set' && found(s.value, x.path.slice(a.path.length))),
    );
    const multi = x.live.filter((s) => s.kind !== 'clear').length >= 2;
    return (
      !!x.live.length &&
      (hasSet(x) || deeper || (x.live.some((s) => s.kind === 'delete') && masks) || multi)
    );
  };
const liveRegs = (s: RegisterStore): LiveReg[] =>
  s
    .checkpoint()
    .filter((r) => r.siblings.length)
    .map((r) => ({ path: r.path, live: s.siblings(r.path) }));
const oracleCount = (s: RegisterStore): number => {
  const all = liveRegs(s);
  const keep = oracleKeep(all);
  return s
    .checkpoint()
    .filter(
      (r) =>
        r.siblings.length === 1 && r.siblings[0].kind === 'delete' && !Object.keys(r.water).length,
    )
    .filter((r) => !keep({ path: r.path, live: s.siblings(r.path) })).length;
};
const oracleSeed = (s: RegisterStore): string => {
  const all = liveRegs(s);
  const keep = oracleKeep(all);
  return canon(
    all.filter(keep).map((x) => {
      const e = s.maxEpoch(x.path);
      return { path: x.path, siblings: [...x.live], water: {}, ...(e > 0 ? { epoch: e } : {}) };
    }),
  );
};
const canon = (regs: readonly RegisterCheckpoint[]): string =>
  JSON.stringify(
    regs
      .map((r) => ({
        ...r,
        siblings: [...r.siblings].sort((a, b) => (a.origin < b.origin ? -1 : 1)),
      }))
      .sort((a, b) => (pathKey(a.path) < pathKey(b.path) ? -1 : 1)),
  );

// ─── helpers ───────────────────────────────────────────────────────────────────────────────

const env = (
  origin: string,
  p: number,
  ops: OpEnvelope['ops'],
  version = p,
  instance = 'g',
): OpEnvelope => ({
  proto: MESH_PROTO_VERSION,
  instance,
  origin,
  writer: origin,
  version,
  hlc: { p, l: 0 },
  policyVersion: 0,
  ops,
});
const set = (path: Key[], next: unknown, cites: Dot[] = [], epoch = 0) =>
  ({ kind: 'set', path, next, cites, epoch }) as const;
const del = (path: Key[], cites: Dot[] = [], epoch = 0) =>
  ({ kind: 'delete', path, prev: undefined, cites, epoch }) as const;
const clr = (path: Key[], cites: Dot[] = []) => ({ kind: 'clear', path, cites, epoch: 0 }) as const;
const dot = (origin: string, p: number): Dot => ({ origin, hlc: { p, l: 0 } });

describe('validateEnvelope: path encoding', () => {
  it('rejects an empty segment (it would land in the root register) and a unit separator', () => {
    expect(validateEnvelope(env('a', 1, [set([''], 1)]))).toBe('path-empty');
    expect(validateEnvelope(env('a', 1, [set(['x', ''], 1)]))).toBe('path-empty');
    expect(validateEnvelope(env('a', 1, [set(['x\u001fy'], 1)]))).toBe('path-control');
    expect(validateEnvelope(env('a', 1, [set([], {}), set(['x', 0], 1)]))).toBeNull();
  });
  it('the collision the rule closes: the store keys [""] and [] as one register', () => {
    expect(pathKey([''])).toBe(pathKey([]));
    expect(pathKey(['a', 'b'])).toBe(pathKey(['a\u001fb']));
  });
});

describe('RegisterStore: the compaction keep rule', () => {
  it('drops a lone tombstone, keeps one a live ancestor value contains, keeps one over a live set', () => {
    const s = createRegisterStore();
    s.ingest(env('r', 1, [set([], { b: { c: 1 } })]));
    s.ingest(env('a', 2, [del(['k'])]));
    s.ingest(env('a', 3, [del(['b', 'c'])]));
    s.ingest(env('a', 4, [del(['d'])]));
    s.ingest(env('b', 5, [set(['d', 'e'], 1)]));
    expect(s.droppable(['k'])).toBe(true);
    expect(s.droppable(['b', 'c'])).toBe(false); // the root value holds b.c
    expect(s.droppable(['d'])).toBe(false); // a live set below
    expect(s.droppable(['nowhere'])).toBe(true);
    expect(s.droppableTombstones()).toBe(1);
    expect(s.keptRegisters()).toBe(4);
  });
  it('keeps two concurrent live tombstones; a clear masks nothing', () => {
    const s = createRegisterStore();
    s.ingest(env('r', 1, [set([], { k: 1, m: 1 })]));
    s.ingest(env('a', 2, [del(['x'])]));
    s.ingest(env('b', 3, [del(['x'])]));
    s.ingest(env('a', 4, [clr(['m'])]));
    expect(s.droppable(['x'])).toBe(false);
    expect(s.droppable(['m'])).toBe(true);
  });
  it('the seed: live siblings with full identity, no water, the epoch baseline of kept registers', () => {
    const s = createRegisterStore();
    s.ingest(env('r', 1, [set([], { a: 0 })]));
    s.ingest(env('a', 2, [set(['a'], 1, [], 3)]));
    s.ingest(env('b', 3, [set(['a'], 2, [dot('a', 2)])]));
    s.ingest(env('a', 4, [del(['gone'], [], 5)]));
    const seed = s.compactionSeed();
    const at = seed.find((r) => pathKey(r.path) === pathKey(['a']));
    expect(at?.siblings.map((x) => x.origin)).toEqual(['b']);
    expect(at?.water).toEqual({});
    expect(at?.epoch).toBe(3);
    expect(seed.some((r) => pathKey(r.path) === pathKey(['gone']))).toBe(false);
    expect(extentOf(seed)[pathKey(['a'])]).toEqual({ b: { p: 3, l: 0 } });
  });
});

const mulberry32 = (seed: number): (() => number) => {
  let a = (seed + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe('RegisterStore: the maintained count equals the full scan', () => {
  const PATHS: Key[][] = [
    [],
    ['a'],
    ['b'],
    ['b', 'c'],
    ['b', 'x'],
    ['d'],
    ['d', 'e'],
    ['d', 'e', 'f'],
  ];
  const VALUES: unknown[] = [0, { c: 1 }, { e: { f: 1 } }, {}, { a: 1, b: { c: 2 }, d: {} }];
  it('after every ingest, settle and load, over 400 random histories', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = mulberry32(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
      let s = createRegisterStore();
      s.ingest(env('r', 1, [set([], { a: 0, b: { c: 0 }, d: { e: { f: 0 } } })]));
      const versions = new Map<string, number>();
      const settled: Record<string, Hlc> = {};
      for (let step = 2; step < 60; step++) {
        const roll = rnd();
        if (roll < 0.08) {
          for (const r of s.checkpoint())
            for (const x of r.siblings)
              if (rnd() < 0.5 && (!settled[x.origin] || settled[x.origin].p < x.hlc.p))
                settled[x.origin] = x.hlc;
          s.settle(settled);
        } else if (roll < 0.14) {
          const next = createRegisterStore();
          next.load(s.checkpoint());
          s = next;
        } else {
          const origin = pick(['a', 'b', 'c']);
          const path = pick(PATHS);
          const live = s.siblings(path).map((x) => ({ origin: x.origin, hlc: x.hlc }));
          const cites = rnd() < 0.8 ? live : [];
          const kind = path.length ? pick(['set', 'delete', 'delete', 'clear'] as const) : 'set';
          const op =
            kind === 'set'
              ? set(path, pick(VALUES), cites)
              : kind === 'delete'
                ? del(path, cites)
                : clr(path, cites);
          const v = (versions.get(origin) ?? 0) + 1;
          versions.set(origin, v);
          s.ingest(env(origin, step, [op], v));
        }
        expect(s.droppableTombstones(), `seed ${seed} step ${step}`).toBe(oracleCount(s));
        expect(canon(s.compactionSeed()), `seed ${seed} step ${step}`).toBe(oracleSeed(s));
        const all = liveRegs(s);
        const keep = oracleKeep(all);
        expect(s.keptRegisters(), `seed ${seed} step ${step}`).toBe(all.filter(keep).length);
        for (const p of PATHS)
          expect(s.droppable(p), `seed ${seed} ${JSON.stringify(p)}`).toBe(
            !keep({ path: p, live: s.siblings(p) }),
          );
      }
    }
  });
});

// ─── the relay: cut, two-regime gate, journaled refusals, census, hydrate ─────────────────────

type Sent = ServerMsg[];
function member(relay: Relay, origin: string, room = 'r') {
  const sent: Sent = [];
  const conn = relay.connect({ send: (m) => void sent.push(m) }, { writer: origin });
  let version = 0;
  let p = 0;
  const instance = () => relay.room(room)?.instance ?? '';
  return {
    sent,
    conn,
    hello: (seq?: number) =>
      conn.receive({ t: 'hello', room, origin, proto: MESH_PROTO_VERSION, policyVersion: 0, seq }),
    /** Writes the next version at the next stamp (p counts by 10 per origin, offset by name). */
    env: (ops: OpEnvelope['ops'], over: Partial<OpEnvelope> = {}) => {
      const e: OpEnvelope = {
        ...env(origin, (p += 10) + origin.charCodeAt(0) / 1000, ops, ++version, instance()),
        ...over,
      };
      conn.receive({ t: 'env', room, env: e });
      return e;
    },
    compact: (ready: boolean, inst = instance()) =>
      conn.receive({ t: 'compact', room, instance: inst, ready }),
    drops: () => sent.filter((m): m is DropMsg => m.t === 'drop'),
    welcomes: () => sent.filter((m): m is WelcomeMsg => m.t === 'welcome'),
  };
}
const dotOf = (e: OpEnvelope): Dot => ({ origin: e.origin, hlc: e.hlc });

describe('relay: arming compaction cuts', () => {
  it('refuses to arm budget or consensus cuts without the citation gate, loudly', () => {
    expect(() => createRelay({ compaction: { consensus: true } })).toThrow(/verifyCitations/);
    expect(() => createRelay({ compaction: { budget: { floor: 1, factor: 1 } } })).toThrow(
      /verifyCitations/,
    );
    expect(() =>
      createRelay({ policy: { verifyCitations: true }, compaction: { consensus: true } }),
    ).not.toThrow();
  });
});

describe('relay: the compaction cut', () => {
  const armed = (rows: RelayRow[] = [], floor = 2, async = false) =>
    createRelay({
      policy: { verifyCitations: true },
      compaction: { budget: { floor, factor: 0 } },
      onRow: (_r, row) => void rows.push(row),
      // a durable adapter keeps commits in flight, so no commit is quiet: only the hard budget cuts
      onCommit: async ? () => Promise.resolve() : undefined,
    });

  it('the soft budget cuts after a QUIET commit (≥ quietMs since the previous admitted commit), never mid-burst', () => {
    let t = 0;
    const relay = createRelay({
      policy: { verifyCitations: true },
      compaction: { budget: { floor: 4, factor: 0, quietMs: 2000 } },
      now: () => t,
    });
    const a = member(relay, 'a');
    a.hello();
    a.env([set([], { k: 1 })]);
    const before = relay.room('r')?.instance;
    a.env([del(['x1'])]);
    a.env([del(['x2'])]);
    a.env([del(['x3'])]); // 3 > soft 2, but a burst: no cut
    expect(relay.room('r')?.instance).toBe(before);
    t += 1999;
    a.env([del(['x4'])]); // 1999 ms after the previous commit: still not quiet (4 = hard, no cut)
    expect(relay.room('r')?.instance).toBe(before);
    t += 2000;
    a.env([set(['k'], 2)]); // quiet: the soft cut follows this commit
    expect(relay.room('r')?.instance).not.toBe(before);
  });

  it('after a commit the notice goes out only when the whole percent of the hard budget changes', () => {
    const relay = createRelay({
      policy: { verifyCitations: true },
      compaction: { budget: { floor: 300, factor: 0, quietMs: 1e12 } },
    });
    const a = member(relay, 'a');
    a.hello();
    a.env([set([], { k: 1 })]);
    const notices = () => a.sent.filter((m): m is CompactionMsg => m.t === 'compaction');
    const start = notices().length;
    for (let i = 0; i < 6; i++) a.env([del([`x${i}`])]); // 1..6 of 300: percent 0,0,1,1,1,2
    expect(
      notices()
        .slice(start)
        .map((n) => n.count),
    ).toEqual([3, 6]);
    expect(notices().at(-1)).toMatchObject({ budget: 300, ready: [] });
  });

  it('the hard budget cuts on the commit that crosses it: record, row, re-welcome with the seed', async () => {
    const rows: RelayRow[] = [];
    const relay = armed(rows, 2, true);
    const a = member(relay, 'a');
    a.hello();
    const root = a.env([set([], { k: 1 })]);
    const before = relay.room('r')?.instance;
    a.env([del(['x1'])]);
    a.env([del(['x2'])]); // two droppable tombstones: at the budget, no cut
    expect(relay.room('r')?.instance).toBe(before);
    a.env([del(['x3'])]); // three > 2: the cut
    const info = relay.room('r');
    expect(info?.instance).not.toBe(before);
    expect(info?.seq).toBe(5); // four envelopes, then the cut row
    expect(rows).toHaveLength(1);
    const row = rows[0] as CutRow;
    expect(row).toMatchObject({ kind: 'cut', seq: 5, dropped: 3 }); // the droppable count it removed
    expect(row.record).toMatchObject({
      instance: info?.instance,
      seq: 5,
      index: 1,
      reason: 'compaction',
      policy: 'replay',
      firstStamps: {},
      preCutMax: { a: { p: 40.097, l: 0 } },
      receipts: { a: { [before as string]: [[1, 4]] } },
    });
    expect(row.record.seed.map((r) => r.path)).toEqual([[]]); // the tombstones are gone
    expect(row.record.extent).toEqual({ [pathKey([])]: { a: root.hlc } });
    await new Promise((r) => setTimeout(r, 0));
    const w = a.welcomes().at(-1) as WelcomeMsg & { seed?: unknown; registers?: unknown };
    expect(w).toMatchObject({
      seq: 5,
      instance: info?.instance,
      mode: 'snapshot',
      reason: 'compaction',
    });
    expect(w.seed).toEqual(row.record.seed);
    expect(w.registers).toBeUndefined();
    // a later hello is answered with the CURRENT registers, never the seed
    const b = member(relay, 'b');
    b.hello();
    const wb = b.welcomes()[0] as WelcomeMsg & { seed?: unknown; registers?: unknown };
    expect(wb.registers).toBeDefined();
    expect(wb.seed).toBeUndefined();
    expect(wb).toMatchObject({ index: 1, policy: 'replay', receipts: row.record.receipts });
  });

  it('an old-generation envelope is fenced; a replayed pre-cut cite is judged by the frozen extent alone', () => {
    const relay = armed([], 0); // the first lone tombstone (z; y keeps a watermark) crosses it
    const a = member(relay, 'a');
    const b = member(relay, 'b');
    a.hello();
    b.hello();
    a.env([set([], { k: 1 })]);
    const x = a.env([set(['x'], 1)]);
    const y = b.env([set(['y'], 1)]);
    const yDel = b.env([del(['y'], [dotOf(y)])]); // y's set is superseded; a lone tombstone remains
    const gone = a.env([del(['z'])]); // two lone tombstones > 1: the cut drops both
    expect(relay.room('r')?.seq).toBe(6);
    const stale = { ...gone, version: 9 };
    a.conn.receive({ t: 'env', room: 'r', env: stale });
    expect(a.drops().at(-1)).toMatchObject({ reason: 'generation', seq: 6 });
    // a cite of x (retained in the seed) is covered; a cite of b's dropped tombstone is not
    const inst = relay.room('r')?.instance as string;
    a.conn.receive({
      t: 'env',
      room: 'r',
      env: env('a', 70, [set(['x'], 2, [dotOf(x)])], 5, inst),
    });
    expect(relay.room('r')?.seq).toBe(7);
    a.conn.receive({
      t: 'env',
      room: 'r',
      env: env('a', 80, [set(['y'], 2, [dotOf(yDel)])], 6, inst),
    });
    expect(a.drops().at(-1)).toMatchObject({ reason: 'citation', seq: 8, version: 6 });
  });
});

describe('relay: journaled refusals', () => {
  it('a refused envelope is refused again on every resend, quoting the then-current seq; it survives hydrate', () => {
    let state: RoomState | undefined;
    const rows: RelayRow[] = [];
    const opts = {
      policy: { verifyCitations: true },
      onCommit: (_r: string, _e: SeqEnvelope, s: RoomState) => void (state = s),
      onRow: (_r: string, row: RelayRow, s: RoomState) => {
        rows.push(row);
        state = s;
      },
    };
    const relay = createRelay(opts);
    const a = member(relay, 'a');
    const f = member(relay, 'f');
    a.hello();
    f.hello();
    a.env([set([], { k: 1 })]);
    const bad = f.env([set(['k'], 2, [dot('a', 999)])]);
    expect(f.drops()).toEqual([
      { t: 'drop', room: 'r', origin: 'f', version: 1, reason: 'citation', seq: 2 },
    ]);
    a.env([set(['k'], 3)]);
    f.conn.receive({ t: 'env', room: 'r', env: bad }); // the resend
    expect(f.drops().at(-1)).toMatchObject({ reason: 'citation', seq: 3, version: 1 });
    expect(rows.filter((r) => r.kind === 'refuse')).toHaveLength(1); // one row, answered twice
    expect(state?.refused).toEqual({ 'f#1': 'citation' });

    const restarted = createRelay(opts);
    restarted.hydrate('r', {
      seq: state?.seq as number,
      registers: state?.checkpoint(),
      ranges: state?.ranges,
      settled: state?.settled,
      generation: state?.generation,
      everMax: state?.everMax,
      refused: state?.refused,
    });
    const f2 = member(restarted, 'f');
    f2.hello(3);
    f2.conn.receive({ t: 'env', room: 'r', env: bad });
    expect(f2.drops()).toEqual([
      { t: 'drop', room: 'r', origin: 'f', version: 1, reason: 'citation', seq: 3 },
    ]);
  });
});

describe('relay: consensus (declared readiness)', () => {
  const relayOf = (rows: RelayRow[] = []) =>
    createRelay({
      policy: { verifyCitations: true },
      compaction: { consensus: true },
      onRow: (_r, row) => void rows.push(row),
    });
  it('cuts when every connected member declared ready in the current generation', () => {
    const rows: RelayRow[] = [];
    const relay = relayOf(rows);
    const a = member(relay, 'a');
    const b = member(relay, 'b');
    a.hello();
    b.hello();
    a.env([set([], { k: 1 })]);
    a.env([del(['gone'])]);
    const g0 = relay.room('r')?.instance as string;
    a.compact(true);
    expect(rows).toHaveLength(0);
    b.compact(true, 'some-older-generation'); // ignored: bound to the generation it names
    expect(rows).toHaveLength(0);
    const notices = a.sent.filter((m): m is CompactionMsg => m.t === 'compaction');
    expect(notices.at(-1)).toMatchObject({ count: 1, budget: 0, ready: ['a'] });
    b.compact(true);
    expect(rows).toHaveLength(1);
    expect((rows[0] as CutRow).record).toMatchObject({ reason: 'consensus', policy: 'replay' });
    expect((rows[0] as CutRow).dropped).toBe(1); // the one droppable tombstone, `gone`
    expect(relay.room('r')?.instance).not.toBe(g0);
    // readiness resets with the generation: re-declaring the old instance does nothing
    a.compact(true, g0);
    b.compact(true, g0);
    expect(rows).toHaveLength(1);
  });
  it('a leave can make the census unanimous', () => {
    const rows: RelayRow[] = [];
    const relay = relayOf(rows);
    const a = member(relay, 'a');
    const b = member(relay, 'b');
    a.hello();
    b.hello();
    a.env([set([], { k: 1 })]);
    a.compact(true);
    b.conn.disconnect();
    expect(rows).toHaveLength(1);
  });
});

describe('relay: hydrate and the boot assertions', () => {
  it('round-trips the generation record, first stamps, receipts and ever-max', () => {
    let state: RoomState | undefined;
    const opts = {
      policy: { verifyCitations: true },
      onCommit: (_r: string, _e: SeqEnvelope, s: RoomState) => void (state = s),
    };
    const relay = createRelay(opts);
    const a = member(relay, 'a');
    a.hello();
    a.env([set([], { k: 1 })]);
    a.env([set(['k'], 2)]);
    expect(relay.cut('r', { reason: 'compaction' })).toBe(true);
    a.env([set(['k'], 3)]);
    const s = state as RoomState;
    expect(s.generation).toMatchObject({ index: 1, reason: 'compaction', seq: 3 });
    expect(Object.keys(s.generation.firstStamps)).toEqual(['a']);
    const restarted = createRelay(opts);
    restarted.hydrate('r', {
      seq: s.seq,
      registers: s.checkpoint(),
      ranges: s.ranges,
      settled: s.settled,
      generation: s.generation,
      everMax: s.everMax,
    });
    const b = member(restarted, 'b');
    b.hello();
    const w = b.welcomes()[0] as WelcomeMsg & SnapshotState;
    expect(w).toMatchObject({
      instance: s.generation.instance,
      index: 1,
      reason: 'compaction',
      extent: s.generation.extent,
      preCutMax: s.generation.preCutMax,
      firstStamps: s.generation.firstStamps,
      receipts: s.generation.receipts,
    });
  });
  it('refuses to boot a room whose journal mixes generations past the cut', () => {
    const relay = createRelay();
    const generation = {
      instance: 'g1',
      seq: 2,
      index: 1,
      reason: 'compaction',
      policy: 'replay',
      seed: [],
      extent: {},
      preCutMax: {},
      firstStamps: {},
      receipts: {},
    } as const;
    const old = { ...env('a', 3, [set(['k'], 1)], 3, 'g0'), seq: 3 };
    expect(() => relay.hydrate('r', { seq: 3, generation, journal: [old] })).toThrow(
      /inconsistent checkpoint/,
    );
  });
  it('an unrooted room under an armed relay is SERVED and reported uncuttable; it never cuts until its root holds a live set', () => {
    const uncuttable: [string, string][] = [];
    const rows: RelayRow[] = [];
    const relay = createRelay({
      policy: { verifyCitations: true },
      compaction: { consensus: true, budget: { floor: 0, factor: 0 } },
      onRow: (_r, row) => void rows.push(row),
      onUncuttable: (room, reason) => void uncuttable.push([room, reason]),
    });
    const sib = { writer: 'z', origin: 'z', hlc: { p: 1, l: 0 }, epoch: 0 };
    const tomb: RegisterCheckpoint = {
      path: ['k'],
      siblings: [{ kind: 'delete', ...sib }],
      water: {},
    };
    expect(relay.hydrate('r', { seq: 1, registers: [tomb] })).toBe(true);
    expect(uncuttable).toEqual([['r', 'unrooted']]);
    const a = member(relay, 'a');
    a.hello();
    expect(a.welcomes()).toHaveLength(1); // served
    a.env([del(['x'])]); // over the hard budget, but unrooted: no cut
    a.compact(true); // the only member is ready, but unrooted: no cut
    expect(relay.cut('r', { reason: 'compaction' })).toBe(false);
    expect(rows).toHaveLength(0);
    expect(relay.room('r')?.seq).toBe(2);
    a.env([set([], { k: 1 })]); // rooted now: this commit's budget decision cuts
    expect(rows).toHaveLength(1);
    expect((rows[0] as CutRow).record.reason).toBe('compaction');
    // a rooted room, or a relay that arms no cuts, reports nothing
    const quiet: string[] = [];
    const plain = createRelay({ onUncuttable: (room) => void quiet.push(room) });
    expect(plain.hydrate('r', { seq: 1, registers: [tomb] })).toBe(true);
    const rootedRelay = createRelay({
      policy: { verifyCitations: true },
      compaction: { consensus: true },
      onUncuttable: (room) => void quiet.push(room),
    });
    const root: RegisterCheckpoint = {
      path: [],
      siblings: [{ kind: 'set', value: { k: 1 }, ...sib }],
      water: {},
    };
    expect(rootedRelay.hydrate('r', { seq: 1, registers: [root] })).toBe(true);
    expect(quiet).toEqual([]);
  });
});

describe('relay: the migration cut', () => {
  it('a schema-bump envelope is the cut row: discard policy, its root write the seed, its receipt kept', () => {
    let state: RoomState | undefined;
    const relay = createRelay({ onCommit: (_r, _e, s) => void (state = s) });
    const a = member(relay, 'a');
    a.hello();
    a.env([set([], { v: 0 })]);
    const g0 = relay.room('r')?.instance as string;
    const m = a.env([set([], { v: 1 })], { schemaVersion: 1 });
    const s = state as RoomState;
    expect(s.seq).toBe(2);
    expect(s.generation).toMatchObject({
      seq: 2,
      index: 1,
      reason: 'migration',
      policy: 'discard',
    });
    expect(s.generation.seed).toEqual([
      {
        path: [],
        siblings: [expect.objectContaining({ origin: 'a', hlc: m.hlc, value: { v: 1 } })],
        water: {},
      },
    ]);
    expect(s.generation.receipts).toEqual({ a: { [g0]: [[1, 2]] } });
    expect(s.ranges).toEqual({});
    const w = a.welcomes().at(-1) as WelcomeMsg & { seed?: unknown };
    expect(w).toMatchObject({ seq: 2, reason: 'migration', instance: s.instance });
    expect(w.seed).toEqual(s.generation.seed);
  });
});

describe('relay: hydrating a snapshot from before generation records', () => {
  it('floors every settled origin at 0, so an honest cite of a settled, collected dot is admitted', () => {
    // a pre-S2 room: a's first write was superseded by b and collected at settle
    const st = createRegisterStore();
    st.ingest(env('r', 1, [set([], { k: 0 })]));
    const first = env('a', 2, [set(['k'], 1)], 1);
    st.ingest(first);
    st.ingest(env('b', 3, [set(['k'], 2, [dotOf(first)])], 1));
    const settled = { r: { p: 1, l: 0 }, a: first.hlc, b: { p: 3, l: 0 } };
    st.settle(settled);
    expect(st.covers(['k'], dotOf(first))).toBe(false); // collected
    const relay = createRelay({ policy: { verifyCitations: true } });
    relay.hydrate('r', {
      seq: 3,
      registers: st.checkpoint(),
      ranges: { r: [[1, 1]], a: [[1, 1]], b: [[1, 1]] },
      settled,
    });
    const c = member(relay, 'c');
    c.hello(3);
    c.env([set(['k'], 3, [dotOf(first)])]);
    expect(c.drops()).toEqual([]);
    expect(relay.room('r')?.seq).toBe(4);
  });
});

describe('relay: a row whose durability fails', () => {
  it('fires onRowDurabilityFailed once with the row, stalls the room, and never sends the refusal', async () => {
    const failed: RelayRow[] = [];
    const relay = createRelay({
      policy: { verifyCitations: true },
      onRow: () => Promise.reject(new Error('disk full')),
      onRowDurabilityFailed: (_r, row) => void failed.push(row),
      onDurabilityFailed: () => {
        throw new Error('not an envelope');
      },
    });
    const a = member(relay, 'a');
    a.hello();
    a.env([set([], { k: 1 })]);
    a.env([set(['k'], 2, [dot('z', 99)])]); // refused: its row's promise rejects
    await new Promise((r) => setTimeout(r, 0));
    expect(failed).toMatchObject([{ kind: 'refuse', reason: 'citation', origin: 'a', version: 2 }]);
    expect(relay.room('r')?.stalled).toBe(true);
    expect(a.drops()).toEqual([]);
  });
});
