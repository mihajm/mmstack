import { signal, type WritableSignal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { createRevealCoordinator, type RevealSlot } from './reveal';

/**
 * Reveal ordering, pure reference model + properties. No Angular, no boundary: slots carry a
 * readiness value and, when their boundary has a host element, a document position. The model folds
 * a sequence of changes into a latched released set plus the order it used. The coordinator in
 * `reveal.ts` is checked against this model at the bottom.
 *
 * Terms: a slot is mounted once its boundary has completed its first change-detection pass; before
 * that its reported state is noise (inputs unbound, content not yet registered) and the slot counts
 * as pending. The effective state is the reported state once mounted, else pending; every read of a
 * slot goes through it. A slot is settled-now when its effective state is ready, or failed under
 * `onError: 'settled'`.
 *
 * Order: when no slot has a host the order is registration order. Otherwise the participants are the
 * slots whose host is in the document, in document order (two slots on one host by registration);
 * a slot without a host, or whose host is not in the document, neither blocks nor is released, and
 * is gated. Two participants in different trees (a shadow root) cannot be ordered: that fold holds,
 * keeping the previous released set and order. A participant is released once it is settled-now and
 * every participant before it in order is released (`forwards` / `backwards`), or once every
 * participant is released or settled-now (`together`). Released stays released, also across a
 * detach. A gated slot is unreleased and held: it shows its placeholder, or nothing when collapsed.
 */

type Order = 'forwards' | 'backwards' | 'together';
type OnError = 'settled' | 'blocks';
type R = 'pending' | 'ready' | 'failed';
type Slot = {
  readonly id: number;
  readonly r: R;
  readonly m: boolean;
  /** Document position of the slot's host; absent when the slot has no host. Equal = same host. */
  readonly pos?: number;
  /** The host is in the document (a live read, not an observation). */
  readonly conn?: boolean;
  /** The tree the host lives in: 0 the document, 1+ a shadow root. */
  readonly tree?: number;
};
type Fold = {
  readonly released: ReadonlySet<number>;
  /** The participants, in the order the fold used. */
  readonly ordered: readonly number[];
  /** Two participants could not be ordered: the fold kept the previous one, and every unreleased slot is gated. */
  readonly held: boolean;
};
type State = { readonly slots: readonly Slot[] } & Fold;
type Cfg = { readonly order: Order; readonly onError: OnError };
type Placement = {
  readonly pos?: number;
  readonly conn?: boolean;
  readonly tree?: number;
};
type Ev =
  | { readonly t: 'set'; readonly id: number; readonly r: R }
  | ({
      readonly t: 'add';
      readonly id: number;
      readonly r: R;
      readonly m?: boolean;
    } & Placement)
  | { readonly t: 'mount'; readonly id: number; readonly r: R }
  | { readonly t: 'remove'; readonly id: number }
  | { readonly t: 'connect'; readonly id: number }
  | { readonly t: 'disconnect'; readonly id: number }
  | { readonly t: 'move'; readonly id: number; readonly pos: number };
type Display = 'content' | 'placeholder' | 'error' | 'gated';
type Release = (slots: readonly Slot[], prev: Fold, cfg: Cfg) => Fold;
type Init = {
  readonly id?: number;
  readonly r: R;
  readonly m: boolean;
} & Placement;

const EMPTY: Fold = { released: new Set(), ordered: [], held: false };

const effective = (s: Slot): R => (s.m ? s.r : 'pending');

const settledNow = (r: R, onError: OnError) =>
  r === 'ready' || (onError === 'settled' && r === 'failed');

const inOrder = (slots: readonly Slot[], order: Order) =>
  order === 'backwards' ? [...slots].reverse() : [...slots];

const hasHost = (s: Slot) => s.pos !== undefined;

/**
 * How a fold picks and orders the slots that take part. `doc` is the rule; the others are the
 * alternatives the design rejected, kept here to be shown wrong.
 */
type OrderRule = 'doc' | 'registration' | 'fallback' | 'holdAll' | 'last';

function participants(
  slots: readonly Slot[],
  rule: OrderRule = 'doc',
): { list: Slot[]; hold: boolean } {
  if (!slots.some(hasHost)) return { list: [...slots], hold: false };
  const placed = slots.filter((s) => hasHost(s) && s.conn);
  const out = slots.filter((s) => !(hasHost(s) && s.conn));
  if (rule === 'fallback' && out.length)
    return { list: [...slots], hold: false };
  if (rule === 'holdAll' && out.length) return { list: placed, hold: true };
  const tree = placed[0]?.tree ?? 0;
  if (placed.some((s) => (s.tree ?? 0) !== tree))
    return { list: placed, hold: true };
  const sorted =
    rule === 'registration'
      ? placed
      : [...placed].sort((a, b) => (a.pos as number) - (b.pos as number)); // stable: ties by registration
  return { list: rule === 'last' ? [...sorted, ...out] : sorted, hold: false };
}

const makeRelease =
  (rule: OrderRule = 'doc'): Release =>
  (slots, prev, { order, onError }) => {
    const live = new Set(slots.map((s) => s.id));
    const out = new Set([...prev.released].filter((id) => live.has(id)));
    const { list, hold } = participants(slots, rule);
    if (hold)
      return {
        released: out,
        ordered: prev.ordered.filter((id) => live.has(id)),
        held: true,
      };
    if (order === 'together') {
      if (list.every((s) => out.has(s.id) || settledNow(effective(s), onError)))
        for (const s of list) out.add(s.id);
    } else
      for (const s of inOrder(list, order)) {
        if (out.has(s.id)) continue;
        if (!settledNow(effective(s), onError)) break;
        out.add(s.id);
      }
    return { released: out, ordered: list.map((s) => s.id), held: false };
  };
const release = makeRelease();

const slotOf = (st: State, id: number) =>
  st.slots.find((s) => s.id === id) as Slot;
const orderedSlots = (st: State) => st.ordered.map((id) => slotOf(st, id));

function gated(st: State, id: number, cfg: Cfg): boolean {
  if (st.released.has(id)) return false;
  if (st.held || !st.ordered.includes(id)) return true;
  const self = slotOf(st, id);
  if (cfg.order === 'together') return settledNow(effective(self), cfg.onError);
  const seq = inOrder(orderedSlots(st), cfg.order);
  return seq.slice(0, seq.indexOf(self)).some((s) => !st.released.has(s.id));
}

/** A mounted slot's display. Before mount a slot's own view is rendering for the first time: not an observable. */
function display(st: State, id: number, cfg: Cfg): Display {
  if (gated(st, id, cfg)) return 'gated';
  const r = slotOf(st, id).r;
  return r === 'ready' ? 'content' : r === 'failed' ? 'error' : 'placeholder';
}

function apply(st: State, ev: Ev, cfg: Cfg, rel: Release = release): State {
  let slots = st.slots;
  if (ev.t === 'add') {
    slots = [
      ...slots,
      {
        id: ev.id,
        r: ev.r,
        m: ev.m ?? false,
        pos: ev.pos,
        conn: ev.conn,
        tree: ev.tree,
      },
    ];
  } else if (ev.t === 'remove') slots = slots.filter((s) => s.id !== ev.id);
  else
    slots = slots.map((s) => {
      if (s.id !== ev.id) return s;
      if (ev.t === 'connect') return { ...s, conn: true };
      if (ev.t === 'disconnect') return { ...s, conn: false };
      if (ev.t === 'move') return { ...s, pos: ev.pos };
      return { ...s, r: ev.r, m: s.m || ev.t === 'mount' };
    });
  return { slots, ...rel(slots, st, cfg) };
}

/** Plain readiness values are mounted slots; `Init` entries say whether they have mounted yet. */
function run(
  initial: readonly (R | Init)[],
  evs: readonly Ev[],
  cfg: Cfg,
  rel: Release = release,
) {
  const slots: Slot[] = initial.map((x, i) =>
    typeof x === 'string' ? { id: i, r: x, m: true } : { ...x, id: x.id ?? i },
  );
  const trace: State[] = [{ slots, ...rel(slots, EMPTY, cfg) }];
  for (const ev of evs)
    trace.push(apply(trace[trace.length - 1], ev, cfg, rel));
  return trace;
}

// deterministic PRNG, as in the store precedence proofs
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const RS: readonly R[] = ['pending', 'ready', 'failed'];

type Shape = {
  /** Slots have hosts with document positions (and may be nodeless, detached, moved). */
  readonly positional?: boolean;
  /** Two slots may share a host. */
  readonly ties?: boolean;
  /** Some hosts live in a shadow root. */
  readonly shadow?: boolean;
};

/**
 * Generated histories. `mounting: false` keeps every slot mounted from the start (adds included),
 * the shape before mount gating existed. Positional shapes register slots in an order unrelated to
 * their positions, connect and disconnect hosts, and move them.
 */
function generate(
  seed: number,
  mounting = true,
  shape: Shape = {},
): { initial: Init[]; evs: Ev[] } {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const used = new Set<number>();
  const place = (): Placement => {
    if (!shape.positional) return {};
    if (rnd() < 0.08) return {}; // a slot without a host
    let pos: number;
    if (shape.ties && used.size && rnd() < 0.15) pos = pick([...used]);
    else {
      do pos = Math.floor(rnd() * 1000);
      while (used.has(pos));
      used.add(pos);
    }
    return {
      pos,
      conn: rnd() < 0.8,
      tree: shape.shadow && rnd() < 0.12 ? 1 : 0,
    };
  };
  const initial: Init[] = Array.from(
    { length: 1 + Math.floor(rnd() * 5) },
    () => ({
      r: rnd() < 0.7 ? 'pending' : pick(RS),
      m: !mounting || rnd() < 0.5,
      ...place(),
    }),
  );
  const ids = initial.map((_, i) => i);
  const hosted = new Set(ids.filter((i) => initial[i].pos !== undefined));
  const unmounted = new Set(ids.filter((i) => !initial[i].m));
  let next = ids.length;
  const evs: Ev[] = [];
  for (let k = Math.floor(rnd() * 24); k > 0; k--) {
    const roll = rnd();
    if (roll < 0.08) {
      const id = next++;
      const p = place();
      evs.push({ t: 'add', id, r: pick(RS), m: !mounting, ...p });
      ids.push(id);
      if (p.pos !== undefined) hosted.add(id);
      if (mounting) unmounted.add(id);
    } else if (roll < 0.14 && ids.length > 1) {
      const id = ids.splice(Math.floor(rnd() * ids.length), 1)[0];
      unmounted.delete(id);
      hosted.delete(id);
      evs.push({ t: 'remove', id });
    } else if (roll < 0.3 && unmounted.size) {
      const id = pick([...unmounted]);
      unmounted.delete(id);
      evs.push({ t: 'mount', id, r: pick(RS) });
    } else if (shape.positional && hosted.size && roll < 0.42) {
      const id = pick([...hosted]);
      const kind = rnd();
      if (kind < 0.35) evs.push({ t: 'connect', id });
      else if (kind < 0.7) evs.push({ t: 'disconnect', id });
      else {
        let pos: number;
        if (shape.ties && rnd() < 0.15) pos = pick([...used]);
        else {
          do pos = Math.floor(rnd() * 1000);
          while (used.has(pos));
          used.add(pos);
        }
        evs.push({ t: 'move', id, pos });
      }
    } else if (ids.length) {
      evs.push({ t: 'set', id: pick(ids), r: pick(RS) });
    }
  }
  return { initial, evs };
}

/**
 * The same history with every pre-mount state replaced by noise: initial states of unmounted slots,
 * the state an `add` carries, and every `set` to a slot that has not mounted yet. Mounts and
 * post-mount events are unchanged, so the two histories differ only in what the gate hides.
 */
function withNoise(
  { initial, evs }: { initial: Init[]; evs: Ev[] },
  noiseSeed: number,
): { initial: Init[]; evs: Ev[] } {
  const rnd = mulberry32(noiseSeed);
  const noise = () => RS[Math.floor(rnd() * RS.length)];
  const mounted = new Set(initial.flatMap((x, i) => (x.m ? [i] : [])));
  return {
    initial: initial.map((x) => (x.m ? x : { ...x, r: noise() })),
    evs: evs.map((ev) => {
      if (ev.t === 'mount' || (ev.t === 'add' && ev.m)) mounted.add(ev.id);
      if (ev.t === 'add' && !ev.m) return { ...ev, r: noise() };
      if (ev.t === 'set' && !mounted.has(ev.id)) return { ...ev, r: noise() };
      return ev;
    }),
  };
}

const CFGS: readonly Cfg[] = (
  ['forwards', 'backwards', 'together'] as const
).flatMap((order) =>
  (['settled', 'blocks'] as const).map((onError) => ({ order, onError })),
);
const SEEDS = 600;
const SHAPES: readonly [string, Shape][] = [
  ['no hosts', {}],
  ['hosts', { positional: true }],
  [
    'hosts, shared hosts, shadow roots',
    { positional: true, ties: true, shadow: true },
  ],
];

/**
 * Who takes part and in what order, stated independently of `participants` (the checker must not
 * share code with the fold it checks): with no host anywhere, every slot in registration order;
 * otherwise the slots whose host is in the document, by position, a shared host by registration;
 * a hold when they span more than one tree.
 */
function refOrder(slots: readonly Slot[]): { ids: number[]; hold: boolean } {
  if (slots.every((s) => s.pos === undefined))
    return { ids: slots.map((s) => s.id), hold: false };
  const inDoc = slots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.pos !== undefined && s.conn === true);
  const trees = new Set(inDoc.map(({ s }) => s.tree ?? 0));
  inDoc.sort((a, b) =>
    a.s.pos === b.s.pos ? a.i - b.i : (a.s.pos as number) - (b.s.pos as number),
  );
  return { ids: inDoc.map(({ s }) => s.id), hold: trees.size > 1 };
}

