import { describe, expect, it } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Outbox ownership proof — the durable outbox slot under `outbox.key` is a single-writer register.
//
// The slot is ONE whole payload per key (origin, emit high-water, the unacked tail, plus recovery
// metadata: generation, epoch floors, clock high-water), rewritten in full on every persist. Two tabs
// persisting to one key would each overwrite the other's tail, so a tab's unsent writes could vanish
// from disk the moment the other tab persisted. The Web Lock elects exactly one WRITER of the slot
// per key; `crossTab` sets what a tab that did not get the lock does:
//   'queue'     — waits, live only after the owner closes (today's behaviour);
//   'ephemeral' — runs live at once with its own origin and never touches the slot;
//   'off'       — no lock, every tab writes the slot (the app coordinates ownership itself).
//
// Ownership decides DURABILITY of a tab's unacked tail (and which recovery metadata the next boot
// sees) and nothing else. It never decides the order of anyone's writes: that comes from the room
// and from what each write cites (causality → order, never the inverse). This model therefore
// tracks envelope IDS and where each one is held — in a tab's memory, on disk, in the room — and
// says nothing about their order.
//
// Subject: a pure model of {open, write, ack, close, crash} over one key. Properties are checked
// after every step of bounded random traces (three configs incl. mixed, many seeds), and every
// trace ends with a DRAIN witness (reopen once, ack everything) so retention is paired with
// delivery. Teeth: four mutants of the rule set each break a named property, and the lockless
// clobber is a pinned counterexample.
//
// Assumptions the model makes (the real-client specs must cover what these hide): persistence is
// immediate and cannot fail (the client debounces and never awaits the store; a crash inside the
// window drops the last mint, documented as best-effort); the origin generator never repeats; a
// lock manager exists (the no-Web-Locks fallback runs unlocked); local writes before boot and
// emissions still deferred at teardown are outside the model; ack is per envelope in emit order
// (the client keys acks by (origin, version) and also drops refused entries); convergence of two
// live tabs' writes is W3's job on the real client.
// ─────────────────────────────────────────────────────────────────────────────

type Cfg = 'queue' | 'off' | 'ephemeral';
/** `free` = a lockless writer under `'off'`. */
type Role = 'waiting' | 'owner' | 'ephemeral' | 'free' | 'closed';

type Tab = {
  readonly id: string;
  readonly cfg: Cfg;
  role: Role;
  readonly origin: string;
  /** Envelope ids this tab holds in memory, not yet acknowledged by the room. */
  unacked: string[];
  writes: number;
};

type Slot = { readonly origin: string; readonly tail: readonly string[] } | undefined;

/** Rule switches; every `true` is a MUTANT of the design, kept so the proof has teeth. */
type Rules = {
  readonly adoptDiskOrigin: boolean;
  readonly ephemeralPersists: boolean;
  readonly promoteSurvivor: boolean;
  readonly ackNever: boolean;
};
const DESIGN: Rules = {
  adoptDiskOrigin: false,
  ephemeralPersists: false,
  promoteSurvivor: false,
  ackNever: false,
};

type Access = { readonly by: string; readonly role: Role; readonly holder: string | undefined };
type Transition = { readonly tab: string; readonly from: Role; readonly to: Role; readonly handover?: true };

type Model = {
  readonly rules: Rules;
  readonly tabs: Map<string, Tab>;
  slot: Slot;
  holder: string | undefined;
  readonly queue: string[];
  readonly room: Set<string>;
  readonly minted: Set<string>;
  readonly writtenBy: Map<string, { readonly tab: string; readonly role: Role }>;
  readonly slotWrites: Access[];
  readonly slotReads: Access[];
  readonly transitions: Transition[];
  readonly staleMints: string[];
  seq: number;
};

