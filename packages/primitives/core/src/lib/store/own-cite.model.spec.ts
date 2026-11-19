import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// Own-cite rule: a pure model in verifier-owned primitives, written from the rule's prose before the
// implementation was read. Nothing here imports the store, op-sync or the mesh protocol.
//
// The rule: an envelope from origin O stamped h is rejected whole (reason 'cites') when one of its cites
// names (O, h') with h' > h (lexicographic on p, then l). The exact self-cite (h' = h) is accepted and
// ignored by ingest. A writer whose clock observes every stamp it ingests, loads or replays never trips it.
//
// NON-COVERAGE (what this model abstracts away):
// - values, op kinds (set, delete, clear, splice), path prefixes and subtree cites: an op is a path and its cites
// - generations, epochs, floors, adopt and every cut: the register here never resets
// - the version tracker, de-duplication by version, and onReject side effects
// - the relay: admission gate, verifyCitations cover, ejection, journal loading and journal rows
// - shape checks beyond the minimum the rule needs (writer, version, op count limits, string limits)
// - mixed deployments where some validators predate the rule, and state already poisoned before it
// - clock bounds: drift limits, max wall skew, counter overflow, NaN or negative wall times
// - transport re-stamping, fork stores, async interleavings inside the real engine, crash windows
// - which dots an honest writer cites: here a write cites every live sibling at its path (no fork frontier)
// - one op per path per envelope: the model allows several; the real validators reject them ('dup-path')
// - the HLC algorithm: the model's clock is its own (observe takes the max, next bumps); only "next is
//   above every observed stamp" is assumed of the real one
// - same-origin amnesia: a writer that lost its outbox and clock high-water can re-mint old dots; out of scope
// - version amnesia: a reboot that keeps its origin but carries no tail and no version high-water can
//   reuse an old version; out of scope, and the model tracks no versions
// - reason precedence between an own cite above and a shape fault elsewhere in the envelope
// - own-origin delivery: the model lets a writer ingest its own old envelope; the real `receive` drops
//   own-origin envelopes, so the blank-session pin in M4 is a model property, not an engine claim

type Hlc = { readonly p: number; readonly l: number };
type Dot = { readonly origin: string; readonly hlc: Hlc };
type Op = { readonly path: string; readonly cites: readonly Dot[] };
type Env = {
  readonly origin: string;
  readonly hlc: Hlc;
  readonly ops: readonly Op[];
};
type Verdict = null | 'shape' | 'cites';

const cmp = (a: Hlc, b: Hlc): number =>
  a.p !== b.p ? (a.p < b.p ? -1 : 1) : a.l === b.l ? 0 : a.l < b.l ? -1 : 1;
const maxHlc = (a: Hlc | undefined, b: Hlc): Hlc =>
  a === undefined || cmp(b, a) > 0 ? b : a;
const sameDot = (a: Dot, b: Dot): boolean =>
  a.origin === b.origin && cmp(a.hlc, b.hlc) === 0;

type Cell = { sibs: Map<string, Hlc>; water: Map<string, Hlc> };
type Register = Map<string, Cell>;

const emptyRegister = (): Register => new Map();

function cell(reg: Register, path: string): Cell {
  let c = reg.get(path);
  if (!c) {
    c = { sibs: new Map(), water: new Map() };
    reg.set(path, c);
  }
  return c;
}

function ingest(reg: Register, env: Env): void {
  const own: Dot = { origin: env.origin, hlc: env.hlc };
  for (const op of env.ops) {
    const c = cell(reg, op.path);
    c.sibs.set(env.origin, maxHlc(c.sibs.get(env.origin), env.hlc));
    for (const cite of op.cites) {
      if (sameDot(cite, own)) continue;
      c.water.set(cite.origin, maxHlc(c.water.get(cite.origin), cite.hlc));
    }
  }
}

function build(envs: readonly Env[]): Register {
  const reg = emptyRegister();
  for (const e of envs) ingest(reg, e);
  return reg;
}

const isLive = (c: Cell | undefined, origin: string, hlc: Hlc): boolean => {
  if (!c) return false;
  const s = c.sibs.get(origin);
  if (!s || cmp(s, hlc) !== 0) return false;
  const w = c.water.get(origin);
  return w === undefined || cmp(hlc, w) > 0;
};