/**
 * Every property over one transition; returns the first violation or null. Participants and their
 * order come from the reference rule, never from the fold under test, so a fold that lets the wrong
 * slots take part cannot vouch for itself.
 */
function violation(prev: State, next: State, cfg: Cfg): string | null {
  const present = new Set(next.slots.map((s) => s.id));
  const settled = (s: Slot) => settledNow(effective(s), cfg.onError);
  for (const id of prev.released)
    if (present.has(id) && !next.released.has(id))
      return `monotone: ${id} un-released`;
  for (const s of next.slots)
    if (next.released.has(s.id) && !s.m) return `unmounted released: ${s.id}`;
  const fresh = [...next.released].filter((id) => !prev.released.has(id));
  const ref = refOrder(next.slots);
  const truth = { list: ref.ids.map((id) => slotOf(next, id)), hold: ref.hold };
  const inTruth = new Set(ref.ids);
  for (const id of fresh) {
    if (!settled(slotOf(next, id))) return `released unsettled: ${id}`;
    if (!inTruth.has(id)) return `non-participant released: ${id}`;
  }
  for (const s of next.slots)
    if (
      !inTruth.has(s.id) &&
      !next.released.has(s.id) &&
      !gated(next, s.id, cfg)
    )
      return `non-participant not gated: ${s.id}`;
  if (truth.hold) {
    if (fresh.length) return `hold: released ${fresh}`;
    if (
      next.ordered.join() !==
      prev.ordered.filter((id) => present.has(id)).join()
    )
      return 'hold: order changed';
    for (const s of next.slots)
      if (!next.released.has(s.id) && !gated(next, s.id, cfg))
        return `hold: ${s.id} not gated`;
  } else {
    const seqAll = truth.list;
    if (cfg.order === 'together') {
      if (fresh.length && seqAll.some((s) => !next.released.has(s.id)))
        return 'together: partial release';
      if (
        fresh.length &&
        seqAll.some((s) => !prev.released.has(s.id) && !settled(s))
      )
        return 'together: released past an unsettled slot';
    } else {
      const seq = inOrder(seqAll, cfg.order);
      for (const id of fresh) {
        const k = seq.findIndex((s) => s.id === id);
        if (seq.slice(0, k).some((s) => !next.released.has(s.id)))
          return `order: ${id} before a predecessor`;
      }
      const frontier = seq.find((s) => !next.released.has(s.id));
      if (frontier && settled(frontier)) return 'maximal: frontier settled';
      for (const s of seq) {
        const before = seq.slice(0, seq.indexOf(s));
        const held =
          !next.released.has(s.id) &&
          before.some((o) => !next.released.has(o.id));
        if (held && !gated(next, s.id, cfg))
          return `order: ${s.id} not gated behind a predecessor`;
      }
    }
    if (seqAll.every(settled) && seqAll.some((s) => !next.released.has(s.id)))
      return 'liveness';
  }
  if (cfg.onError === 'blocks')
    for (const id of fresh) {
      const blocker = truth.list.find(
        (s) => effective(s) === 'failed' && !next.released.has(s.id),
      );
      if (
        blocker &&
        (cfg.order === 'together' || blockedBy(truth.list, id, blocker.id, cfg))
      )
        return `blocks: ${id} released past failed ${blocker.id}`;
    }
  for (const s of next.slots) {
    if (!s.m) continue;
    const d = display(next, s.id, cfg);
    if (d === 'content' && !next.released.has(s.id))
      return `content before release: ${s.id}`;
  }
  return null;
}