const model = (rules: Rules = DESIGN): Model => ({
  rules,
  tabs: new Map(),
  slot: undefined,
  holder: undefined,
  queue: [],
  room: new Set(),
  minted: new Set(),
  writtenBy: new Map(),
  slotWrites: [],
  slotReads: [],
  transitions: [],
  staleMints: [],
  seq: 0,
});

const setRole = (m: Model, tab: Tab, to: Role, handover?: true): void => {
  m.transitions.push({ tab: tab.id, from: tab.role, to, ...(handover ? { handover } : {}) });
  tab.role = to;
};

const persist = (m: Model, tab: Tab): void => {
  m.slot = { origin: tab.origin, tail: [...tab.unacked] };
  m.slotWrites.push({ by: tab.id, role: tab.role, holder: m.holder });
};

/** Becoming the writer: read the slot, resend its tail, pin this boot's origin at once. */
const restore = (m: Model, tab: Tab): void => {
  m.slotReads.push({ by: tab.id, role: tab.role, holder: m.holder });
  if (m.slot) tab.unacked = [...m.slot.tail, ...tab.unacked];
  persist(m, tab);
};

const open = (m: Model, cfg: Cfg): Tab => {
  const n = ++m.seq;
  const origin = m.rules.adoptDiskOrigin && m.slot ? m.slot.origin : `o${n}`;
  const tab: Tab = { id: `t${n}`, cfg, role: 'closed', origin, unacked: [], writes: 0 };
  m.tabs.set(tab.id, tab);
  if (m.minted.has(origin) || origin === m.slot?.origin) m.staleMints.push(tab.id);
  m.minted.add(origin);
  if (cfg === 'off') {
    setRole(m, tab, 'free');
    restore(m, tab);
  } else if (m.holder === undefined) {
    m.holder = tab.id;
    setRole(m, tab, 'owner');
    restore(m, tab);
  } else if (cfg === 'queue') {
    setRole(m, tab, 'waiting');
    m.queue.push(tab.id);
  } else {
    setRole(m, tab, 'ephemeral');
  }
  return tab;
};

const live = (t: Tab): boolean => t.role === 'owner' || t.role === 'ephemeral' || t.role === 'free';
const persists = (m: Model, t: Tab): boolean =>
  t.role === 'owner' || t.role === 'free' || (t.role === 'ephemeral' && m.rules.ephemeralPersists);

const write = (m: Model, tab: Tab): boolean => {
  if (!live(tab)) return false;
  const env = `${tab.id}:${++tab.writes}`;
  tab.unacked.push(env);
  m.writtenBy.set(env, { tab: tab.id, role: tab.role });
  if (persists(m, tab)) persist(m, tab);
  return true;
};

const ack = (m: Model, tab: Tab): boolean => {
  if (m.rules.ackNever || !live(tab) || tab.unacked.length === 0) return false;
  const env = tab.unacked.shift() as string;
  m.room.add(env);
  if (persists(m, tab)) persist(m, tab);
  return true;
};

const handover = (m: Model): void => {
  const nextId = m.queue.shift();
  if (nextId !== undefined) {
    const next = m.tabs.get(nextId) as Tab;
    m.holder = next.id;
    setRole(m, next, 'owner', true);
    restore(m, next);
    return;
  }
  if (m.rules.promoteSurvivor) {
    const survivor = [...m.tabs.values()].find((t) => t.role === 'ephemeral');
    if (survivor) {
      m.holder = survivor.id;
      setRole(m, survivor, 'owner', true); // the mutant: no rebase of its in-memory tail onto the slot
    }
  }
};

/** `crash` = the tab dies without its close-time persist; the browser still releases its lock. */
const close = (m: Model, tab: Tab, crash: boolean): boolean => {
  if (tab.role === 'closed') return false;
  const was = tab.role;
  if ((was === 'owner' || was === 'free') && !crash) persist(m, tab);
  if (was === 'waiting') m.queue.splice(m.queue.indexOf(tab.id), 1);
  setRole(m, tab, 'closed');
  if (was === 'owner') {
    m.holder = undefined;
    handover(m);
  }
  return true;
};