const liveDots = (reg: Register, path: string): Dot[] => {
  const c = reg.get(path);
  if (!c) return [];
  return [...c.sibs]
    .filter(([o, h]) => isLive(c, o, h))
    .map(([origin, hlc]) => ({ origin, hlc }));
};

function canon(reg: Register): string {
  const paths = [...reg.keys()].sort();
  const sortMap = (m: Map<string, Hlc>) =>
    [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(
    paths.map((p) => [
      p,
      sortMap(reg.get(p)!.sibs),
      sortMap(reg.get(p)!.water),
    ]),
  );
}

const isNat = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isHlc = (v: unknown): v is Hlc =>
  typeof v === 'object' &&
  v !== null &&
  isNat((v as Hlc).p) &&
  isNat((v as Hlc).l);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

function validate(raw: unknown, guarded = true): Verdict {
  if (
    !isRecord(raw) ||
    typeof raw['origin'] !== 'string' ||
    !isHlc(raw['hlc']) ||
    !Array.isArray(raw['ops'])
  )
    return 'shape';
  const origin = raw['origin'];
  const hlc = raw['hlc'];
  for (const op of raw['ops'] as unknown[]) {
    if (
      !isRecord(op) ||
      typeof op['path'] !== 'string' ||
      !Array.isArray(op['cites'])
    )
      return 'shape';
    for (const cite of op['cites'] as unknown[]) {
      if (
        !isRecord(cite) ||
        typeof cite['origin'] !== 'string' ||
        !isHlc(cite['hlc'])
      )
        return 'cites';
      if (guarded && cite['origin'] === origin && cmp(cite['hlc'], hlc) > 0)
        return 'cites';
    }
  }
  return null;
}

const accept = (envs: readonly Env[], guarded: boolean) =>
  envs.filter((e) => validate(e, guarded) === null);

const ORIGINS = ['A', 'B', 'C'] as const;
const PATHS = ['x', 'y'] as const;
const hlcArb: fc.Arbitrary<Hlc> = fc.record({
  p: fc.integer({ min: 0, max: 4 }),
  l: fc.integer({ min: 0, max: 2 }),
});
const dotArb: fc.Arbitrary<Dot> = fc.record({
  origin: fc.constantFrom(...ORIGINS),
  hlc: hlcArb,
});
const opArb: fc.Arbitrary<Op> = fc.record({
  path: fc.constantFrom(...PATHS),
  cites: fc.array(dotArb, { maxLength: 3 }),
});
const envArb: fc.Arbitrary<Env> = fc.record({
  origin: fc.constantFrom(...ORIGINS),
  hlc: hlcArb,
  ops: fc.array(opArb, { minLength: 1, maxLength: 3 }),
});
// An own cite strictly above, equal to or below the stamp is spliced into a random op.
const withOwnCite = (rel: 'above' | 'equal' | 'below'): fc.Arbitrary<Env> =>
  fc
    .tuple(
      envArb,
      fc.nat(),
      fc.nat(),
      fc.integer({ min: 1, max: 3 }),
      fc.boolean(),
    )
    .map(([e, at, pos, d, inP]) => {
      const own =
        rel === 'equal'
          ? e.hlc
          : rel === 'above'
            ? inP
              ? { p: e.hlc.p + d, l: 0 }
              : { p: e.hlc.p, l: e.hlc.l + d }
            : e.hlc.l > 0 && !inP
              ? { p: e.hlc.p, l: e.hlc.l - 1 }
              : { p: Math.max(0, e.hlc.p - d), l: e.hlc.p === 0 ? 0 : 7 };
      const i = at % e.ops.length;
      const op = e.ops[i];
      const cites = [...op.cites];
      cites.splice(pos % (cites.length + 1), 0, { origin: e.origin, hlc: own });
      const ops = e.ops.map((o, j) => (j === i ? { ...o, cites } : o));
      return { ...e, ops };
    });
const anyEnvArb = fc.oneof(
  envArb,
  withOwnCite('above'),
  withOwnCite('equal'),
  withOwnCite('below'),
);

type Delivery =
  | 'given'
  | 'shuffled'
  | 'duplicated'
  | 'citesFirst'
  | 'reverseHlc';
const DELIVERIES: readonly Delivery[] = [
  'given',
  'shuffled',
  'duplicated',
  'citesFirst',
  'reverseHlc',
];

function deliver(envs: readonly Env[], how: Delivery, seed: number): Env[] {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0), s / 2 ** 32);
  const shuffle = (xs: Env[]) =>
    xs
      .map((x) => [rnd(), x] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, x]) => x);
  const citeCount = (e: Env) => e.ops.reduce((n, o) => n + o.cites.length, 0);
  switch (how) {
    case 'given':
      return [...envs];
    case 'shuffled':
      return shuffle([...envs]);
    case 'duplicated':
      return shuffle([
        ...envs,
        ...envs.filter(() => rnd() < 0.5),
        ...envs.filter(() => rnd() < 0.3),
      ]);
    case 'citesFirst':
      return [...envs].sort((a, b) => citeCount(b) - citeCount(a));
    case 'reverseHlc':
      return [...envs].sort((a, b) => cmp(b.hlc, a.hlc));
  }
}