function blockedBy(
  list: readonly Slot[],
  id: number,
  blocker: number,
  cfg: Cfg,
): boolean {
  const seq = inOrder(list, cfg.order);
  return (
    seq.findIndex((s) => s.id === blocker) < seq.findIndex((s) => s.id === id)
  );
}

function firstViolation(
  cfg: Cfg,
  rel: Release = release,
  shape: Shape = {},
): string | null {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { initial, evs } = generate(seed, true, shape);
    const trace = run(initial, evs, cfg, rel);
    const empty: State = { slots: trace[0].slots, ...EMPTY };
    for (let i = 0; i < trace.length; i++) {
      const v = violation(i === 0 ? empty : trace[i - 1], trace[i], cfg);
      if (v) return `seed ${seed} step ${i}: ${v}`;
    }
  }
  return null;
}

/** First step where noise before mount changes what other slots see (released or gated), else null. */
function firstNoiseLeak(
  cfg: Cfg,
  rel: Release = release,
  shape: Shape = {},
): string | null {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const hist = generate(seed, true, shape);
    const base = run(hist.initial, hist.evs, cfg, rel);
    for (let k = 1; k <= 4; k++) {
      const noisy = withNoise(hist, seed * 7919 + k);
      const alt = run(noisy.initial, noisy.evs, cfg, rel);
      for (let i = 0; i < base.length; i++) {
        if (ids(base[i]).join() !== ids(alt[i]).join())
          return `seed ${seed}/${k} step ${i}: released ${ids(base[i])} vs ${ids(alt[i])}`;
        for (const s of base[i].slots)
          if (gated(base[i], s.id, cfg) !== gated(alt[i], s.id, cfg))
            return `seed ${seed}/${k} step ${i}: gated(${s.id}) differs`;
      }
    }
  }
  return null;
}

const ids = (st: State) => [...st.released].sort((a, b) => a - b);
const displays = (st: State, cfg: Cfg) =>
  st.slots.map((s) => display(st, s.id, cfg));
const set = (id: number, r: R): Ev => ({ t: 'set', id, r });

