import { signal, type WritableSignal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { createRevealCoordinator, type RevealSlot } from './reveal';

/**
 * Reveal ordering, pure reference model + properties. No Angular, no boundary: slots are a list of
 * readiness values in registration order and the model folds a sequence of changes into a latched
 * released set. The coordinator in `reveal.ts` is checked against this model at the bottom.
 *
 * Terms: a slot is settled-now when it is ready, or failed under `onError: 'settled'`. A slot is
 * released (may show content) once it is settled-now and every slot before it in order is released
 * (`forwards` / `backwards`), or once every slot is released or settled-now (`together`). Released
 * stays released. A gated slot is unreleased and held by another slot: it shows its placeholder,
 * or nothing when collapsed.
 */

type Order = 'forwards' | 'backwards' | 'together';
type OnError = 'settled' | 'blocks';
type R = 'pending' | 'ready' | 'failed';
type Slot = { readonly id: number; readonly r: R };
type State = {
  readonly slots: readonly Slot[];
  readonly released: ReadonlySet<number>;
};
type Cfg = { readonly order: Order; readonly onError: OnError };
type Ev =
  | { readonly t: 'set'; readonly id: number; readonly r: R }
  | { readonly t: 'add'; readonly id: number; readonly r: R }
  | { readonly t: 'remove'; readonly id: number };
type Display = 'content' | 'placeholder' | 'error' | 'gated';
type Release = (
  slots: readonly Slot[],
  prev: ReadonlySet<number>,
  cfg: Cfg,
) => Set<number>;

const settledNow = (r: R, onError: OnError) =>
  r === 'ready' || (onError === 'settled' && r === 'failed');

const inOrder = (slots: readonly Slot[], order: Order) =>
  order === 'backwards' ? [...slots].reverse() : [...slots];

const release: Release = (slots, prev, { order, onError }) => {
  const out = new Set([...prev].filter((id) => slots.some((s) => s.id === id)));
  if (order === 'together') {
    if (slots.every((s) => out.has(s.id) || settledNow(s.r, onError)))
      for (const s of slots) out.add(s.id);
    return out;
  }
  for (const s of inOrder(slots, order)) {
    if (out.has(s.id)) continue;
    if (!settledNow(s.r, onError)) break;
    out.add(s.id);
  }
  return out;
};

function gated(st: State, id: number, cfg: Cfg): boolean {
  if (st.released.has(id)) return false;
  const self = st.slots.find((s) => s.id === id) as Slot;
  if (cfg.order === 'together') return settledNow(self.r, cfg.onError);
  const seq = inOrder(st.slots, cfg.order);
  return seq.slice(0, seq.indexOf(self)).some((s) => !st.released.has(s.id));
}

function display(st: State, id: number, cfg: Cfg): Display {
  if (gated(st, id, cfg)) return 'gated';
  const r = (st.slots.find((s) => s.id === id) as Slot).r;
  return r === 'ready' ? 'content' : r === 'failed' ? 'error' : 'placeholder';
}

function apply(st: State, ev: Ev, cfg: Cfg, rel: Release = release): State {
  let slots = st.slots;
  if (ev.t === 'add') slots = [...slots, { id: ev.id, r: ev.r }];
  else if (ev.t === 'remove') slots = slots.filter((s) => s.id !== ev.id);
  else slots = slots.map((s) => (s.id === ev.id ? { id: s.id, r: ev.r } : s));
  return { slots, released: rel(slots, st.released, cfg) };
}

function run(
  initial: readonly R[],
  evs: readonly Ev[],
  cfg: Cfg,
  rel: Release = release,
) {
  const slots = initial.map((r, id) => ({ id, r }));
  const trace: State[] = [{ slots, released: rel(slots, new Set(), cfg) }];
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

function generate(seed: number): { initial: R[]; evs: Ev[] } {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const initial = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () =>
    rnd() < 0.7 ? 'pending' : pick(RS),
  );
  const ids = initial.map((_, i) => i);
  let next = ids.length;
  const evs: Ev[] = [];
  for (let k = Math.floor(rnd() * 24); k > 0; k--) {
    const roll = rnd();
    if (roll < 0.08) {
      evs.push({ t: 'add', id: next, r: pick(RS) });
      ids.push(next++);
    } else if (roll < 0.14 && ids.length > 1) {
      evs.push({
        t: 'remove',
        id: ids.splice(Math.floor(rnd() * ids.length), 1)[0],
      });
    } else if (ids.length) {
      evs.push({ t: 'set', id: pick(ids), r: pick(RS) });
    }
  }
  return { initial, evs };
}

const CFGS: readonly Cfg[] = (
  ['forwards', 'backwards', 'together'] as const
).flatMap((order) =>
  (['settled', 'blocks'] as const).map((onError) => ({ order, onError })),
);
const SEEDS = 600;

/** Every property over one transition; returns the first violation or null. */
function violation(prev: State, next: State, cfg: Cfg): string | null {
  const present = new Set(next.slots.map((s) => s.id));
  for (const id of prev.released)
    if (present.has(id) && !next.released.has(id))
      return `monotone: ${id} un-released`;
  const fresh = [...next.released].filter((id) => !prev.released.has(id));
  if (cfg.order === 'together') {
    if (fresh.length && next.slots.some((s) => !next.released.has(s.id)))
      return 'together: partial release';
  } else {
    const seq = inOrder(next.slots, cfg.order);
    for (const id of fresh) {
      const i = seq.findIndex((s) => s.id === id);
      if (seq.slice(0, i).some((s) => !next.released.has(s.id)))
        return `order: ${id} before a predecessor`;
    }
    const frontier = seq.find((s) => !next.released.has(s.id));
    if (frontier && settledNow(frontier.r, cfg.onError))
      return 'maximal: frontier settled';
  }
  if (next.slots.every((s) => settledNow(s.r, cfg.onError)))
    if (next.slots.some((s) => !next.released.has(s.id))) return 'liveness';
  if (cfg.onError === 'blocks')
    for (const id of fresh) {
      const blocker = next.slots.find(
        (s) => s.r === 'failed' && !next.released.has(s.id),
      );
      if (
        blocker &&
        (cfg.order === 'together' || blockedBy(next, id, blocker.id, cfg))
      )
        return `blocks: ${id} released past failed ${blocker.id}`;
    }
  for (const s of next.slots) {
    const d = display(next, s.id, cfg);
    if (d === 'content' && !next.released.has(s.id))
      return `content before release: ${s.id}`;
  }
  return null;
}

function blockedBy(st: State, id: number, blocker: number, cfg: Cfg): boolean {
  const seq = inOrder(st.slots, cfg.order);
  return (
    seq.findIndex((s) => s.id === blocker) < seq.findIndex((s) => s.id === id)
  );
}

function firstViolation(cfg: Cfg, rel: Release = release): string | null {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { initial, evs } = generate(seed);
    const trace = run(initial, evs, cfg, rel);
    const empty: State = { slots: trace[0].slots, released: new Set() };
    for (let i = 0; i < trace.length; i++) {
      const v = violation(i === 0 ? empty : trace[i - 1], trace[i], cfg);
      if (v) return `seed ${seed} step ${i}: ${v}`;
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

  it('release is a fixpoint: folding again changes nothing', () => {
    for (const cfg of CFGS)
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { initial, evs } = generate(seed);
        for (const st of run(initial, evs, cfg))
          expect(
            ids({ ...st, released: release(st.slots, st.released, cfg) }),
          ).toEqual(ids(st));
      }
  });

  it('under forwards and backwards at most one unreleased slot is not gated (the frontier)', () => {
    for (const cfg of CFGS.filter((c) => c.order !== 'together'))
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { initial, evs } = generate(seed);
        for (const st of run(initial, evs, cfg)) {
          const open = st.slots.filter(
            (s) => !st.released.has(s.id) && !gated(st, s.id, cfg),
          );
          expect(open.length).toBeLessThanOrEqual(1);
        }
      }
  });

  it('a gated slot never shows content or its error, whatever its own state', () => {
    for (const cfg of CFGS)
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { initial, evs } = generate(seed);
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
            if (gated(n, s.id, cfg) && s.r === 'ready')
              seen.add(`${cfg.order}:ready but gated`);
            if (
              cfg.onError === 'blocks' &&
              s.r === 'failed' &&
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
  const unlatched: Release = (slots, _prev, cfg) =>
    release(slots, new Set(), cfg);
  /** Together released slot by slot as each becomes ready. */
  const togetherPerSlot: Release = (slots, prev, cfg) =>
    new Set([
      ...prev,
      ...slots.filter((s) => settledNow(s.r, cfg.onError)).map((s) => s.id),
    ]);
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
  it('released and gated match the model after every step, every config, every seed', () => {
    let steps = 0;
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
        const join = (id: number, r: R) => {
          const state = signal(r);
          live.set(id, { r: state, slot: coordinator.register(state) });
        };
        initial.forEach((r, id) => join(id, r));
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
          if (ev.t === 'add') join(ev.id, ev.r);
          else if (ev.t === 'remove') {
            live.get(ev.id)?.slot.unregister();
            live.delete(ev.id);
          } else live.get(ev.id)?.r.set(ev.r);
          check(trace[i + 1]);
        });
      }
    expect(steps).toBeGreaterThan(CFGS.length * SEEDS * 5);
  });
});