// The envelope e raises water[e.origin] at a path only below its own stamp.
function raiseViolations(envs: readonly Env[]): string[] {
  const out: string[] = [];
  const all = build(envs);
  for (const e of envs) {
    const without = build(envs.filter((g) => g !== e));
    const alone = build([e]);
    for (const op of e.ops) {
      const solo = alone.get(op.path)?.water.get(e.origin);
      if (solo && cmp(solo, e.hlc) >= 0)
        out.push(
          `${e.origin}@${e.hlc.p}.${e.hlc.l} alone raised ${op.path} to ${solo.p}.${solo.l}`,
        );
      const after = all.get(op.path)?.water.get(e.origin);
      const before = without.get(op.path)?.water.get(e.origin);
      if (
        after &&
        (before === undefined || cmp(after, before) > 0) &&
        cmp(after, e.hlc) >= 0
      )
        out.push(
          `${e.origin}@${e.hlc.p}.${e.hlc.l} raised ${op.path} to ${after.p}.${after.l}`,
        );
    }
  }
  return out;
}

// A writer's own envelopes stamped at or below e never kill e.
function selfKillViolations(envs: readonly Env[]): string[] {
  const out: string[] = [];
  for (const e of envs) {
    const mine = build(
      envs.filter((g) => g.origin === e.origin && cmp(g.hlc, e.hlc) <= 0),
    );
    for (const op of e.ops)
      if (!isLive(mine.get(op.path), e.origin, e.hlc))
        out.push(`${e.origin}@${e.hlc.p}.${e.hlc.l} dead at ${op.path}`);
  }
  return out;
}

const setArb = fc.array(anyEnvArb, { minLength: 1, maxLength: 6 });