describe('reveal model: properties over generated sequences', () => {
  for (const cfg of CFGS) {
    it(`${cfg.order} / ${cfg.onError}: monotone, ordered, maximal, live (${SEEDS} seeds)`, () => {
      expect(firstViolation(cfg)).toBeNull();
    });
  }

  it('release is a fixpoint: folding again changes nothing (every shape)', () => {
    for (const [, shape] of SHAPES)
      for (const cfg of CFGS)
        for (let seed = 1; seed <= SEEDS; seed++) {
          const { initial, evs } = generate(seed, true, shape);
          for (const st of run(initial, evs, cfg)) {
            const again = release(st.slots, st, cfg);
            expect(ids({ ...st, released: again.released })).toEqual(ids(st));
            expect(again.ordered).toEqual(st.ordered);
          }
        }
  });

  it('under forwards and backwards exactly one unreleased slot is not gated (the frontier, every shape)', () => {
    for (const [, shape] of SHAPES)
      for (const cfg of CFGS.filter((c) => c.order !== 'together'))
        for (let seed = 1; seed <= SEEDS; seed++) {
          const { initial, evs } = generate(seed, true, shape);
          for (const st of run(initial, evs, cfg)) {
            const ref = refOrder(st.slots);
            const open = st.slots.filter(
              (s) => !st.released.has(s.id) && !gated(st, s.id, cfg),
            );
            // exactly the frontier, mounted or not: an unmounted frontier waits on itself;
            // none while held, none when every participant is released
            const waiting = ref.ids.some((id) => !st.released.has(id));
            expect(open.map((s) => s.id).length).toBe(
              !ref.hold && waiting ? 1 : 0,
            );
          }
        }
  });

  it('a gated slot never shows content or its error, whatever its own state (every shape)', () => {
    for (const [, shape] of SHAPES)
      for (const cfg of CFGS)
        for (let seed = 1; seed <= SEEDS; seed++) {
          const { initial, evs } = generate(seed, true, shape);
          for (const st of run(initial, evs, cfg))
            for (const s of st.slots)
              if (gated(st, s.id, cfg))
                expect(display(st, s.id, cfg)).toBe('gated');
        }
  });

  it('the generator reaches every interesting shape (non-vacuity of the sweep)', () => {
    const seen = new Set<string>();
    for (const cfg of CFGS)
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { initial, evs } = generate(seed);
        const trace = run(initial, evs, cfg);
        for (let i = 1; i < trace.length; i++) {
          const [p, n] = [trace[i - 1], trace[i]];
          if (n.released.size > p.released.size)
            seen.add(`${cfg.order}:release`);
          for (const s of n.slots) {
            if (p.released.has(s.id) && s.r === 'pending')
              seen.add('re-suspended while released');
            if (gated(n, s.id, cfg) && effective(s) === 'ready')
              seen.add(`${cfg.order}:ready but gated`);
            if (
              cfg.onError === 'blocks' &&
              effective(s) === 'failed' &&
              !n.released.has(s.id)
            )
              seen.add('blocks:failed holding');
          }
          if (evs[i - 1].t === 'remove' && n.released.size > p.released.size)
            seen.add('removal unblocks');
        }
      }
    expect([...seen].sort()).toEqual(
      [
        'backwards:ready but gated',
        'backwards:release',
        'blocks:failed holding',
        'forwards:ready but gated',
        'forwards:release',
        're-suspended while released',
        'removal unblocks',
        'together:ready but gated',
        'together:release',
      ].sort(),
    );
  });
});

describe('reveal model: a slot counts only once mounted', () => {
  /** The fold before mount gating: every reported state counts, mounted or not. */
  const raw: Release = (slots, prev, cfg) =>
    release(
      slots.map((x) => ({ ...x, m: true })),
      prev,
      cfg,
    );
  const mounted = (r: R): Init => ({ r, m: true });
  const unmounted = (r: R): Init => ({ r, m: false });
  const mount = (id: number, r: R): Ev => ({ t: 'mount', id, r });

  for (const cfg of CFGS) {
    it(`${cfg.order} / ${cfg.onError}: noise before mount never changes released or gated (${SEEDS} seeds x 4 noises)`, () => {
      expect(firstNoiseLeak(cfg)).toBeNull();
    });
  }

  it('the noise actually differs from the history it replaces', () => {
    let differing = 0;
    let total = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const hist = generate(seed);
      for (let k = 1; k <= 4; k++) {
        total++;
        const noisy = withNoise(hist, seed * 7919 + k);
        if (JSON.stringify(noisy) !== JSON.stringify(hist)) differing++;
      }
    }
    expect(differing / total).toBeGreaterThan(0.6);
  });

  it('the raw fold leaks pre-mount noise under every config (the gate is not vacuous)', () => {
    for (const cfg of CFGS) expect(firstNoiseLeak(cfg, raw)).not.toBeNull();
    for (const cfg of CFGS)
      expect(firstViolation(cfg, raw)).toMatch(
        /unmounted released|released unsettled|together: released past/,
      );
  });

  it('backwards, a later row reads failed before its inputs bind: nothing releases until it really settles', () => {
    const cfg: Cfg = { order: 'backwards', onError: 'settled' };
    // nothing has mounted at a's first read; c reads failed before its input binds
    const initial = [
      unmounted('pending'),
      unmounted('pending'),
      unmounted('failed'),
    ];
    const evs = [
      mount(0, 'pending'),
      mount(1, 'pending'),
      mount(2, 'pending'),
      set(1, 'ready'),
      set(2, 'ready'),
      set(0, 'ready'),
    ];
    const t = run(initial, evs, cfg);
    expect(t.map(ids)).toEqual([[], [], [], [], [], [1, 2], [0, 1, 2]]);
    expect(gated(t[4], 1, cfg)).toBe(true);
    expect(displays(t[4], cfg)).toEqual(['gated', 'gated', 'placeholder']);
    // the shipped behaviour: c released on noise, b shows before c
    const bug = run(initial, evs, cfg, raw);
    expect(ids(bug[0])).toEqual([2]);
    expect(ids(bug[4])).toEqual([1, 2]);
  });

  it('together: an unmounted slot reporting ready waits on itself (not gated), so collapsed still shows its placeholder', () => {
    const cfg: Cfg = { order: 'together', onError: 'settled' };
    const t = run([unmounted('ready'), mounted('pending')], [], cfg);
    expect(gated(t[0], 0, cfg)).toBe(false);
    const after = run(
      [unmounted('ready'), mounted('pending')],
      [mount(0, 'ready')],
      cfg,
    );
    expect(gated(after[1], 0, cfg)).toBe(true);
    expect(ids(after[1])).toEqual([]);
  });

  it('a mount can release on its own: the last pending read was the gate', () => {
    const cfg: Cfg = { order: 'forwards', onError: 'settled' };
    const t = run(
      [mounted('ready'), unmounted('ready')],
      [mount(1, 'ready')],
      cfg,
    );
    expect(ids(t[0])).toEqual([0]);
    expect(ids(t[1])).toEqual([0, 1]);
  });

  it('the generator reaches the pre-mount shapes (non-vacuity of the sweep)', () => {
    const seen = new Set<string>();
    for (const cfg of CFGS)
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { initial, evs } = generate(seed);
        const trace = run(initial, evs, cfg);
        for (let i = 1; i < trace.length; i++) {
          const [p, n] = [trace[i - 1], trace[i]];
          const ev = evs[i - 1];
          if (ev.t === 'mount' && n.released.size > p.released.size)
            seen.add(`${cfg.order}:mount releases`);
          for (const s of n.slots)
            if (!s.m && settledNow(s.r, cfg.onError))
              seen.add(`${cfg.order}:unmounted reports settled`);
          if (ev.t === 'set' && !n.slots.find((x) => x.id === ev.id)?.m)
            seen.add('noise set');
        }
      }
    expect([...seen].sort()).toEqual(
      [
        'backwards:mount releases',
        'backwards:unmounted reports settled',
        'forwards:mount releases',
        'forwards:unmounted reports settled',
        'noise set',
        'together:mount releases',
        'together:unmounted reports settled',
      ].sort(),
    );
  });
});

