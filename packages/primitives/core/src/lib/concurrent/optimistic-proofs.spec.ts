/**
 * Proof harness for optimistic writes, two tiers.
 *
 * A pure model: nodes with truth, bodies that open, guess, write authoritative values, and settle
 * (complete | abort | fail | supersede | destroy) in any interleaving, while foreign writers (a user,
 * a refetch) move truth underneath. One reference oracle states what every reader must see; each
 * tier's mechanism is a small machine replayed against it over generated traces.
 *
 * - Live tier: a guess is a live write with its own revert-always stamp, kept in a per-node guess
 *   history. Every reader sees it. Any later authoritative write buries it for good.
 * - Overlay tier: one fork per body over a base record, reconciled with the real `merge3`, read
 *   through a facade that folds the open forks over the base in open order. Base readers never see
 *   a guess. Forks are discarded at settlement, never committed.
 *
 * Tempting alternatives are encoded beside each machine and shown to break a named property.
 * The last sections replay the same traces against the real `guessable` + `createTransaction` +
 * `hold()` and the real `optimisticStore`, in lockstep with the oracle.
 */
import { Injector, signal, untracked } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { forkStore, merge3 } from '../store/fork-store';
import { optimisticStore } from '../store/optimistic-store';
import { store } from '../store/store';
import { recordTargetOf } from './active-transaction';
import { guessable, type Guessable } from './optimistic';
import { createTransaction, type Transaction } from './transaction';
import {
  createTransitionScope,
  type TransitionScope,
} from './transition-scope';

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type SettleKind = 'complete' | 'abort' | 'fail' | 'supersede' | 'destroy';
const SETTLE_KINDS: readonly SettleKind[] = [
  'complete',
  'abort',
  'fail',
  'supersede',
  'destroy',
];
/** Only completion keeps a body's authoritative writes; every settlement drops its guesses. */
const keepsWrites = (k: SettleKind) => k === 'complete';

/** `foreign` with `v: null` writes whatever readers currently see (a server confirming a guess). */
type Ev =
  | { readonly t: 'open'; readonly b: number }
  | {
      readonly t: 'guess';
      readonly b: number;
      readonly n: string;
      readonly v: string;
    }
  | {
      readonly t: 'write';
      readonly b: number;
      readonly n: string;
      readonly v: string;
    }
  | { readonly t: 'foreign'; readonly n: string; readonly v: string | null }
  | { readonly t: 'settle'; readonly b: number; readonly k: SettleKind }
  | { readonly t: 'hold' }
  | { readonly t: 'release' };

type GenOpts = {
  readonly nodes: readonly string[];
  readonly bodies: number;
  readonly steps: number;
  readonly writes?: boolean;
  readonly collide?: boolean;
  readonly holds?: boolean;
};

function genTrace(seed: number, o: GenOpts): Ev[] {
  const r = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const evs: Ev[] = [];
  const open: number[] = [];
  let opened = 0;
  let tv = 0;
  let gv = 0;
  let held = false;
  for (let s = 0; s < o.steps; s++) {
    if (opened < o.bodies && (open.length === 0 || r() < 0.15)) {
      evs.push({ t: 'open', b: opened });
      open.push(opened++);
      continue;
    }
    const x = r();
    const n = pick(o.nodes);
    if (open.length && x < 0.42) {
      evs.push({ t: 'guess', b: pick(open), n, v: `g${++gv}` });
    } else if (open.length && o.writes && x < 0.52) {
      evs.push({ t: 'write', b: pick(open), n, v: `w${++tv}` });
    } else if (x < 0.7) {
      const confirm = o.collide && r() < 0.5;
      evs.push({ t: 'foreign', n, v: confirm ? null : `t${++tv}` });
    } else if (o.holds && x < 0.8) {
      evs.push(held ? { t: 'release' } : { t: 'hold' });
      held = !held;
    } else if (open.length) {
      const b = pick(open);
      open.splice(open.indexOf(b), 1);
      evs.push({ t: 'settle', b, k: pick(SETTLE_KINDS) });
    }
  }
  while (open.length) {
    const b = open.splice(Math.floor(r() * open.length), 1)[0];
    evs.push({ t: 'settle', b, k: pick(SETTLE_KINDS) });
  }
  if (held) evs.push({ t: 'release' });
  return evs;
}

/**
 * The reference semantics. Truth is a register per node with conditional, generation-owned undo:
 * an aborting body restores its pre-value only where its own last write is still the truth.
 * Guesses are a list ordered by (body open order, body generation).
 */
class Oracle {
  private readonly truthCells = new Map<string, { v: string; id: number }>();
  private readonly logs = new Map<
    number,
    { n: string; pre: { v: string; id: number }; last: number }[]
  >();
  private readonly guesses: {
    b: number;
    order: number;
    gen: number;
    n: string;
    v: string;
    time: number;
  }[] = [];
  private readonly lastAuth = new Map<string, number>();
  private readonly order = new Map<number, number>();
  private readonly gen = new Map<number, number>();
  private readonly settledGuesses = new Map<number, string[]>();
  private id = 0;
  private clock = 0;

  constructor(nodes: readonly string[]) {
    for (const n of nodes)
      this.truthCells.set(n, { v: `${n}0`, id: ++this.id });
  }

  open(b: number) {
    this.order.set(b, this.order.size);
    this.gen.set(b, 0);
    this.logs.set(b, []);
  }
  guess(b: number, n: string, v: string) {
    const gen = this.nextGen(b);
    this.guesses.push({
      b,
      order: this.order.get(b)!,
      gen,
      n,
      v,
      time: ++this.clock,
    });
  }
  write(b: number, n: string, v: string) {
    this.nextGen(b);
    // one entry per write (each write is its own slice), as the real ledger keeps them
    const e = { n, pre: this.truthCells.get(n)!, last: 0 };
    this.logs.get(b)!.push(e);
    e.last = this.setTruth(n, v);
  }
  foreign(n: string, v: string) {
    this.setTruth(n, v);
  }
  settle(b: number, k: SettleKind) {
    if (!keepsWrites(k))
      for (const e of [...this.logs.get(b)!].reverse())
        // a restore re-instates the pre-value WITH its writer's generation, and buries nothing
        if (this.truthCells.get(e.n)!.id === e.last)
          this.truthCells.set(e.n, e.pre);
    const mine = this.guesses.filter((g) => g.b === b);
    this.settledGuesses.set(
      b,
      mine.map((g) => g.v),
    );
    for (const g of mine) this.guesses.splice(this.guesses.indexOf(g), 1);
  }
  truth(n: string): string {
    return this.truthCells.get(n)!.v;
  }
  /** Live tier: the most recent open guess laid after the node's last authoritative write. */
  live(n: string): string {
    return this.liveGuess(n) ?? this.truth(n);
  }
  liveGuess(n: string): string | undefined {
    const since = this.lastAuth.get(n) ?? 0;
    return this.top(n, (g) => g.time > since);
  }
  /** Overlay tier facade: the most recent open guess shadows truth until its body settles. */
  overlay(n: string): string {
    return this.top(n, () => true) ?? this.truth(n);
  }
  /** Every guess value of a settled body (for the no-phantom property). */
  settledGuessValues(): Set<string> {
    return new Set([...this.settledGuesses.values()].flat());
  }