describe('M1: with the rule in front, no accepted envelope kills its own origin at or above its stamp', () => {
  it('[PROVEN] the register is a function of the accepted set under every delivery order', () => {
    fc.assert(
      fc.property(setArb, fc.integer(), (set, seed) => {
        const acc = accept(set, true);
        const want = canon(build(acc));
        for (const how of DELIVERIES)
          expect(canon(build(accept(deliver(set, how, seed), true)))).toBe(
            want,
          );
      }),
      { numRuns: 400 },
    );
  });

  it('[PROVEN] an accepted envelope raises its own watermark only below its stamp, in every delivery', () => {
    fc.assert(
      fc.property(setArb, fc.integer(), (set, seed) => {
        for (const how of DELIVERIES)
          expect(
            raiseViolations(accept(deliver(set, how, seed), true)),
          ).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });

  it('[PROVEN] an accepted write is never dead by its own origin at or below its stamp', () => {
    fc.assert(
      fc.property(setArb, (set) => {
        expect(selfKillViolations(accept(set, true))).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });
});

const K1: Env = {
  origin: 'A',
  hlc: { p: 1, l: 0 },
  ops: [{ path: 'x', cites: [{ origin: 'A', hlc: { p: 2, l: 0 } }] }],
};
const K2: Env = {
  origin: 'A',
  hlc: { p: 2, l: 0 },
  ops: [{ path: 'x', cites: [] }],
};

describe('M2: without the rule the generator finds the kill', () => {
  it('[PROVEN] the raise bound is red for the unguarded model on an unsteered generator', () => {
    const r = fc.check(
      fc.property(
        fc.array(envArb, { minLength: 1, maxLength: 6 }),
        (set) => raiseViolations(accept(set, false)).length === 0,
      ),
      { numRuns: 400, seed: 16 },
    );
    expect(r.failed).toBe(true);
    const [shrunk] = r.counterexample as [Env[]];
    expect(shrunk.some((e) => validate(e) === 'cites')).toBe(true);
    expect(raiseViolations(accept(shrunk, true))).toEqual([]);
  });

  it('[PROVEN] self-kill liveness is red for the unguarded model', () => {
    const r = fc.check(
      fc.property(
        fc.array(envArb, { minLength: 1, maxLength: 6 }),
        (set) => selfKillViolations(accept(set, false)).length === 0,
      ),
      { numRuns: 400, seed: 16 },
    );
    expect(r.failed).toBe(true);
  });

  it('[PIN] K1: A@1.0 citing A@2.0 kills its own write and the later A@2.0 write; the rule rejects it', () => {
    expect(isLive(build([K1]).get('x'), 'A', K1.hlc)).toBe(false);
    for (const order of [
      [K1, K2],
      [K2, K1],
    ]) {
      expect(isLive(build(order).get('x'), 'A', K2.hlc)).toBe(false);
      expect(liveDots(build(accept(order, true)), 'x')).toEqual([
        { origin: 'A', hlc: K2.hlc },
      ]);
    }
    expect(raiseViolations([K1, K2])).toEqual([
      'A@1.0 alone raised x to 2.0',
      'A@1.0 raised x to 2.0',
    ]);
    expect(validate(K1)).toBe('cites');
    expect(validate(K2)).toBeNull();
  });

  it('[PIN] same p, higher l: A@1.0 citing A@1.1 is a kill and is rejected', () => {
    const e: Env = {
      origin: 'A',
      hlc: { p: 1, l: 0 },
      ops: [{ path: 'x', cites: [{ origin: 'A', hlc: { p: 1, l: 1 } }] }],
    };
    expect(selfKillViolations([e])).toEqual(['A@1.0 dead at x']);
    expect(validate(e)).toBe('cites');
  });

  it('[PIN] the exact self-cite is tolerated: accepted and ignored', () => {
    const e: Env = {
      origin: 'A',
      hlc: { p: 1, l: 0 },
      ops: [{ path: 'x', cites: [{ origin: 'A', hlc: { p: 1, l: 0 } }] }],
    };
    expect(validate(e)).toBeNull();
    expect(isLive(build([e]).get('x'), 'A', e.hlc)).toBe(true);
  });
});

const ownAbove = (e: Env) =>
  e.ops.some((o) =>
    o.cites.some((c) => c.origin === e.origin && cmp(c.hlc, e.hlc) > 0),
  );

describe('M3: the verdict is envelope-local and total', () => {
  it('[PROVEN] on well-shaped envelopes the verdict is exactly "some own cite above the stamp"', () => {
    fc.assert(
      fc.property(anyEnvArb, (e) => {
        expect(validate(e)).toBe(ownAbove(e) ? 'cites' : null);
      }),
      { numRuns: 1000 },
    );
  });

  it('[PROVEN] the verdict ignores any history, op order and cite order, and does not mutate the envelope', () => {
    fc.assert(
      fc.property(anyEnvArb, setArb, fc.integer(), (e, history, seed) => {
        const frozen = JSON.stringify(e);
        const before = validate(e);
        build(accept(history, true));
        const rev: Env = {
          ...e,
          ops: [...e.ops]
            .reverse()
            .map((o) => ({ ...o, cites: deliverDots(o.cites, seed) })),
        };
        expect(validate(rev)).toBe(before);
        expect(validate(JSON.parse(frozen))).toBe(before);
        expect(JSON.stringify(e)).toBe(frozen);
      }),
      { numRuns: 500 },
    );
  });

  it('[PROVEN] total: any input yields one of the three verdicts and never throws', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          anyEnvArb,
          fc.record({
            origin: fc.string(),
            hlc: fc.anything(),
            ops: fc.anything(),
          }),
        ),
        (raw) => {
          expect([null, 'shape', 'cites']).toContain(validate(raw));
        },
      ),
      { numRuns: 1000 },
    );
  });
});

function deliverDots(cites: readonly Dot[], seed: number): Dot[] {
  const k = cites.length === 0 ? 0 : Math.abs(seed) % cites.length;
  return [...cites.slice(k), ...cites.slice(0, k)].reverse();
}

// M4: a model writer. Its clock is a verifier-owned HLC: `next` returns a stamp above every observed one.
type Clock = { state: Hlc };
const freshClock = (): Clock => ({ state: { p: 0, l: 0 } });
const observe = (c: Clock, h: Hlc) =>
  void (cmp(h, c.state) > 0 && (c.state = h));
const next = (c: Clock, wall: number): Hlc =>
  (c.state =
    wall > c.state.p ? { p: wall, l: 0 } : { p: c.state.p, l: c.state.l + 1 });

type Writer = {
  origin: string;
  clock: Clock;
  wall: number;
  reg: Register;
  seen: Env[];
  outbox: Env[];
};
type Faults = { observePending: boolean };
type Action =
  | { k: 'write'; w: number; path: string; wall: number }
  | { k: 'deliver'; from: number; to: number; pick: number }
  | { k: 'ack'; w: number; n: number }
  | {
      k: 'reboot';
      w: number;
      wall: number;
      pending: number;
      via: 'hydrate' | 'restore' | 'blank';
    };

const ownStampsHeld = (w: Writer): Hlc[] => {
  const out: Hlc[] = w.outbox.map((e) => e.hlc);
  for (const c of w.reg.values()) {
    const s = c.sibs.get(w.origin);
    const m = c.water.get(w.origin);
    if (s) out.push(s);
    if (m) out.push(m);
  }
  return out;
};

function hydrate(
  w: Writer,
  checkpoint: Register,
  pending: readonly Env[],
  faults: Faults,
): void {
  w.reg = checkpoint;
  for (const c of checkpoint.values()) {
    for (const h of c.sibs.values()) observe(w.clock, h);
    for (const h of c.water.values()) observe(w.clock, h);
  }
  for (const e of pending) {
    if (faults.observePending) observe(w.clock, e.hlc);
    ingest(w.reg, e);
  }
}

function run(actions: readonly Action[], faults: Faults): string[] {
  const writers: Writer[] = ['A', 'B'].map((origin) => ({
    origin,
    clock: freshClock(),
    wall: 0,
    reg: emptyRegister(),
    seen: [],
    outbox: [],
  }));
  const trips: string[] = [];
  for (const a of actions) {
    if (a.k === 'write') {
      const w = writers[a.w];
      w.wall = a.wall;
      const held = ownStampsHeld(w);
      const hlc = next(w.clock, w.wall);
      const env: Env = {
        origin: w.origin,
        hlc,
        ops: [{ path: a.path, cites: liveDots(w.reg, a.path) }],
      };
      if (validate(env) !== null)
        trips.push(`trip ${w.origin}@${hlc.p}.${hlc.l}`);
      if (held.some((h) => cmp(h, hlc) === 0))
        trips.push(`dup ${w.origin}@${hlc.p}.${hlc.l}`);
      ingest(w.reg, env);
      w.seen.push(env);
      w.outbox.push(env);
    } else if (a.k === 'deliver') {
      const from = writers[a.from];
      const to = writers[a.to];
      if (from.seen.length === 0) continue;
      const env = from.seen[a.pick % from.seen.length];
      observe(to.clock, env.hlc);
      ingest(to.reg, env);
      to.seen.push(env);
    } else if (a.k === 'ack') {
      writers[a.w].outbox.splice(0, a.n);
    } else {
      const w = writers[a.w];
      const pending = w.outbox.slice(Math.max(0, w.outbox.length - a.pending));
      const checkpoint = build(w.seen.filter((e) => !pending.includes(e)));
      const reborn: Writer = {
        ...w,
        clock: freshClock(),
        wall: a.wall,
        reg: emptyRegister(),
      };
      if (a.via === 'blank') {
        reborn.outbox = [];
        reborn.seen = [];
      } else if (a.via === 'hydrate')
        hydrate(reborn, checkpoint, pending, faults);
      else {
        hydrate(reborn, checkpoint, [], faults);
        for (const e of pending) {
          observe(reborn.clock, e.hlc);
          ingest(reborn.reg, e);
        }
      }
      writers[a.w] = reborn;
    }
  }
  return trips;
}

const wallArb = fc.integer({ min: 0, max: 4 });
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      k: fc.constant('write' as const),
      w: fc.integer({ min: 0, max: 1 }),
      path: fc.constantFrom(...PATHS),
      wall: wallArb,
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      k: fc.constant('deliver' as const),
      from: fc.integer({ min: 0, max: 1 }),
      to: fc.integer({ min: 0, max: 1 }),
      pick: fc.nat(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('ack' as const),
      w: fc.integer({ min: 0, max: 1 }),
      n: fc.integer({ min: 0, max: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('reboot' as const),
      w: fc.integer({ min: 0, max: 1 }),
      wall: wallArb,
      pending: fc.integer({ min: 0, max: 3 }),
      via: fc.constantFrom(
        'hydrate' as const,
        'restore' as const,
        'blank' as const,
      ),
    }),
  },
);
const scriptArb = fc.array(actionArb, { minLength: 1, maxLength: 25 });

const PENDING: Env = {
  origin: 'A',
  hlc: { p: 2000, l: 0 },
  ops: [{ path: 'x', cites: [] }],
};
function pendingReplayCounterexample(wall: number, faults: Faults) {
  const w: Writer = {
    origin: 'A',
    clock: freshClock(),
    wall,
    reg: emptyRegister(),
    seen: [],
    outbox: [PENDING],
  };
  hydrate(w, emptyRegister(), [PENDING], faults);
  const cites = liveDots(w.reg, 'x');
  const hlc = next(w.clock, wall);
  return {
    cites,
    hlc,
    env: { origin: 'A', hlc, ops: [{ path: 'x', cites }] } as Env,
  };
}

describe('M4: honest emission never trips the rule and never repeats a dot', () => {
  it('[PROVEN] a writer that observes everything it ingests, loads or replays never trips', () => {
    fc.assert(
      fc.property(scriptArb, (s) => {
        expect(run(s, { observePending: true })).toEqual([]);
      }),
      { numRuns: 4000 },
    );
  });

  it('[PROVEN] neuter: a writer that skips observing replayed pending stamps trips, found by the generator', () => {
    const r = fc.check(
      fc.property(
        scriptArb,
        (s) => run(s, { observePending: false }).length === 0,
      ),
      { numRuns: 2000, seed: 16 },
    );
    expect(r.failed).toBe(true);
    const [script] = r.counterexample as [Action[]];
    expect(script.some((a) => a.k === 'reboot' && a.via === 'hydrate')).toBe(
      true,
    );
  });

  it('[PIN] model only: a blank session of A handed its own old write observes it before stamping (the real receive drops own-origin envelopes)', () => {
    const script: Action[] = [
      { k: 'write', w: 0, path: 'x', wall: 3 },
      { k: 'deliver', from: 0, to: 1, pick: 0 },
      { k: 'reboot', w: 0, wall: 1, pending: 0, via: 'blank' },
      { k: 'deliver', from: 1, to: 0, pick: 0 },
      { k: 'write', w: 0, path: 'x', wall: 1 },
      { k: 'write', w: 0, path: 'x', wall: 3 },
    ];
    expect(run(script, { observePending: true })).toEqual([]);
  });

  it('[PIN] hydrate with pending A@2000.0 at wall 1000: unobserved -> the next write cites A@2000.0 and stamps 1000.0', () => {
    const bad = pendingReplayCounterexample(1000, { observePending: false });
    expect(bad.cites).toEqual([{ origin: 'A', hlc: { p: 2000, l: 0 } }]);
    expect(bad.hlc).toEqual({ p: 1000, l: 0 });
    expect(validate(bad.env)).toBe('cites');
    const good = pendingReplayCounterexample(1000, { observePending: true });
    expect(good.hlc).toEqual({ p: 2000, l: 1 });
    expect(validate(good.env)).toBeNull();
  });

  it('[PIN] hydrate with pending A@2000.0 at wall 2000: unobserved -> the next write mints the equal dot A@2000.0', () => {
    const bad = pendingReplayCounterexample(2000, { observePending: false });
    expect(bad.hlc).toEqual(PENDING.hlc);
    expect(validate(bad.env)).toBeNull();
    const good = pendingReplayCounterexample(2000, { observePending: true });
    expect(cmp(good.hlc, PENDING.hlc)).toBe(1);
  });
});