describe('reveal model: order is document order', () => {
  const at = (pos: number, r: R, extra: Partial<Init> = {}): Init => ({
    r,
    m: true,
    pos,
    conn: true,
    ...extra,
  });
  const fwd: Cfg = { order: 'forwards', onError: 'settled' };

  for (const [name, shape] of SHAPES.slice(1))
    for (const cfg of CFGS)
      it(`${name}, ${cfg.order} / ${cfg.onError}: every fold property holds (${SEEDS} seeds)`, () => {
        expect(firstViolation(cfg, release, shape)).toBeNull();
        expect(firstNoiseLeak(cfg, release, shape)).toBeNull();
      });

  /** P6: histories that differ only in registration order give the same released and gated at every step. */
  function firstRegistrationLeak(cfg: Cfg, rel: Release): string | null {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const hist = generate(seed, true, { positional: true });
      if (!hist.initial.every((x) => x.pos !== undefined)) continue;
      const withIds = hist.initial.map((x, id) => ({ ...x, id }));
      const shuffled = [...withIds].reverse();
      const a = run(withIds, hist.evs, cfg, rel);
      const b = run(shuffled, hist.evs, cfg, rel);
      for (let i = 0; i < a.length; i++) {
        if (ids(a[i]).join() !== ids(b[i]).join())
          return `seed ${seed} step ${i}: released ${ids(a[i])} vs ${ids(b[i])}`;
        for (const s of a[i].slots)
          if (gated(a[i], s.id, cfg) !== gated(b[i], s.id, cfg))
            return `seed ${seed} step ${i}: gated(${s.id}) differs`;
      }
    }
    return null;
  }

  for (const cfg of CFGS)
    it(`${cfg.order} / ${cfg.onError}: registration order never matters once slots have hosts (P6)`, () => {
      expect(firstRegistrationLeak(cfg, release)).toBeNull();
    });

  it('registration order as the order leaks into what readers see (killed)', () => {
    for (const order of ['forwards', 'backwards'] as const)
      expect(
        firstRegistrationLeak(
          { order, onError: 'settled' },
          makeRelease('registration'),
        ),
      ).not.toBeNull();
    // the @if case: x is first in the document but registered second
    const t = run(
      [at(1, 'ready', { id: 0 }), at(0, 'pending', { id: 1 })],
      [],
      fwd,
    );
    expect(ids(t[0])).toEqual([]); // y (pos 1) waits for x (pos 0)
    const r = run(
      [at(1, 'ready', { id: 0 }), at(0, 'pending', { id: 1 })],
      [],
      fwd,
      makeRelease('registration'),
    );
    expect(ids(r[0])).toEqual([0]);
  });

  it('a detached slot leaves the order: every other slot sees what it would after a removal (P11)', () => {
    let checked = 0;
    for (const cfg of CFGS)
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { initial, evs } = generate(seed, true, {
          positional: true,
          ties: true,
        });
        const trace = run(initial, evs, cfg);
        evs.forEach((ev, i) => {
          if (ev.t !== 'disconnect') return;
          const before = trace[i];
          const after = trace[i + 1];
          const removed = apply(before, { t: 'remove', id: ev.id }, cfg);
          // removing the last slot with a host switches the coordinator to registration order;
          // detaching it does not (a nodeless slot mixed into a DOM reveal): out of scope here
          if (!removed.slots.some(hasHost)) return;
          for (const s of removed.slots) {
            checked++;
            expect([
              s.id,
              after.released.has(s.id),
              gated(after, s.id, cfg),
            ]).toEqual([
              s.id,
              removed.released.has(s.id),
              gated(removed, s.id, cfg),
            ]);
          }
        });
      }
    expect(checked).toBeGreaterThan(1000);
  });

  it('a released slot stays released while detached and after it comes back (P10)', () => {
    const t = run(
      [at(0, 'ready'), at(1, 'pending')],
      [{ t: 'disconnect', id: 0 }, set(1, 'ready'), { t: 'connect', id: 0 }],
      fwd,
    );
    expect(t.map(ids)).toEqual([[0], [0], [0, 1], [0, 1]]);
  });

  it('two slots on one host order by registration, and swapping it swaps only them (P8)', () => {
    const one = run(
      [
        at(5, 'ready', { id: 0 }),
        at(5, 'pending', { id: 1 }),
        at(9, 'ready', { id: 2 }),
      ],
      [],
      fwd,
    );
    expect(one[0].ordered).toEqual([0, 1, 2]);
    expect(ids(one[0])).toEqual([0]);
    const swapped = run(
      [
        at(5, 'pending', { id: 1 }),
        at(5, 'ready', { id: 0 }),
        at(9, 'ready', { id: 2 }),
      ],
      [],
      fwd,
    );
    expect(swapped[0].ordered).toEqual([1, 0, 2]);
    expect(ids(swapped[0])).toEqual([]);
  });

  it('a move reorders the waiting slots at the next fold', () => {
    const t = run(
      [at(0, 'pending', { id: 0 }), at(1, 'ready', { id: 1 })],
      [{ t: 'move', id: 1, pos: -1 }],
      fwd,
    );
    expect(ids(t[0])).toEqual([]);
    expect(gated(t[0], 1, fwd)).toBe(true);
    expect(t[1].ordered).toEqual([1, 0]);
    expect(ids(t[1])).toEqual([1]);
  });

  it('a host in the document that has not been checked yet still holds its place (pending)', () => {
    // the @for case of the mount gate, with hosts: c is inserted and first in backwards order
    const back: Cfg = { order: 'backwards', onError: 'settled' };
    const t = run(
      [
        at(0, 'pending', { m: false }),
        at(1, 'ready'),
        at(2, 'failed', { m: false }),
      ],
      [],
      back,
    );
    expect(t[0].ordered).toEqual([0, 1, 2]);
    expect(ids(t[0])).toEqual([]); // c is pending in its place: nothing passes it
  });

  it('a slot without a host, or whose host is out of the document, neither blocks nor shows', () => {
    const t = run(
      [
        at(0, 'pending', { conn: false }),
        { r: 'pending', m: true }, // no host at all
        at(2, 'ready'),
      ],
      [],
      fwd,
    );
    expect(t[0].ordered).toEqual([2]);
    expect(ids(t[0])).toEqual([2]);
    expect([gated(t[0], 0, fwd), gated(t[0], 1, fwd)]).toEqual([true, true]);
  });

  it('detached slots released together come back intact; reattached in a new order they follow it (B10)', () => {
    const intact = run(
      [at(0, 'ready', { conn: false }), at(1, 'ready', { conn: false })],
      [
        { t: 'connect', id: 0 },
        { t: 'connect', id: 1 },
      ],
      fwd,
    );
    expect(intact.map(ids)).toEqual([[], [0], [0, 1]]);
    const reparented = run(
      [at(0, 'pending', { conn: false }), at(1, 'ready', { conn: false })],
      [
        { t: 'move', id: 1, pos: -1 },
        { t: 'connect', id: 0 },
        { t: 'connect', id: 1 },
      ],
      fwd,
    );
    expect(reparented.at(-1)?.ordered).toEqual([1, 0]);
    expect(ids(reparented.at(-1) as State)).toEqual([1]);
  });

  it('a pair in different trees holds the fold: nothing new shows, the previous order stands (P7, B11)', () => {
    const t = run(
      [at(0, 'ready'), at(1, 'pending'), at(2, 'ready')],
      [
        { t: 'add', id: 3, r: 'ready', m: true, pos: 3, conn: true, tree: 1 },
        set(1, 'ready'),
        { t: 'remove', id: 3 },
      ],
      fwd,
    );
    expect(t[0].ordered).toEqual([0, 1, 2]);
    expect(ids(t[0])).toEqual([0]);
    expect(t[1].ordered).toEqual([0, 1, 2]); // held: the shadow slot is not in the order
    expect(ids(t[2])).toEqual([0]); // held: 1 is ready but nothing new releases
    expect(gated(t[2], 3, fwd)).toBe(true);
    expect(displays(t[2], fwd)).toEqual(['content', 'gated', 'gated', 'gated']);
    expect(ids(t[3])).toEqual([0, 1, 2]); // the pair is gone: the fold moves on
  });

  it('fallback to registration order on a positionless fold releases past a slot first in the document (killed)', () => {
    // y is first in the document but registered second; z registers before its host is inserted
    const evs: Ev[] = [
      { t: 'add', id: 2, r: 'pending', m: false, pos: 5, conn: false },
    ];
    const init = [at(1, 'ready', { id: 0 }), at(0, 'pending', { id: 1 })];
    expect(ids(run(init, evs, fwd).at(-1) as State)).toEqual([]);
    const fallback = run(init, evs, fwd, makeRelease('fallback'));
    expect(ids(fallback.at(-1) as State)).toEqual([0]); // x released past y, for good
    expect(
      firstViolation(fwd, makeRelease('fallback'), { positional: true }),
    ).toMatch(/non-participant|order|maximal/);
  });

  it('holding everything while any slot is out freezes a reveal under a cached route (killed)', () => {
    // a was released, then its route was cached (detached); b is new and ready
    const evs: Ev[] = [
      { t: 'disconnect', id: 0 },
      { t: 'add', id: 1, r: 'ready', m: true, pos: 1, conn: true },
    ];
    expect(ids(run([at(0, 'ready')], evs, fwd).at(-1) as State)).toEqual([
      0, 1,
    ]);
    expect(
      ids(
        run([at(0, 'ready')], evs, fwd, makeRelease('holdAll')).at(-1) as State,
      ),
    ).toEqual([0]);
    expect(
      firstViolation(fwd, makeRelease('holdAll'), { positional: true }),
    ).toMatch(/hold|liveness|maximal/);
  });

  it('positionless slots appended last let a slot with no host release and block (killed)', () => {
    for (const cfg of CFGS.filter((c) => c.order !== 'together'))
      expect(
        firstViolation(cfg, makeRelease('last'), { positional: true }),
      ).toMatch(/non-participant/);
  });

  it('the generator reaches the positional shapes (non-vacuity of the sweep)', () => {
    const seen = new Set<string>();
    for (const cfg of CFGS)
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { initial, evs } = generate(seed, true, {
          positional: true,
          ties: true,
          shadow: true,
        });
        const trace = run(initial, evs, cfg);
        for (let i = 1; i < trace.length; i++) {
          const [p, n] = [trace[i - 1], trace[i]];
          const ev = evs[i - 1];
          if (participants(n.slots).hold) seen.add('hold');
          if (ev.t === 'move' && n.ordered.join() !== p.ordered.join())
            seen.add('move reorders');
          if (ev.t === 'connect' && n.released.size > p.released.size)
            seen.add('connect releases');
          if (ev.t === 'disconnect' && n.released.size > p.released.size)
            seen.add('disconnect unblocks');
          if (ev.t === 'disconnect' && p.released.has(ev.id))
            seen.add('released slot detached');
          for (const s of n.slots) {
            if (!hasHost(s)) seen.add('no host');
            if (n.slots.some((o) => o !== s && hasHost(o) && o.pos === s.pos))
              seen.add('shared host');
            if (hasHost(s) && s.conn && !s.m) seen.add('placed, not mounted');
          }
        }
      }
    expect([...seen].sort()).toEqual(
      [
        'connect releases',
        'disconnect unblocks',
        'hold',
        'move reorders',
        'no host',
        'placed, not mounted',
        'released slot detached',
        'shared host',
      ].sort(),
    );
  });
});