/** Every written envelope held nowhere: not in the room, not on disk, not in a live tab's memory. */
const lostNow = (m: Model): string[] => {
  const held = new Set<string>(m.room);
  for (const e of m.slot?.tail ?? []) held.add(e);
  for (const t of m.tabs.values()) if (live(t)) for (const e of t.unacked) held.add(e);
  return [...m.writtenBy.keys()].filter((e) => !held.has(e));
};

/**
 * The delivery witness: under a fair schedule (one more boot restores the slot, every live tab
 * gets acked until empty) everything that was not lost reaches the room. Returns what did not.
 */
const drain = (m: Model, cfg: Cfg): string[] => {
  const lost = new Set(lostNow(m));
  if (![...m.tabs.values()].some((t) => t.role === 'owner' || t.role === 'free')) open(m, cfg);
  for (let guard = 0; guard < 10_000; guard++) {
    const t = [...m.tabs.values()].find((x) => live(x) && x.unacked.length > 0);
    if (!t) break;
    if (!ack(m, t)) break;
  }
  return [...m.writtenBy.keys()].filter((e) => !lost.has(e) && !m.room.has(e));
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

// ── properties (each returns the first violation as text, or null) ──────────
type Property = (m: Model) => string | null;

const P1_singleOwner: Property = (m) => {
  const owners = [...m.tabs.values()].filter((t) => t.role === 'owner');
  if (owners.length > 1) return `two owners: ${owners.map((t) => t.id).join(',')}`;
  if (owners.length === 1 && m.holder !== owners[0].id) return `owner ${owners[0].id} is not the lock holder`;
  if (owners.length === 0 && m.holder !== undefined) return `lock held by ${m.holder} with no owner`;
  if (m.holder === undefined && m.queue.length > 0) return `lock free while ${m.queue.join(',')} wait`;
  return null;
};

/** Under the locked modes every slot access is by the tab holding the lock at that moment. */
const P2_singleWriter: Property = (m) => {
  const bad = [...m.slotWrites, ...m.slotReads].find((x) => x.role !== 'free' && x.by !== x.holder);
  if (bad) return `slot accessed by ${bad.by} as ${bad.role} while ${bad.holder ?? 'nobody'} held the lock`;
  return null;
};

const P3_ownerTailOnDisk: Property = (m) => {
  const owner = [...m.tabs.values()].find((t) => t.role === 'owner');
  if (!owner) return null;
  if (!m.slot) return `owner ${owner.id} with an empty slot`;
  if (m.slot.origin !== owner.origin) return `slot pins ${m.slot.origin}, owner is ${owner.origin}`;
  if (!same(m.slot.tail, owner.unacked)) return `slot tail [${m.slot.tail}] ≠ owner tail [${owner.unacked}]`;
  return null;
};

/** The model never ADOPTS an origin from disk; that the generator never repeats is assumed. */
const P4_freshOrigin: Property = (m) =>
  m.staleMints.length ? `${m.staleMints[0]} booted with an origin already minted or on disk` : null;

/** A write can be lost only if it was made by an ephemeral tab AND that tab has terminated. */
const P5_onlyClosedEphemeralLoses: Property = (m) => {
  for (const e of lostNow(m)) {
    const w = m.writtenBy.get(e) as { tab: string; role: Role };
    if (w.role !== 'ephemeral') return `${e} (written as ${w.role}) is lost`;
    if (m.tabs.get(w.tab)?.role !== 'closed') return `${e} is lost while its tab ${w.tab} is still alive`;
  }
  return null;
};

const P6_noPromotion: Property = (m) => {
  const promo = m.transitions.find((x) => x.from === 'ephemeral' && x.to === 'owner');
  if (promo) return `${promo.tab} was promoted ephemeral → owner`;
  const skip = m.transitions.find((x) => x.from === 'waiting' && x.to === 'ephemeral');
  if (skip) return `${skip.tab} went waiting → ephemeral`;
  const early = m.transitions.find((x) => x.from === 'waiting' && x.to === 'owner' && !x.handover);
  return early ? `${early.tab} went waiting → owner outside a handover` : null;
};

const PROPERTIES: readonly (readonly [string, Property])[] = [
  ['P1 single owner = lock holder', P1_singleOwner],
  ['P2 single writer: every slot access by the lock holder', P2_singleWriter],
  ['P3 owner tail on disk', P3_ownerTailOnDisk],
  ['P4 fresh origin per boot', P4_freshOrigin],
  ['P5 only a closed ephemeral tab loses', P5_onlyClosedEphemeralLoses],
  ['P6 no promotion', P6_noPromotion],
];

// ── random driver ────────────────────────────────────────────────────────────
const mulberry32 = (seed: number): (() => number) => {
  let a = (seed + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Config = Cfg | 'mixed';

/** Runs one trace; returns the first violation of `props` with its step, or null. */
function run(
  seed: number,
  config: Config,
  steps: number,
  props: readonly (readonly [string, Property])[],
  rules: Rules = DESIGN,
  withDrain = false,
): string | null {
  const rnd = mulberry32(seed);
  const m = model(rules);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const cfg = (): Cfg => (config === 'mixed' ? (rnd() < 0.5 ? 'queue' : 'ephemeral') : config);
  for (let i = 0; i < steps; i++) {
    const tabs = [...m.tabs.values()].filter((t) => t.role !== 'closed');
    const r = rnd();
    if (tabs.length === 0 || (r < 0.15 && tabs.length < 4)) open(m, cfg());
    else if (r < 0.55) write(m, pick(tabs));
    else if (r < 0.8) ack(m, pick(tabs));
    else close(m, pick(tabs), rnd() < 0.5);
    for (const [name, p] of props) {
      const v = p(m);
      if (v) return `seed ${seed} step ${i} (${config}): ${name}: ${v}`;
    }
  }
  if (withDrain) {
    const undelivered = drain(m, cfg());
    if (undelivered.length) return `seed ${seed} (${config}): drain left [${undelivered}] out of the room`;
  }
  return null;
}

const SEEDS = 400;
const STEPS = 80;

describe('outbox ownership — pure model [PROVEN, bounded random traces]', () => {
  describe.each<Config>(['queue', 'ephemeral', 'mixed'])('crossTab %s', (config) => {
    it('holds P1–P6 on every step of random traces, and a drain delivers everything not lost', () => {
      for (let seed = 0; seed < SEEDS; seed++) {
        expect(run(seed, config, STEPS, PROPERTIES, DESIGN, true)).toBeNull();
      }
    });
  });

  it("'ephemeral' never waits: the second tab is live at once, on its own origin, with no slot access", () => {
    const m = model();
    const a = open(m, 'ephemeral');
    write(m, a);
    const b = open(m, 'ephemeral');
    expect(a.role).toBe('owner');
    expect(b.role).toBe('ephemeral');
    expect(b.origin).not.toBe(a.origin);
    expect(b.origin).not.toBe(m.slot?.origin);
    write(m, b);
    expect(m.slot?.tail).toEqual([`${a.id}:1`]); // B's write never reached the slot
    expect(m.slotWrites.every((w) => w.by === a.id)).toBe(true);
    expect(m.slotReads.every((w) => w.by === a.id)).toBe(true);
  });

  it("'queue' second tab waits, then takes over with the closed owner's tail resent", () => {
    const m = model();
    const a = open(m, 'queue');
    write(m, a);
    const b = open(m, 'queue');
    expect(b.role).toBe('waiting');
    close(m, a, false);
    expect(b.role).toBe('owner');
    expect(b.unacked).toEqual([`${a.id}:1`]); // resent by the new writer
    expect(m.slot).toEqual({ origin: b.origin, tail: [`${a.id}:1`] }); // pinned under B's fresh origin
  });

  it('D2: when the owner closes, a surviving ephemeral tab stays ephemeral and the NEXT tab to open owns', () => {
    const m = model();
    const a = open(m, 'ephemeral');
    const b = open(m, 'ephemeral');
    write(m, b);
    close(m, a, false);
    expect(b.role).toBe('ephemeral');
    expect(m.holder).toBeUndefined();
    const c = open(m, 'ephemeral');
    expect(c.role).toBe('owner');
    expect(lostNow(m)).toEqual([]); // B's tail is still in B's memory
    close(m, b, true);
    expect(lostNow(m)).toEqual([`${b.id}:1`]); // the stated cost of D1, and nothing else
  });

  it('an owner crash loses nothing: the next boot restores and drains its tail', () => {
    const m = model();
    const a = open(m, 'queue');
    write(m, a);
    write(m, a);
    close(m, a, true);
    expect(lostNow(m)).toEqual([]);
    expect(drain(m, 'queue')).toEqual([]);
    expect([...m.room].sort()).toEqual([`${a.id}:1`, `${a.id}:2`]);
  });

  it("PINNED counterexample: under 'off' two lockless tabs clobber each other's tail", () => {
    const m = model();
    const a = open(m, 'off');
    const b = open(m, 'off');
    write(m, a); // slot tail = [a:1]
    write(m, b); // slot tail = [b:1] — a:1 is gone from disk
    close(m, a, true);
    expect(lostNow(m)).toEqual([`${a.id}:1`]);
    expect(P5_onlyClosedEphemeralLoses(m)).not.toBeNull();
  });

  it("under 'off' the loss is reachable by random traces; under the locked modes it never is", () => {
    const reach = (config: Config): boolean => {
      for (let seed = 0; seed < SEEDS; seed++) {
        if (run(seed, config, STEPS, [['P5', P5_onlyClosedEphemeralLoses]]) !== null) return true;
      }
      return false;
    };
    expect(reach('off')).toBe(true);
    expect(reach('queue')).toBe(false);
    expect(reach('ephemeral')).toBe(false);
    expect(reach('mixed')).toBe(false);
  });

  describe('teeth: each mutant of the rules breaks the property it guards', () => {
    const breaks = (rules: Rules, name: string, p: Property, withDrain = false): boolean => {
      for (let seed = 0; seed < SEEDS; seed++) {
        if (run(seed, 'mixed', STEPS, [[name, p]], rules, withDrain) !== null) return true;
      }
      return false;
    };
    it('adopting the disk origin breaks P4', () => {
      expect(breaks({ ...DESIGN, adoptDiskOrigin: true }, 'P4', P4_freshOrigin)).toBe(true);
    });
    it('an ephemeral tab that persists breaks P2 and P3', () => {
      expect(breaks({ ...DESIGN, ephemeralPersists: true }, 'P2', P2_singleWriter)).toBe(true);
      expect(breaks({ ...DESIGN, ephemeralPersists: true }, 'P3', P3_ownerTailOnDisk)).toBe(true);
    });
    it('promoting the survivor breaks P6 and, without a rebase of its tail, P3', () => {
      expect(breaks({ ...DESIGN, promoteSurvivor: true }, 'P6', P6_noPromotion)).toBe(true);
      expect(breaks({ ...DESIGN, promoteSurvivor: true }, 'P3', P3_ownerTailOnDisk)).toBe(true);
    });
    it('a room that never acks survives P1–P6 (they are safety) and is caught by the drain witness', () => {
      const never = { ...DESIGN, ackNever: true };
      for (const [name, p] of PROPERTIES) expect(breaks(never, name, p)).toBe(false);
      expect(breaks(never, 'none', () => null, true)).toBe(true);
    });
  });
});