  private top(n: string, keep: (g: Oracle['guesses'][number]) => boolean) {
    let best: Oracle['guesses'][number] | undefined;
    for (const g of this.guesses) {
      if (g.n !== n || !keep(g)) continue;
      if (
        !best ||
        g.order > best.order ||
        (g.order === best.order && g.gen > best.gen)
      )
        best = g;
    }
    return best?.v;
  }
  private nextGen(b: number) {
    const g = this.gen.get(b)! + 1;
    this.gen.set(b, g);
    return g;
  }
  private setTruth(n: string, v: string) {
    const id = ++this.id;
    this.truthCells.set(n, { v, id });
    this.lastAuth.set(n, ++this.clock);
    return id;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Live tier mechanism. One physical cell per node (the live signal). While guesses are in effect
// the machine keeps the truth beneath them as a shadow; undo logs and conflict checks read the
// shadow, never the guess. "In effect" = the cell still holds the stamp the machine last wrote.
// ────────────────────────────────────────────────────────────────────────────
type Kind = 'initial' | 'auth' | 'guess';
type Cell = {
  readonly value: string;
  readonly id: number;
  readonly kind: Kind;
};
type GuessEntry = { b: number; order: number; gen: number; v: string };
type GuessState = { hist: GuessEntry[]; truth: Cell; mine: Cell };

type LiveOpts = {
  /** How a later writer is detected: a stamp per write, or `Object.is` on the value (no stamp). */
  readonly detect: 'stamp' | 'objectIs';
  /** false: each guess snapshots the value it covered and restores it (blind snapshot). */
  readonly history: boolean;
  /** true: a body's authoritative write on a node it guessed reuses the guess's entry. */
  readonly sharedGen: boolean;
  /** true: undo logs record and compare the DISPLAYED value, guesses included. */
  readonly recordDisplayed: boolean;
  /** Held readers: no bypass, bypass for reads only, or reads plus a truth-only frozen frame. */
  readonly bypass: 'none' | 'reads' | 'both';
  /** true: a guess is an ordinary recorded write, kept on completion (write-then-rollback). */
  readonly wtr: boolean;
};
const LIVE: LiveOpts = {
  detect: 'stamp',
  history: true,
  sharedGen: false,
  recordDisplayed: false,
  bypass: 'both',
  wtr: false,
};

class LiveMachine {
  private readonly cells = new Map<string, Cell>();
  private readonly gs = new Map<string, GuessState>();
  private readonly blind = new Map<string, { pre: Cell; mine: Cell }>(); // `${b}|${n}`
  private readonly logs = new Map<
    number,
    { n: string; pre: Cell; last: Cell }[]
  >();
  private readonly order = new Map<number, number>();
  private readonly gen = new Map<number, number>();
  private frozen: Map<string, Cell> | null = null;
  private id = 0;
  /** Every pre-value any undo log recorded, for the generation-exclusion property. */
  readonly audit: Cell[] = [];

  constructor(
    private readonly nodes: readonly string[],
    private readonly o: LiveOpts,
  ) {
    for (const n of nodes) this.cells.set(n, this.cell(`${n}0`, 'initial'));
  }

  display(n: string): string {
    return this.cells.get(n)!.value;
  }
  heldRead(n: string): string {
    if (!this.frozen) return this.display(n);
    if (this.o.bypass !== 'none' && this.inEffect(n)) return this.display(n);
    return this.frozen.get(n)!.value;
  }
  hold() {
    this.frozen = new Map(
      this.nodes.map((n) => [
        n,
        this.o.bypass === 'both' ? this.truthView(n) : this.cells.get(n)!,
      ]),
    );
  }
  release() {
    this.frozen = null;
  }

  open(b: number) {
    this.order.set(b, this.order.size);
    this.gen.set(b, 0);
    this.logs.set(b, []);
  }

  guess(b: number, n: string, v: string) {
    if (this.o.wtr) return this.authWrite(b, n, v, 'guess');
    const gen = this.nextGen(b);
    if (!this.o.history) {
      const key = `${b}|${n}`;
      const pre = this.blind.get(key)?.pre ?? this.cells.get(n)!;
      const mine = this.cell(v, 'guess');
      this.cells.set(n, mine);
      this.blind.set(key, { pre, mine });
      return;
    }
    let g = this.sync(n);
    if (!g) {
      const c = this.cells.get(n)!;
      g = { hist: [], truth: c, mine: c };
      this.gs.set(n, g);
    }
    g.hist.push({ b, order: this.order.get(b)!, gen, v });
    this.apply(n, g);
  }

  write(b: number, n: string, v: string) {
    const g = this.o.history && !this.o.wtr ? this.sync(n) : undefined;
    if (this.o.sharedGen && g) {
      const own = g.hist.filter((e) => e.b === b).at(-1);
      if (own) {
        own.v = v; // the authoritative value rides the revert-always entry
        return this.apply(n, g);
      }
    }
    this.authWrite(b, n, v, 'auth');
  }

  foreign(n: string, v: string) {
    this.cells.set(n, this.cell(v, 'auth'));
  }

  settle(b: number, k: SettleKind) {
    if (!keepsWrites(k)) {
      for (const e of [...this.logs.get(b)!].reverse()) {
        const n = e.n;
        const g = this.o.recordDisplayed ? undefined : this.sync(n);
        const current = g ? g.truth : this.cells.get(n)!;
        if (!this.same(current, e.last)) continue; // a later writer took over: yield
        if (g) g.truth = e.pre;
        else this.cells.set(n, e.pre);
      }
    }
    if (this.o.wtr) return;
    if (!this.o.history) {
      for (const [key, rec] of [...this.blind]) {
        if (!key.startsWith(`${b}|`)) continue;
        const n = key.slice(key.indexOf('|') + 1);
        if (this.same(this.cells.get(n)!, rec.mine)) this.cells.set(n, rec.pre);
        this.blind.delete(key);
      }
      return;
    }
    for (const n of this.nodes) {
      const g = this.sync(n);
      if (!g) continue;
      g.hist = g.hist.filter((e) => e.b !== b);
      if (g.hist.length) this.apply(n, g);
      else {
        this.cells.set(n, g.truth); // the truth keeps its own stamp
        this.gs.delete(n);
      }
    }
  }

  private authWrite(b: number, n: string, v: string, kind: Kind) {
    this.nextGen(b);
    const pre = this.truthView(n);
    this.audit.push(pre);
    const c = this.cell(v, kind);
    this.cells.set(n, c); // a live write: it buries any guess beneath it
    this.logs.get(b)!.push({ n, pre, last: c });
  }
  private apply(n: string, g: GuessState) {
    let top = g.hist[0];
    for (const e of g.hist)
      if (e.order > top.order || (e.order === top.order && e.gen > top.gen))
        top = e;
    g.mine = this.cell(top.v, 'guess');
    this.cells.set(n, g.mine);
  }
  private sync(n: string): GuessState | undefined {
    const g = this.gs.get(n);
    if (g && !this.same(this.cells.get(n)!, g.mine)) this.gs.delete(n); // buried for good
    return this.gs.get(n);
  }
  private inEffect(n: string) {
    return this.o.history && !this.o.wtr && !!this.sync(n);
  }
  private truthView(n: string): Cell {
    if (this.o.recordDisplayed || !this.o.history || this.o.wtr)
      return this.cells.get(n)!;
    return this.sync(n)?.truth ?? this.cells.get(n)!;
  }
  private same(a: Cell, b: Cell) {
    return this.o.detect === 'stamp'
      ? a.id === b.id
      : Object.is(a.value, b.value);
  }
  private cell(value: string, kind: Kind): Cell {
    return { value, id: ++this.id, kind };
  }
  private nextGen(b: number) {
    const g = this.gen.get(b)! + 1;
    this.gen.set(b, g);
    return g;
  }
}

type Violation = {
  readonly prop: string;
  readonly step: number;
  readonly detail: string;
};

/**
 * Replays a trace through the oracle and a live machine in lockstep, checking after every event:
 * visibility (every reader), no phantom (no settled body's guess on screen), generation exclusion
 * (no undo log recorded a guess), held visibility (while a hold is open), and no leak at the end.
 */
function runLive(
  trace: readonly Ev[],
  nodes: readonly string[],
  o: LiveOpts,
): Violation[] {
  const oracle = new Oracle(nodes);
  const m = new LiveMachine(nodes, o);
  const out: Violation[] = [];
  const flag = (prop: string, step: number, detail: string) => {
    if (!out.some((v) => v.prop === prop)) out.push({ prop, step, detail });
  };
  let frozenTruth: Map<string, string> | null = null;
  let collided = false;
  trace.forEach((ev, step) => {
    switch (ev.t) {
      case 'open':
        oracle.open(ev.b);
        m.open(ev.b);
        break;
      case 'guess':
        oracle.guess(ev.b, ev.n, ev.v);
        m.guess(ev.b, ev.n, ev.v);
        break;
      case 'write':
        oracle.write(ev.b, ev.n, ev.v);
        m.write(ev.b, ev.n, ev.v);
        break;
      case 'foreign': {
        const v = ev.v ?? oracle.live(ev.n);
        if (ev.v === null) collided = true;
        oracle.foreign(ev.n, v);
        m.foreign(ev.n, v);
        break;
      }
      case 'settle':
        oracle.settle(ev.b, ev.k);
        m.settle(ev.b, ev.k);
        break;
      case 'hold':
        frozenTruth = new Map(nodes.map((n) => [n, oracle.truth(n)]));
        m.hold();
        break;
      case 'release':
        frozenTruth = null;
        m.release();
        break;
    }
    const phantoms = oracle.settledGuessValues();
    for (const n of nodes) {
      const got = m.display(n);
      const want = oracle.live(n);
      if (got !== want) flag('visibility', step, `${n}: ${got} != ${want}`);
      if (!collided && phantoms.has(got)) flag('phantom', step, `${n}: ${got}`);
      if (frozenTruth) {
        const wantHeld = oracle.liveGuess(n) ?? frozenTruth.get(n)!;
        const held = m.heldRead(n);
        if (held !== wantHeld)
          flag('held-visibility', step, `${n}: ${held} != ${wantHeld}`);
      }
    }
    if (m.audit.some((c) => c.kind === 'guess'))
      flag(
        'guess-in-undo-log',
        step,
        'an undo log recorded a guess as a pre-value',
      );
  });
  for (const n of nodes)
    if (m.display(n) !== oracle.truth(n))
      flag(
        'no-leak',
        trace.length,
        `${n}: ${m.display(n)} != ${oracle.truth(n)}`,
      );
  return out;
}

const NODES = ['n', 'm'] as const;
const SEEDS = 3000;
const ALT_SEEDS = 600;
const props = (vs: readonly Violation[]) => vs.map((v) => v.prop);

/** The first seed whose trace breaks `prop` under `o`, or -1. */
function findCounterexample(
  prop: string,
  o: LiveOpts,
  gen: Omit<GenOpts, 'nodes'>,
): number {
  for (let seed = 1; seed <= ALT_SEEDS; seed++)
    if (
      props(
        runLive(genTrace(seed, { nodes: NODES, ...gen }), NODES, o),
      ).includes(prop)
    )
      return seed;
  return -1;
}

/** Replays a hand-written trace and returns the display of every node after each event. */
function liveFrames(
  trace: readonly Ev[],
  o: LiveOpts,
  nodes: readonly string[] = ['n'],
) {
  const m = new LiveMachine(nodes, o);
  return trace.map((ev) => {
    switch (ev.t) {
      case 'open':
        m.open(ev.b);
        break;
      case 'guess':
        m.guess(ev.b, ev.n, ev.v);
        break;
      case 'write':
        m.write(ev.b, ev.n, ev.v);
        break;
      case 'foreign':
        m.foreign(ev.n, ev.v ?? m.display(ev.n));
        break;
      case 'settle':
        m.settle(ev.b, ev.k);
        break;
      case 'hold':
        m.hold();
        break;
      case 'release':
        m.release();
        break;
    }
    return nodes.map((n) => `${m.display(n)}/${m.heldRead(n)}`).join(' ');
  });
}
const shown = (frames: readonly string[]) => frames.map((f) => f.split('/')[0]);

const open = (b: number): Ev => ({ t: 'open', b });
const guess = (b: number, v: string, n = 'n'): Ev => ({ t: 'guess', b, n, v });
const write = (b: number, v: string, n = 'n'): Ev => ({ t: 'write', b, n, v });
const foreign = (v: string | null, n = 'n'): Ev => ({ t: 'foreign', n, v });
const settle = (b: number, k: SettleKind): Ev => ({ t: 'settle', b, k });
const A = 0;
const B = 1;

describe('optimistic model, live tier', () => {
  describe('generated interleavings', () => {
    const shapes: [string, Omit<GenOpts, 'nodes'>][] = [
      ['guesses and foreign writes', { bodies: 3, steps: 24 }],
      [
        'plus write-through reconciles and holds',
        { bodies: 3, steps: 30, writes: true, holds: true },
      ],
      [
        'plus foreign writes that confirm a guess',
        { bodies: 3, steps: 30, writes: true, collide: true },
      ],
    ];
    for (const [name, gen] of shapes) {
      it(`every property holds: ${name}`, () => {
        for (let seed = 1; seed <= SEEDS; seed++) {
          const vs = runLive(
            genTrace(seed, { nodes: NODES, ...gen }),
            NODES,
            LIVE,
          );
          if (vs.length) throw new Error(`seed ${seed}: ${JSON.stringify(vs)}`);
        }
      });
    }

    it('the generator reaches the shapes the properties are about', () => {
      const seen = {
        bothOrders: new Set<string>(),
        burials: 0,
        heldGuesses: 0,
        restoresUnder: 0,
      };
      for (let seed = 1; seed <= SEEDS; seed++) {
        const trace = genTrace(seed, {
          nodes: NODES,
          bodies: 3,
          steps: 30,
          writes: true,
          holds: true,
        });
        const oracle = new Oracle(NODES);
        const guessed = new Map<number, Set<string>>();
        let held = false;
        for (const ev of trace) {
          if (ev.t === 'open') {
            oracle.open(ev.b);
            guessed.set(ev.b, new Set());
          }
          if (ev.t === 'guess') {
            oracle.guess(ev.b, ev.n, ev.v);
            guessed.get(ev.b)!.add(ev.n);
            if (held) seen.heldGuesses++;
          }
          if (ev.t === 'write' || ev.t === 'foreign') {
            if (oracle.liveGuess(ev.n) !== undefined) seen.burials++;
            if (ev.t === 'write') oracle.write(ev.b, ev.n, ev.v);
            else oracle.foreign(ev.n, ev.v ?? oracle.live(ev.n));
          }
          if (ev.t === 'settle') {
            const before = NODES.map((n) => oracle.liveGuess(n));
            for (const [other, ns] of guessed)
              if (
                other !== ev.b &&
                [...ns].some((n) => guessed.get(ev.b)!.has(n))
              )
                seen.bothOrders.add(
                  ev.b < other ? 'older-first' : 'newer-first',
                );
            guessed.set(ev.b, new Set());
            oracle.settle(ev.b, ev.k);
            if (!keepsWrites(ev.k) && before.some((g) => g !== undefined))
              seen.restoresUnder++;
          }
          if (ev.t === 'hold') held = true;
          if (ev.t === 'release') held = false;
        }
      }
      expect([...seen.bothOrders].sort()).toEqual([
        'newer-first',
        'older-first',
      ]);
      expect(seen.burials).toBeGreaterThan(500);
      expect(seen.heldGuesses).toBeGreaterThan(500);
      expect(seen.restoresUnder).toBeGreaterThan(200);
    });
  });

  describe('pins', () => {
    it('two overlapping guesses, newer body settles first: readers keep the older guess', () => {
      const t = [
        open(A),
        guess(A, '1'),
        open(B),
        guess(B, '2'),
        settle(B, 'fail'),
        settle(A, 'complete'),
      ];
      expect(shown(liveFrames(t, LIVE))).toEqual([
        'n0',
        '1',
        '1',
        '2',
        '1',
        'n0',
      ]);
    });

    it('two overlapping guesses, older body settles first: the newer guess stays, then truth, never the older guess', () => {
      const t = [
        open(A),
        guess(A, '1'),
        open(B),
        guess(B, '2'),
        settle(A, 'complete'),
        settle(B, 'fail'),
      ];
      expect(shown(liveFrames(t, LIVE))).toEqual([
        'n0',
        '1',
        '1',
        '2',
        '2',
        'n0',
      ]);
    });

    it('an older body guessing again under a newer open guess does not take the screen', () => {
      const t = [
        open(A),
        open(B),
        guess(B, '2'),
        guess(A, '3'),
        settle(B, 'fail'),
        settle(A, 'fail'),
      ];
      expect(shown(liveFrames(t, LIVE))).toEqual([
        'n0',
        'n0',
        '2',
        '2',
        '3',
        'n0',
      ]);
    });

    it('phantom row after a failed POST: the temporary row is gone, a refetch that landed mid-flight stays', () => {
      const plain = [open(A), guess(A, 'a,b,tmp'), settle(A, 'fail')];
      expect(shown(liveFrames(plain, LIVE))).toEqual(['n0', 'a,b,tmp', 'n0']);
      const refetched = [
        open(A),
        guess(A, 'a,b,tmp'),
        foreign('a,b,c'),
        settle(A, 'fail'),
      ];
      expect(shown(liveFrames(refetched, LIVE))).toEqual([
        'n0',
        'a,b,tmp',
        'a,b,c',
        'a,b,c',
      ]);
    });

    it('a user write between the reconcile and the revert wins, on completion and on abort', () => {
      for (const k of ['complete', 'abort'] as const) {
        const t = [
          open(A),
          guess(A, 'g'),
          write(A, 'server'),
          foreign('user'),
          settle(A, k),
        ];
        expect(shown(liveFrames(t, LIVE))).toEqual([
          'n0',
          'g',
          'server',
          'user',
          'user',
        ]);
      }
    });

    it('a user write before the reconcile: completion keeps the reconcile, abort restores the user value', () => {
      const t = (k: SettleKind) => [
        open(A),
        guess(A, 'g'),
        foreign('user'),
        write(A, 'server'),
        settle(A, k),
      ];
      expect(shown(liveFrames(t('complete'), LIVE)).at(-1)).toBe('server');
      expect(shown(liveFrames(t('abort'), LIVE)).at(-1)).toBe('user');
    });

    it('a reconcile from the newer body on the same node beats the older open guess (live tier only)', () => {
      const t = [
        open(A),
        guess(A, '1'),
        open(B),
        guess(B, '2'),
        write(B, 'truthB'),
        settle(B, 'complete'),
        settle(A, 'complete'),
      ];
      expect(shown(liveFrames(t, LIVE))).toEqual([
        'n0',
        '1',
        '1',
        '2',
        'truthB',
        'truthB',
        'truthB',
      ]);
    });

    it('a second writer over a guessed node records the truth beneath, and its abort restores that truth under the guess', () => {
      const m = new LiveMachine(['n'], LIVE);
      m.open(A);
      m.guess(A, 'n', 'g');
      m.open(B);
      m.foreign('n', 't1'); // buries the guess
      m.guess(A, 'n', 'g2');
      m.write(B, 'n', 'w'); // buries again; B recorded t1, not g2
      expect(m.audit.map((c) => c.value)).toEqual(['t1']);
      m.guess(A, 'n', 'g3');
      m.settle(B, 'abort'); // restores t1 beneath g3
      expect(m.display('n')).toBe('g3');
      m.settle(A, 'fail');
      expect(m.display('n')).toBe('t1');
    });

    it('held readers see the guess through the bypass, and a frozen frame never shows a reverted guess', () => {
      const t: Ev[] = [
        open(A),
        guess(A, 'g'),
        { t: 'hold' },
        foreign('t1'),
        guess(A, 'g2'),
        settle(A, 'fail'),
        { t: 'release' },
      ];
      expect(liveFrames(t, LIVE)).toEqual([
        'n0/n0',
        'g/g',
        'g/g',
        't1/n0',
        'g2/g2',
        't1/n0',
        't1/t1',
      ]);
    });
  });
});

describe('optimistic model, live tier, killed alternatives', () => {
  const twoBodies = { bodies: 3, steps: 30, writes: true };

  it('blind snapshots: each guess restores the value it covered; the older-first order resurrects the older guess', () => {
    const blind = { ...LIVE, history: false };
    const newerFirst = [
      open(A),
      guess(A, '1'),
      open(B),
      guess(B, '2'),
      settle(B, 'fail'),
      settle(A, 'fail'),
    ];
    expect(shown(liveFrames(newerFirst, blind))).toEqual([
      'n0',
      '1',
      '1',
      '2',
      '1',
      'n0',
    ]);
    const olderFirst = [
      open(A),
      guess(A, '1'),
      open(B),
      guess(B, '2'),
      settle(A, 'complete'),
      settle(B, 'fail'),
    ];
    expect(shown(liveFrames(olderFirst, blind)).at(-1)).toBe('1');
    expect(findCounterexample('no-leak', blind, twoBodies)).toBeGreaterThan(0);
  });

  it('write-then-rollback: a completed body keeps its guess over an older open guess, and leaves it behind', () => {
    const wtr = { ...LIVE, wtr: true };
    const t = [
      open(A),
      guess(A, '1'),
      open(B),
      guess(B, '2'),
      foreign('rows', 'm'),
      settle(B, 'complete'),
      settle(A, 'complete'),
    ];
    const frames = liveFrames(t, wtr, ['n', 'm']).map(
      (f) => f.split(' ')[0].split('/')[0],
    );
    expect(frames.slice(-2)).toEqual(['2', '2']); // the oracle wants 1, then n0
    expect(shown(liveFrames(t, LIVE, ['n', 'm'])).slice(-2)).toEqual(
      ['1/1 rows', 'n0/n0 rows'].map((f) => f.split('/')[0]),
    );
    for (const prop of ['visibility', 'no-leak', 'guess-in-undo-log'])
      expect(findCounterexample(prop, wtr, twoBodies)).toBeGreaterThan(0);
  });

  it('one entry for the guess and the reconcile: completion reverts the reconcile with the guess', () => {
    const shared = { ...LIVE, sharedGen: true };
    const t = [
      open(A),
      guess(A, 'g'),
      write(A, 'server'),
      settle(A, 'complete'),
    ];
    expect(shown(liveFrames(t, shared)).at(-1)).toBe('n0');
    expect(shown(liveFrames(t, LIVE)).at(-1)).toBe('server');
    expect(findCounterexample('no-leak', shared, twoBodies)).toBeGreaterThan(0);
  });

  it('undo logs that record the displayed value: an aborted second writer restores a guess as truth', () => {
    const displayed = { ...LIVE, recordDisplayed: true };
    const t = [
      open(A),
      guess(A, 'g'),
      open(B),
      write(B, 'w'),
      settle(A, 'fail'),
      settle(B, 'abort'),
    ];
    expect(shown(liveFrames(t, displayed)).at(-1)).toBe('g');
    expect(shown(liveFrames(t, LIVE)).at(-1)).toBe('n0');
    expect(
      findCounterexample('guess-in-undo-log', displayed, twoBodies),
    ).toBeGreaterThan(0);
    expect(findCounterexample('phantom', displayed, twoBodies)).toBeGreaterThan(
      0,
    );
  });

  it('value comparison instead of stamps: a server confirming the guess is reverted (only with equal values)', () => {
    const byValue = { ...LIVE, detect: 'objectIs' as const };
    const t = [open(A), guess(A, 'on'), foreign(null), settle(A, 'complete')];
    expect(shown(liveFrames(t, byValue)).at(-1)).toBe('n0');
    expect(shown(liveFrames(t, LIVE)).at(-1)).toBe('on');
    expect(
      findCounterexample('no-leak', byValue, { ...twoBodies, collide: true }),
    ).toBeGreaterThan(0);
    for (let seed = 1; seed <= ALT_SEEDS; seed++)
      expect(
        runLive(genTrace(seed, { nodes: NODES, ...twoBodies }), NODES, byValue),
      ).toEqual([]);
  });

  it('no hold bypass: a held reader freezes the pre-guess value', () => {
    const none = { ...LIVE, bypass: 'none' as const };
    const t: Ev[] = [open(A), { t: 'hold' }, guess(A, 'g')];
    expect(liveFrames(t, none).at(-1)).toBe('g/n0');
    expect(liveFrames(t, LIVE).at(-1)).toBe('g/g');
    expect(
      findCounterexample('held-visibility', none, {
        ...twoBodies,
        holds: true,
      }),
    ).toBeGreaterThan(0);
  });

  it('a bypass for reads only: a hold opened over a guess keeps showing it after it reverted', () => {
    const reads = { ...LIVE, bypass: 'reads' as const };
    const t: Ev[] = [open(A), guess(A, 'g'), { t: 'hold' }, settle(A, 'fail')];
    expect(liveFrames(t, reads).at(-1)).toBe('n0/g');
    expect(liveFrames(t, LIVE).at(-1)).toBe('n0/n0');
    expect(
      findCounterexample('held-visibility', reads, {
        ...twoBodies,
        holds: true,
      }),
    ).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Overlay tier mechanism. The base is a nested record; every body owns a fork that re-links to a
// moving base with the real `merge3` (the forkStore reconcile, `linkedSignal` style: on read, if the
// base changed since the last read, merge(lastBase, forkValue, base)). The facade folds the open
// forks over the base in open order, later bodies winning a shared leaf.
// ────────────────────────────────────────────────────────────────────────────
type Rec = { readonly [k: string]: Rec | string };
const getPath = (r: Rec, p: string): string =>
  p.split('.').reduce<Rec | string>((o, k) => (o as Rec)[k], r) as string;
const setPath = (r: Rec, [k, ...rest]: readonly string[], v: string): Rec => ({
  ...r,
  [k]: rest.length ? setPath(r[k] as Rec, rest, v) : v,
});
const PATHS = ['a.x', 'a.y', 'b.x'] as const;
const initialRecord = (): Rec => ({
  a: { x: 'a.x0', y: 'a.y0' },
  b: { x: 'b.x0' },
});

type OverlayOpts = {
  /** Which forks the facade reads: all open forks folded, or only the newest one. */
  readonly fold: 'all' | 'newest';
  /** What completion does with the fork: discard it, or commit it onto the base. */
  readonly onComplete: 'discard' | 'commit';
};
const OVERLAY: OverlayOpts = { fold: 'all', onComplete: 'discard' };

class OverlayMachine {
  base: Rec = initialRecord();
  private readonly ids = new Map<string, number>();
  private readonly forks = new Map<number, { ancestor: Rec; value: Rec }>();
  private readonly openOrder: number[] = [];
  private readonly logs = new Map<
    number,
    { p: string; pre: { v: string; id: number }; last: number }[]
  >();
  private id = 0;
  /** Base writes made by settling a body's guesses. The discard property requires zero. */
  baseWritesFromForks = 0;
  readonly audit: string[] = [];

  constructor(private readonly o: OverlayOpts) {
    for (const p of PATHS) this.ids.set(p, ++this.id);
  }

  facade(p: string): string {
    const bodies =
      this.o.fold === 'all' ? this.openOrder : this.openOrder.slice(-1);
    let v = this.base;
    for (const b of bodies) v = merge3(this.base, this.fork(b), v);
    return getPath(v, p);
  }
  baseRead(p: string): string {
    return getPath(this.base, p);
  }
  /** The fork's current value, re-linked to the base the way forkStore's linkedSignal does. */
  fork(b: number): Rec {
    const f = this.forks.get(b)!;
    if (f.ancestor !== this.base) {
      f.value = merge3(f.ancestor, f.value, this.base);
      f.ancestor = this.base;
    }
    return f.value;
  }

  open(b: number) {
    this.forks.set(b, { ancestor: this.base, value: this.base });
    this.openOrder.push(b);
    this.logs.set(b, []);
  }
  guess(b: number, p: string, v: string) {
    const f = this.forks.get(b)!;
    f.value = setPath(this.fork(b), p.split('.'), v);
  }
  write(b: number, p: string, v: string) {
    const pre = { v: this.baseRead(p), id: this.ids.get(p)! };
    this.audit.push(pre.v);
    const e = { p, pre, last: 0 };
    this.logs.get(b)!.push(e);
    e.last = this.setBase(p, v, ++this.id);
  }
  foreign(p: string, v: string) {
    this.setBase(p, v, ++this.id);
  }
  settle(b: number, k: SettleKind) {
    if (!keepsWrites(k))
      for (const e of [...this.logs.get(b)!].reverse())
        if (this.ids.get(e.p) === e.last) this.setBase(e.p, e.pre.v, e.pre.id);
    if (k === 'complete' && this.o.onComplete === 'commit') {
      const staged = this.fork(b);
      for (const p of PATHS)
        if (getPath(staged, p) !== this.baseRead(p)) {
          this.baseWritesFromForks++;
          this.ids.set(p, ++this.id);
        }
      this.base = staged;
    }
    this.forks.delete(b);
    this.openOrder.splice(this.openOrder.indexOf(b), 1);
  }

  private setBase(p: string, v: string, id: number) {
    this.base = setPath(this.base, p.split('.'), v);
    this.ids.set(p, id);
    return id;
  }
}

function stepOverlay(ev: Ev, oracle: Oracle, m: OverlayMachine) {
  switch (ev.t) {
    case 'open':
      oracle.open(ev.b);
      m.open(ev.b);
      break;
    case 'guess':
      oracle.guess(ev.b, ev.n, ev.v);
      m.guess(ev.b, ev.n, ev.v);
      break;
    case 'write':
      oracle.write(ev.b, ev.n, ev.v);
      m.write(ev.b, ev.n, ev.v);
      break;
    case 'foreign': {
      const v = ev.v ?? oracle.overlay(ev.n);
      oracle.foreign(ev.n, v);
      m.foreign(ev.n, v);
      break;
    }
    case 'settle':
      oracle.settle(ev.b, ev.k);
      m.settle(ev.b, ev.k);
      break;
  }
}

/**
 * Checks after every event: facade visibility, base readers see exactly truth, no phantom, no base
 * write from settling a fork, no guess in an undo log; and no leak at the end.
 */
function runOverlay(trace: readonly Ev[], o: OverlayOpts): Violation[] {
  const oracle = new Oracle(PATHS);
  const m = new OverlayMachine(o);
  const out: Violation[] = [];
  const flag = (prop: string, step: number, detail: string) => {
    if (!out.some((v) => v.prop === prop)) out.push({ prop, step, detail });
  };
  trace.forEach((ev, step) => {
    stepOverlay(ev, oracle, m);
    const phantoms = oracle.settledGuessValues();
    for (const p of PATHS) {
      const got = m.facade(p);
      if (got !== oracle.overlay(p))
        flag('visibility', step, `${p}: ${got} != ${oracle.overlay(p)}`);
      if (m.baseRead(p) !== oracle.truth(p))
        flag(
          'base-readers',
          step,
          `${p}: ${m.baseRead(p)} != ${oracle.truth(p)}`,
        );
      if (phantoms.has(got) || phantoms.has(m.baseRead(p)))
        flag('phantom', step, `${p}: ${got}`);
    }
    if (m.baseWritesFromForks)
      flag('settle-writes-base', step, `${m.baseWritesFromForks} writes`);
    if (m.audit.some((v) => v.startsWith('g')))
      flag('guess-in-undo-log', step, m.audit.join(','));
  });
  for (const p of PATHS)
    if (m.facade(p) !== oracle.truth(p) || m.baseRead(p) !== oracle.truth(p))
      flag(
        'no-leak',
        trace.length,
        `${p}: ${m.facade(p)} / ${m.baseRead(p)} != ${oracle.truth(p)}`,
      );
  return out;
}

function overlayFrames(trace: readonly Ev[], o: OverlayOpts, p = 'a.x') {
  const oracle = new Oracle(PATHS);
  const m = new OverlayMachine(o);
  return trace.map((ev) => {
    stepOverlay(ev, oracle, m);
    return `${m.facade(p)}|${m.baseRead(p)}`;
  });
}
const facadeOnly = (frames: readonly string[]) =>
  frames.map((f) => f.split('|')[0]);

describe('optimistic model, overlay tier', () => {
  const gen = (seed: number, writes: boolean) =>
    genTrace(seed, { nodes: PATHS, bodies: 3, steps: 30, writes });

  it('every property holds over generated interleavings', () => {
    for (const writes of [false, true])
      for (let seed = 1; seed <= SEEDS; seed++) {
        const vs = runOverlay(gen(seed, writes), OVERLAY);
        if (vs.length) throw new Error(`seed ${seed}: ${JSON.stringify(vs)}`);
      }
  });

  it('the generator moves the base under open forks, on guessed and untouched paths', () => {
    let guessedMoved = 0;
    let untouchedMoved = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const guessed = new Set<string>();
      let opened = 0;
      for (const ev of gen(seed, true)) {
        if (ev.t === 'open') opened++;
        if (ev.t === 'guess') guessed.add(ev.n);
        if ((ev.t === 'foreign' || ev.t === 'write') && opened) {
          if (guessed.has(ev.n)) guessedMoved++;
          else if (guessed.size) untouchedMoved++;
        }
      }
    }
    expect(guessedMoved).toBeGreaterThan(1000);
    expect(untouchedMoved).toBeGreaterThan(1000);
  });

  describe('pins', () => {
    const g = (b: number, v: string, n = 'a.x') => guess(b, v, n);
    it('two overlapping guesses, newer body settles first: the facade keeps the older guess', () => {
      const t = [
        open(A),
        g(A, '1'),
        open(B),
        g(B, '2'),
        settle(B, 'fail'),
        settle(A, 'complete'),
      ];
      expect(overlayFrames(t, OVERLAY)).toEqual([
        'a.x0|a.x0',
        '1|a.x0',
        '1|a.x0',
        '2|a.x0',
        '1|a.x0',
        'a.x0|a.x0',
      ]);
    });

    it('two overlapping guesses, older body settles first: the newer guess stays, then truth', () => {
      const t = [
        open(A),
        g(A, '1'),
        open(B),
        g(B, '2'),
        settle(A, 'complete'),
        settle(B, 'fail'),
      ];
      expect(facadeOnly(overlayFrames(t, OVERLAY))).toEqual([
        'a.x0',
        '1',
        '1',
        '2',
        '2',
        'a.x0',
      ]);
    });

    it('a reconcile from the newer body on the same path stays under the older open guess (overlay tier only)', () => {
      const t = [
        open(A),
        g(A, '1'),
        open(B),
        g(B, '2'),
        write(B, 'truthB', 'a.x'),
        settle(B, 'complete'),
        settle(A, 'complete'),
      ];
      expect(overlayFrames(t, OVERLAY).slice(-3)).toEqual([
        '2|truthB',
        '1|truthB',
        'truthB|truthB',
      ]);
    });

    it('phantom row after a failed POST: base readers never saw it, the facade drops it', () => {
      const t = [open(A), g(A, 'a,b,tmp'), settle(A, 'fail')];
      expect(overlayFrames(t, OVERLAY)).toEqual([
        'a.x0|a.x0',
        'a,b,tmp|a.x0',
        'a.x0|a.x0',
      ]);
    });

    it('base moved on an untouched path: the facade shows the move at once and keeps the guess', () => {
      const oracle = new Oracle(PATHS);
      const m = new OverlayMachine(OVERLAY);
      for (const ev of [open(A), g(A, 'tmp'), foreign('t1', 'a.y')])
        stepOverlay(ev, oracle, m);
      expect([m.facade('a.x'), m.facade('a.y'), m.baseRead('a.x')]).toEqual([
        'tmp',
        't1',
        'a.x0',
      ]);
      stepOverlay(settle(A, 'complete'), oracle, m);
      expect([m.facade('a.x'), m.facade('a.y')]).toEqual(['a.x0', 't1']);
      expect(m.baseWritesFromForks).toBe(0);
    });

    it('base moved on a guessed path: the guess shadows the move until settlement, then the move shows', () => {
      const t = [
        open(A),
        g(A, 'a,b,tmp'),
        foreign('a,b,c', 'a.x'),
        settle(A, 'complete'),
      ];
      expect(overlayFrames(t, OVERLAY)).toEqual([
        'a.x0|a.x0',
        'a,b,tmp|a.x0',
        'a,b,tmp|a,b,c',
        'a,b,c|a,b,c',
      ]);
    });

    it('a guess equal to the value it covers is no edit: a later base move on that path shows through', () => {
      const t = [open(A), g(A, 'a.x0'), foreign('t1', 'a.x')];
      expect(overlayFrames(t, OVERLAY).at(-1)).toBe('t1|t1');
    });

    it('a user write between the reconcile and the discard wins, on completion and on abort', () => {
      for (const k of ['complete', 'abort'] as const) {
        const t = [
          open(A),
          g(A, 'g'),
          write(A, 'server', 'a.x'),
          foreign('user', 'a.x'),
          settle(A, k),
        ];
        expect(overlayFrames(t, OVERLAY).at(-1)).toBe('user|user');
      }
    });
  });

  describe('killed alternatives', () => {
    const t = [open(A), guess(A, 'g1', 'a.x'), settle(A, 'complete')];
    it('commit the fork on completion (lane fusion): settling writes the guess into the base', () => {
      const commit = { ...OVERLAY, onComplete: 'commit' as const };
      expect(overlayFrames(t, commit).at(-1)).toBe('g1|g1');
      const found = (prop: string) => {
        for (let seed = 1; seed <= ALT_SEEDS; seed++)
          if (props(runOverlay(gen(seed, true), commit)).includes(prop))
            return seed;
        return -1;
      };
      for (const prop of ['settle-writes-base', 'no-leak', 'phantom'])
        expect(found(prop)).toBeGreaterThan(0);
    });

    it('a facade over the newest fork only hides an older open guess on another path', () => {
      const newest = { ...OVERLAY, fold: 'newest' as const };
      const two = [
        open(A),
        guess(A, 'g1', 'a.x'),
        open(B),
        guess(B, 'g2', 'a.y'),
      ];
      expect(overlayFrames(two, newest, 'a.x').at(-1)).toBe('a.x0|a.x0');
      expect(overlayFrames(two, OVERLAY, 'a.x').at(-1)).toBe('g1|a.x0');
      let seedFound = -1;
      for (let seed = 1; seed <= ALT_SEEDS && seedFound < 0; seed++)
        if (props(runOverlay(gen(seed, false), newest)).includes('visibility'))
          seedFound = seed;
      expect(seedFound).toBeGreaterThan(0);
    });
  });
});

describe('optimistic model, overlay tier against the real forkStore', () => {
  type Leaf = { (): unknown; set(v: unknown): void };
  const leaf = (s: unknown, p: string) =>
    p
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], s) as Leaf;

  it('real forks reconcile like the model and discard never writes the base', () => {
    let discards = 0;
    for (let seed = 1; seed <= 400; seed++) {
      TestBed.runInInjectionContext(() => {
        const base = store(initialRecord() as Record<string, any>);
        const oracle = new Oracle(PATHS);
        const m = new OverlayMachine(OVERLAY);
        const forks = new Map<
          number,
          ReturnType<typeof forkStore<Record<string, any>>>
        >();
        for (const ev of genTrace(seed, {
          nodes: PATHS,
          bodies: 3,
          steps: 30,
          writes: true,
        })) {
          stepOverlay(ev, oracle, m);
          if (ev.t === 'open') forks.set(ev.b, forkStore(base));
          if (ev.t === 'guess') leaf(forks.get(ev.b)!.store, ev.n).set(ev.v);
          if (ev.t === 'settle') {
            const before = base();
            forks.get(ev.b)!.discard();
            forks.delete(ev.b);
            discards++;
            expect(base()).toBe(before);
          }
          for (const p of PATHS)
            if (leaf(base, p)() !== m.baseRead(p))
              leaf(base, p).set(m.baseRead(p));
          expect(base()).toEqual(m.base);
          let facade: Rec = base() as Rec;
          for (const [b, f] of forks) {
            const real = f.store() as Rec;
            expect(real).toEqual(m.fork(b));
            facade = merge3(base() as Rec, real, facade);
          }
          for (const p of PATHS) expect(getPath(facade, p)).toBe(m.facade(p));
        }
      });
    }
    expect(discards).toBeGreaterThan(1000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Live tier, re-pointed: the same traces against the real guessable, transactions and hold().
// A body is a `createTransaction`; its write is a slice that sets the guessable; a foreign write
// sets it outside any transaction; a hold is the scope's `beginHold`/`endHold`. Every reader is
// read after every event, the way a render would.
// ────────────────────────────────────────────────────────────────────────────
class RealLive {
  readonly scope: TransitionScope;
  readonly nodes = new Map<string, Guessable<string>>();
  readonly inner = new Map<string, ReturnType<typeof signal<string>>>();
  readonly held = new Map<string, () => string>();
  readonly txns = new Map<number, Transaction>();
  /** Every transaction ever opened, for the ledger checks. */
  readonly all: Transaction[] = [];

  constructor(nodes: readonly string[]) {
    this.scope = TestBed.runInInjectionContext(() =>
      createTransitionScope({ injector: TestBed.inject(Injector) }),
    );
    for (const n of nodes) {
      const sig = signal(`${n}0`);
      const g = guessable(sig);
      this.inner.set(n, sig);
      this.nodes.set(n, g);
      this.held.set(n, this.scope.hold(g));
    }
  }
  node(n: string) {
    return this.nodes.get(n) as Guessable<string>;
  }
  display(n: string) {
    return this.node(n)();
  }
  heldRead(n: string) {
    return (this.held.get(n) as () => string)();
  }
  truth(n: string) {
    return untracked(this.inner.get(n) as () => string);
  }
  step(ev: Ev, foreignValue?: string) {
    switch (ev.t) {
      case 'open': {
        const t = createTransaction();
        this.txns.set(ev.b, t);
        this.all.push(t);
        break;
      }
      case 'guess':
        this.tx(ev.b).guess(this.node(ev.n), ev.v);
        break;
      case 'write':
        this.tx(ev.b).enter(() => this.node(ev.n).set(ev.v));
        break;
      case 'foreign':
        this.node(ev.n).set(foreignValue ?? ev.v ?? this.display(ev.n));
        break;
      case 'settle':
        if (keepsWrites(ev.k)) this.tx(ev.b).clear();
        else this.tx(ev.b).restore();
        break;
      case 'hold':
        this.scope.beginHold();
        break;
      case 'release':
        this.scope.endHold();
        break;
    }
  }
  private tx(b: number) {
    return this.txns.get(b) as Transaction;
  }
}

/**
 * Lockstep: the oracle, the model machine and the real objects take every event; after each one
 * the real display, held reads and truth must equal the model's, and the ledger may hold a guess
 * only as a `'guess'` entry that never targets the recorded truth.
 */
function runRealLive(trace: readonly Ev[], nodes: readonly string[]) {
  const oracle = new Oracle(nodes);
  const m = new LiveMachine(nodes, LIVE);
  const real = new RealLive(nodes);
  const out: Violation[] = [];
  const flag = (prop: string, step: number, detail: string) => {
    if (!out.some((v) => v.prop === prop)) out.push({ prop, step, detail });
  };
  const guesses = new Set<string>();
  const confirmed = new Set<string>();
  let frozenTruth: Map<string, string> | null = null;
  trace.forEach((ev, step) => {
    let fv: string | undefined;
    if (ev.t === 'foreign' && ev.v === null) {
      fv = oracle.live(ev.n);
      confirmed.add(fv);
    }
    if (ev.t === 'guess') guesses.add(ev.v);
    if (ev.t === 'hold')
      frozenTruth = new Map(nodes.map((n) => [n, oracle.truth(n)]));
    if (ev.t === 'release') frozenTruth = null;
    switch (ev.t) {
      case 'open':
        oracle.open(ev.b);
        m.open(ev.b);
        break;
      case 'guess':
        oracle.guess(ev.b, ev.n, ev.v);
        m.guess(ev.b, ev.n, ev.v);
        break;
      case 'write':
        oracle.write(ev.b, ev.n, ev.v);
        m.write(ev.b, ev.n, ev.v);
        break;
      case 'foreign':
        oracle.foreign(ev.n, fv ?? (ev.v as string));
        m.foreign(ev.n, fv ?? (ev.v as string));
        break;
      case 'settle':
        oracle.settle(ev.b, ev.k);
        m.settle(ev.b, ev.k);
        break;
      case 'hold':
        m.hold();
        break;
      case 'release':
        m.release();
        break;
    }
    real.step(ev, fv);
    for (const n of nodes) {
      const got = real.display(n);
      if (got !== oracle.live(n))
        flag('visibility', step, `${n}: ${got} != ${oracle.live(n)}`);
      if (got !== m.display(n))
        flag('model-agreement', step, `${n}: ${got} != ${m.display(n)}`);
      const held = real.heldRead(n);
      const wantHeld = frozenTruth
        ? (oracle.liveGuess(n) ?? (frozenTruth as Map<string, string>).get(n))
        : oracle.live(n);
      if (held !== wantHeld)
        flag('held-visibility', step, `${n}: ${held} != ${wantHeld}`);
      if (real.truth(n) !== oracle.truth(n))
        flag('truth', step, `${n}: ${real.truth(n)} != ${oracle.truth(n)}`);
      const t = real.truth(n);
      if (guesses.has(t) && !confirmed.has(t))
        flag('guess-in-truth', step, `${n}: ${t}`);
      const port = recordTargetOf(real.node(n));
      for (const txn of real.all)
        for (const e of txn.entries())
          if (e.target === port && e.kind !== 'authoritative')
            flag('guess-in-undo-log', step, `${n}: ${e.kind} on the truth`);
    }
  });
  for (const n of nodes)
    if (real.display(n) !== oracle.truth(n))
      flag('no-leak', trace.length, `${n}: ${real.display(n)}`);
  return out;
}

const REAL_SEEDS = 1500;

describe('optimistic live tier: the real guessable in lockstep with the model', () => {
  const shapes: [string, Omit<GenOpts, 'nodes'>][] = [
    ['guesses and foreign writes', { bodies: 3, steps: 24 }],
    [
      'plus write-through reconciles and holds',
      { bodies: 3, steps: 30, writes: true, holds: true },
    ],
    [
      'plus foreign writes that confirm a guess, and holds',
      { bodies: 3, steps: 30, writes: true, collide: true, holds: true },
    ],
  ];
  for (const [name, gen] of shapes)
    it(`every property holds: ${name}`, () => {
      for (let seed = 1; seed <= REAL_SEEDS; seed++) {
        const vs = runRealLive(genTrace(seed, { nodes: NODES, ...gen }), NODES);
        if (vs.length) throw new Error(`seed ${seed}: ${JSON.stringify(vs)}`);
      }
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Overlay tier, re-pointed: the same traces against the real optimisticStore. A body is a
// `createTransaction`; its guess goes into `tx.overlay(opt)`; its write is a slice that sets the
// base store (whose root records itself); a foreign write sets the base outside any transaction.
// ────────────────────────────────────────────────────────────────────────────
type Leaf = { (): unknown; set(v: unknown): void };
const leafOf = (s: unknown, p: string) =>
  p
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], s) as Leaf;

function runRealOverlay(trace: readonly Ev[]): Violation[] {
  return TestBed.runInInjectionContext(() => {
    const oracle = new Oracle(PATHS);
    const m = new OverlayMachine(OVERLAY);
    const base = store(initialRecord() as Record<string, any>);
    const opt = optimisticStore(base);
    const txns = new Map<number, Transaction>();
    const writeSlices = new Map<Transaction, number>();
    const out: Violation[] = [];
    const flag = (prop: string, step: number, detail: string) => {
      if (!out.some((v) => v.prop === prop)) out.push({ prop, step, detail });
    };
    trace.forEach((ev, step) => {
      stepOverlay(ev, oracle, m);
      switch (ev.t) {
        case 'open': {
          const t = createTransaction();
          txns.set(ev.b, t);
          writeSlices.set(t, 0);
          break;
        }
        case 'guess': {
          const t = txns.get(ev.b)!;
          // inside the body's slice, where an author writes it
          t.enter(() => leafOf(t.overlay(opt), ev.n).set(ev.v));
          break;
        }
        case 'write': {
          const t = txns.get(ev.b)!;
          t.enter(() => leafOf(base, ev.n).set(ev.v));
          writeSlices.set(t, writeSlices.get(t)! + 1);
          break;
        }
        case 'foreign':
          leafOf(base, ev.n).set(ev.v ?? oracle.overlay(ev.n));
          break;
        case 'settle': {
          const t = txns.get(ev.b)!;
          if (keepsWrites(ev.k)) {
            const before = base();
            t.clear();
            if (base() !== before)
              flag('settle-writes-base', step, 'completion changed the base');
          } else t.restore();
          break;
        }
      }
      for (const p of PATHS) {
        const got = leafOf(opt.store, p)();
        if (got !== oracle.overlay(p))
          flag('visibility', step, `${p}: ${got} != ${oracle.overlay(p)}`);
        if (got !== m.facade(p))
          flag('model-agreement', step, `${p}: ${got} != ${m.facade(p)}`);
        if (leafOf(base, p)() !== oracle.truth(p))
          flag('base-readers', step, `${p}: ${leafOf(base, p)()}`);
      }
      for (const [t, n] of writeSlices)
        if (!t.closed && t.entries().length !== n)
          flag('guess-in-undo-log', step, `${t.entries().length} != ${n}`);
    });
    for (const p of PATHS)
      if (leafOf(opt.store, p)() !== oracle.truth(p))
        flag('no-leak', trace.length, `${p}: ${leafOf(opt.store, p)()}`);
    return out;
  });
}

describe('optimistic overlay tier: the real optimisticStore in lockstep with the model', () => {
  it('every property holds over generated interleavings, with and without write-through reconciles', () => {
    for (const writes of [false, true])
      for (let seed = 1; seed <= REAL_SEEDS; seed++) {
        const vs = runRealOverlay(
          genTrace(seed, { nodes: PATHS, bodies: 3, steps: 30, writes }),
        );
        if (vs.length) throw new Error(`seed ${seed}: ${JSON.stringify(vs)}`);
      }
  });
});