describe('reveal model: pinned scenarios', () => {
  const fwd = (onError: OnError): Cfg => ({ order: 'forwards', onError });

  it('middle slot errors under settled: it shows its error and the slots after it reveal', () => {
    const t = run(
      ['pending', 'pending', 'pending'],
      [set(2, 'ready'), set(0, 'ready'), set(1, 'failed')],
      fwd('settled'),
    );
    expect(displays(t[1], fwd('settled'))).toEqual([
      'placeholder',
      'gated',
      'gated',
    ]);
    expect(displays(t[2], fwd('settled'))).toEqual([
      'content',
      'placeholder',
      'gated',
    ]);
    expect(displays(t[3], fwd('settled'))).toEqual([
      'content',
      'error',
      'content',
    ]);
    expect(ids(t[3])).toEqual([0, 1, 2]);
  });

  it('middle slot errors under blocks: it shows its error, later slots wait until a retry succeeds', () => {
    const cfg = fwd('blocks');
    const t = run(
      ['ready', 'pending', 'ready'],
      [set(1, 'failed'), set(1, 'pending'), set(1, 'ready')],
      cfg,
    );
    expect(displays(t[1], cfg)).toEqual(['content', 'error', 'gated']);
    expect(ids(t[1])).toEqual([0]);
    expect(displays(t[2], cfg)).toEqual(['content', 'placeholder', 'gated']);
    expect(displays(t[3], cfg)).toEqual(['content', 'content', 'content']);
  });

  it('last slot readies first under forwards: it stays gated until every slot before it is settled', () => {
    const cfg = fwd('settled');
    const t = run(
      ['pending', 'pending', 'pending'],
      [set(2, 'ready'), set(1, 'ready'), set(0, 'ready')],
      cfg,
    );
    expect(ids(t[1])).toEqual([]);
    expect(ids(t[2])).toEqual([]);
    expect(displays(t[2], cfg)).toEqual(['placeholder', 'gated', 'gated']);
    expect(ids(t[3])).toEqual([0, 1, 2]);
  });

  it('backwards mirrors forwards', () => {
    const cfg: Cfg = { order: 'backwards', onError: 'settled' };
    const t = run(
      ['pending', 'pending', 'pending'],
      [set(0, 'ready'), set(2, 'ready')],
      cfg,
    );
    expect(displays(t[1], cfg)).toEqual(['gated', 'gated', 'placeholder']);
    expect(displays(t[2], cfg)).toEqual(['gated', 'placeholder', 'content']);
  });

  it('together with one slot failing under settled: everything reveals, the failed slot shows its error', () => {
    const cfg: Cfg = { order: 'together', onError: 'settled' };
    const t = run(
      ['pending', 'pending', 'pending'],
      [set(0, 'ready'), set(2, 'ready'), set(1, 'failed')],
      cfg,
    );
    expect(displays(t[2], cfg)).toEqual(['gated', 'placeholder', 'gated']);
    expect(displays(t[3], cfg)).toEqual(['content', 'error', 'content']);
  });

  it('together with one slot failing under blocks: only the failed slot shows (its error), the rest wait for the retry', () => {
    const cfg: Cfg = { order: 'together', onError: 'blocks' };
    const t = run(
      ['ready', 'pending', 'ready'],
      [set(1, 'failed'), set(1, 'pending'), set(1, 'ready')],
      cfg,
    );
    expect(displays(t[1], cfg)).toEqual(['gated', 'error', 'gated']);
    expect(ids(t[1])).toEqual([]);
    expect(displays(t[2], cfg)).toEqual(['gated', 'placeholder', 'gated']);
    expect(displays(t[3], cfg)).toEqual(['content', 'content', 'content']);
  });

  it('a revealed slot that re-suspends stays released and shows its own placeholder', () => {
    const cfg = fwd('settled');
    const t = run(
      ['ready', 'ready'],
      [set(0, 'pending'), set(1, 'pending')],
      cfg,
    );
    expect(ids(t[0])).toEqual([0, 1]);
    expect(displays(t[1], cfg)).toEqual(['placeholder', 'content']);
    expect(ids(t[2])).toEqual([0, 1]);
  });

  it('removing a blocking slot unblocks the slots behind it', () => {
    const cfg = fwd('blocks');
    const t = run(['failed', 'ready'], [{ t: 'remove', id: 0 }], cfg);
    expect(ids(t[0])).toEqual([]);
    expect(ids(t[1])).toEqual([1]);
  });
});

describe('reveal model: killed alternatives', () => {
  /** "An errored slot is never settled" as the only mode. */
  const errorNeverSettles: Release = (slots, prev, cfg) =>
    release(slots, prev, { ...cfg, onError: 'blocks' });
  /** No latch: the allowed set is recomputed from the current states every time. */
  const unlatched: Release = (slots, _prev, cfg) => release(slots, EMPTY, cfg);
  /** Together released slot by slot as each becomes ready. */
  const togetherPerSlot: Release = (slots, prev, cfg) => ({
    released: new Set([
      ...prev.released,
      ...slots
        .filter((s) => settledNow(effective(s), cfg.onError))
        .map((s) => s.id),
    ]),
    ordered: participants(slots).list.map((s) => s.id),
    held: false,
  });
  /** Forwards that ignores order: every settled slot shows. */
  const unordered = togetherPerSlot;

  it('errored-never-settles blocks a dashboard forever when one tile fails for good', () => {
    const cfg: Cfg = { order: 'forwards', onError: 'settled' };
    const evs = [
      set(0, 'ready'),
      set(1, 'failed'),
      set(2, 'ready'),
      set(3, 'ready'),
    ];
    const alt = run(
      ['pending', 'pending', 'pending', 'pending'],
      evs,
      cfg,
      errorNeverSettles,
    );
    expect(ids(alt[alt.length - 1])).toEqual([0]);
    expect(firstViolation(cfg, errorNeverSettles)).toMatch(/maximal|liveness/);
    expect(
      ids(
        run(['pending', 'pending', 'pending', 'pending'], evs, cfg).at(
          -1,
        ) as State,
      ),
    ).toEqual([0, 1, 2, 3]);
  });

  it('an unlatched allowed set hides a revealed slot when an earlier one re-suspends', () => {
    const cfg: Cfg = { order: 'forwards', onError: 'settled' };
    const alt = run(['ready', 'ready'], [set(0, 'pending')], cfg, unlatched);
    expect(ids(alt[1])).toEqual([]);
    for (const c of CFGS)
      expect(firstViolation(c, unlatched)).toMatch(/monotone/);
  });

  it('per-slot release breaks together', () => {
    for (const onError of ['settled', 'blocks'] as const)
      expect(
        firstViolation({ order: 'together', onError }, togetherPerSlot),
      ).toMatch(/together: partial/);
  });

  it('order-blind release breaks forwards and backwards', () => {
    for (const order of ['forwards', 'backwards'] as const)
      for (const onError of ['settled', 'blocks'] as const)
        expect(firstViolation({ order, onError }, unordered)).toMatch(/order:/);
  });
});

describe('reveal coordinator conforms to the model', () => {
  it('released and gated match the model after every step, every config, every seed (mounts included)', () => {
    let steps = 0;
    let mounts = 0;
    for (const cfg of CFGS)
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { initial, evs } = generate(seed);
        const trace = run(initial, evs, cfg);
        const coordinator = createRevealCoordinator({
          order: () => cfg.order,
          onError: () => cfg.onError,
        });
        const live = new Map<
          number,
          { r: WritableSignal<R>; slot: RevealSlot }
        >();
        const join = (id: number, r: R, m: boolean) => {
          const state = signal(r);
          const slot = coordinator.register(state);
          if (m) slot.mount();
          live.set(id, { r: state, slot });
        };
        initial.forEach((x, id) => join(id, x.r, x.m));
        const check = (st: State) => {
          steps++;
          for (const s of st.slots) {
            const { slot } = live.get(s.id) as { slot: RevealSlot };
            expect(slot.released()).toBe(st.released.has(s.id));
            expect(slot.gated()).toBe(gated(st, s.id, cfg));
          }
        };
        check(trace[0]);
        evs.forEach((ev, i) => {
          if (ev.t === 'add') join(ev.id, ev.r, ev.m ?? false);
          else if (ev.t === 'remove') {
            live.get(ev.id)?.slot.unregister();
            live.delete(ev.id);
          } else if (ev.t === 'mount') {
            const l = live.get(ev.id);
            l?.r.set(ev.r);
            l?.slot.mount();
            mounts++;
          } else if (ev.t === 'set') live.get(ev.id)?.r.set(ev.r);
          check(trace[i + 1]);
        });
      }
    expect(steps).toBeGreaterThan(CFGS.length * SEEDS * 5);
    expect(mounts).toBeGreaterThan(CFGS.length * SEEDS);
  });

  /** A host whose document position and tree come from the model; equal positions = one host. */
  class FakeHost {
    constructor(
      public pos: number,
      public tree: number,
      public conn: boolean,
    ) {}
    get isConnected() {
      return this.conn;
    }
    compareDocumentPosition(o: FakeHost): number {
      if (o === this) return 0;
      const side = o.pos > this.pos ? 4 : 2;
      if (o.tree !== this.tree) return 1 | 32 | side;
      return o.pos === this.pos ? 0 : side;
    }
  }

  for (const [name, shape] of SHAPES.slice(1))
    it(`released and gated match the model with hosts: ${name} (every config, every seed)`, () => {
      let steps = 0;
      let moves = 0;
      for (const cfg of CFGS)
        for (let seed = 1; seed <= SEEDS; seed++) {
          const { initial, evs } = generate(seed, true, shape);
          const trace = run(initial, evs, cfg);
          const coordinator = createRevealCoordinator({
            order: () => cfg.order,
            onError: () => cfg.onError,
          });
          const live = new Map<
            number,
            { r: WritableSignal<R>; slot: RevealSlot; host: FakeHost | null }
          >();
          const join = (id: number, x: Init) => {
            const state = signal(x.r);
            const host =
              x.pos === undefined
                ? null
                : new FakeHost(x.pos, x.tree ?? 0, !!x.conn);
            const slot = coordinator.register(state, host);
            if (x.m) slot.mount();
            live.set(id, { r: state, slot, host });
          };
          initial.forEach((x, id) => join(id, x));
          const check = (st: State) => {
            steps++;
            for (const s of st.slots) {
              const { slot } = live.get(s.id) as { slot: RevealSlot };
              expect([s.id, slot.released()]).toEqual([
                s.id,
                st.released.has(s.id),
              ]);
              expect([s.id, slot.gated()]).toEqual([
                s.id,
                gated(st, s.id, cfg),
              ]);
            }
          };
          check(trace[0]);
          evs.forEach((ev, i) => {
            const l = live.get(ev.id);
            if (ev.t === 'add') join(ev.id, { ...ev, m: ev.m ?? false });
            else if (ev.t === 'remove') {
              l?.slot.unregister();
              live.delete(ev.id);
            } else if (ev.t === 'mount') {
              l?.r.set(ev.r);
              l?.slot.mount();
            } else if (ev.t === 'set') l?.r.set(ev.r);
            else if (l?.host) {
              // placement changed with no slot changing: what MmReveal observes after a render
              if (ev.t === 'connect') l.host.conn = true;
              else if (ev.t === 'disconnect') l.host.conn = false;
              else {
                l.host.pos = ev.pos;
                moves++;
              }
              coordinator.relayout();
            }
            check(trace[i + 1]);
          });
        }
      expect(steps).toBeGreaterThan(CFGS.length * SEEDS * 5);
      expect(moves).toBeGreaterThan(CFGS.length * 100);
    });

  it('never reads a slot state before mount: a state that throws until then is harmless', () => {
    for (const cfg of CFGS) {
      const coordinator = createRevealCoordinator({
        order: () => cfg.order,
        onError: () => cfg.onError,
      });
      const ok = coordinator.register(() => 'ready');
      ok.mount();
      let bound = false;
      const late = coordinator.register(() => {
        if (!bound) throw new Error('required input read before it was set');
        return 'ready';
      });
      const after = coordinator.register(() => 'ready');
      after.mount();
      const read = () =>
        [ok, late, after].map((s) => [s.released(), s.gated()]);
      expect(read).not.toThrow();
      expect(late.released()).toBe(false);
      bound = true;
      late.mount();
      expect([ok, late, after].every((s) => s.released())).toBe(true);
    }
  });

  it('mount is idempotent and does nothing after unregister', () => {
    const cfg: Cfg = { order: 'forwards', onError: 'settled' };
    const coordinator = createRevealCoordinator({
      order: () => cfg.order,
      onError: () => cfg.onError,
    });
    const a = coordinator.register(() => 'pending');
    const b = coordinator.register(() => 'ready');
    a.mount();
    a.mount();
    b.mount();
    expect(b.released()).toBe(false);
    expect(b.gated()).toBe(true);
    a.unregister();
    a.mount();
    expect(b.released()).toBe(true);
    // re-mounting a removed slot does not bring it back to hold anything
    const c = coordinator.register(() => 'ready');
    c.mount();
    expect(c.released()).toBe(true);
    expect(a.released()).toBe(false);
  });
});
