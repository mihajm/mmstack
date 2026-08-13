import { TestBed } from '@angular/core/testing';
import { applyOps, type StoreOp } from './op-log';
import {
  createConvergingApply,
  OP_PROTO_VERSION,
  opSync,
  type ConvergingApply,
  type OpEnvelope,
  type SyncOp,
} from './op-sync';
import { store } from './store';
import {
  insertElement,
  keyedContainer,
  moveElement,
  orderedEntries,
  POS_SEGMENT as POS,
  posBetween,
  rebalanceContainer,
  removeElement,
  wrappedContainer,
  type ContainerEntry,
  type ContainerNode,
  type OrderedEntry,
} from './keyed-container';

// deterministic PRNG — reproducible, no Math.random
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle = <T>(arr: readonly T[], seed: number): T[] => {
  const r = mulberry32(seed);
  const c = [...arr];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c;
};

// ────────────────────────────────────────────────────────────────────────────
// posBetween — fractional index
// ────────────────────────────────────────────────────────────────────────────

describe('posBetween', () => {
  it('seeds a first position with no neighbors, strictly inside the open interval', () => {
    const p = posBetween();
    expect(p.length).toBeGreaterThan(0);
    expect(p > '').toBe(true);
  });

  it('produces strictly ordered head/tail inserts', () => {
    const mid = posBetween(); // first element
    const before = posBetween(undefined, mid); // prepend
    const after = posBetween(mid, undefined); // append
    expect(before < mid).toBe(true);
    expect(mid < after).toBe(true);
  });

  it('always returns a value strictly between two neighbors, never equal to either', () => {
    let lo = posBetween();
    let hi = posBetween(lo, undefined);
    for (let i = 0; i < 200; i++) {
      const m = posBetween(lo, hi);
      expect(m > lo && m < hi).toBe(true);
      expect(m).not.toBe(lo);
      expect(m).not.toBe(hi);
      // tighten the gap toward exhaustion: repeatedly insert into the SAME shrinking gap
      if (i % 2 === 0) hi = m;
      else lo = m;
    }
  });

  it('grows the string gracefully under repeated same-gap head inserts (never collapses to a degenerate key)', () => {
    let head = posBetween();
    const seen = new Set<string>([head]);
    for (let i = 0; i < 300; i++) {
      const next = posBetween(undefined, head);
      expect(next < head).toBe(true);
      expect(seen.has(next)).toBe(false);
      seen.add(next);
      head = next;
    }
  });

  it('keeps a large randomized sequence of inserts totally ordered by plain string comparison', () => {
    const r = mulberry32(99);
    const keys: string[] = [posBetween()];
    for (let i = 0; i < 500; i++) {
      const at = Math.floor(r() * (keys.length + 1));
      const lo = keys[at - 1];
      const hi = keys[at];
      const p = posBetween(lo, hi);
      keys.splice(at, 0, p);
    }
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true);
    expect(new Set(keys).size).toBe(keys.length); // all distinct
  });
});

// ────────────────────────────────────────────────────────────────────────────
// orderedEntries — (pos, key) tiebreak + fallback
// ────────────────────────────────────────────────────────────────────────────

describe('orderedEntries', () => {
  it('orders by pos, breaking equal pos by key', () => {
    const out = orderedEntries({
      b: { [POS]: '5', v: 'B' },
      a: { [POS]: '5', v: 'A' }, // same pos as b: key breaks it (a before b)
      c: { [POS]: '9', v: 'C' },
      z: { [POS]: '1', v: 'Z' },
    });
    expect(out.map((e) => e.key)).toEqual(['z', 'a', 'b', 'c']);
  });

  it('treats a missing or non-string pos as the empty string (sorts first; key breaks the tie)', () => {
    const out = orderedEntries({
      real: { [POS]: '5', v: 'R' },
      missing: { v: 'M' }, // no pos
      bad: { [POS]: 42, v: 'X' }, // non-string pos
    });
    // both fallbacks sort as pos '' (before '5'), key breaks it: 'bad' < 'missing'
    expect(out.map((e) => e.key)).toEqual(['bad', 'missing', 'real']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Impl-parity: real register (createConvergingApply) over a keyed container, run for BOTH
// representations — position inline in the element, and the element wrapped as { ~pos, value }.
// Mirrors the Part 3 proof model against the shipped stamp/ingest/materialize.
// ────────────────────────────────────────────────────────────────────────────

const LIST = ['list'];
type El = { title: string };

const inlineHelpers = keyedContainer<El>();
const wrappedHelpers = wrappedContainer<El>();

/** The two representations as the register sees them: element shape, data path, and payload read. */
type Rep = {
  readonly name: string;
  readonly element: (pos: string, title: string) => Record<string, unknown>;
  readonly titlePath: (key: string) => string[];
  readonly entries: (container: Record<string, unknown>) => OrderedEntry<unknown>[];
  readonly payload: (pos: string, title: string) => unknown;
};

const REPS: readonly Rep[] = [
  {
    name: 'inline',
    element: (pos, title) => ({ [POS]: pos, title }),
    titlePath: (key) => [...LIST, key, 'title'],
    entries: (c) => inlineHelpers.entries(c as Record<string, El>),
    payload: (pos, title) => ({ [POS]: pos, title }),
  },
  {
    name: 'wrapped',
    element: (pos, title) => ({ [POS]: pos, value: { title } }),
    titlePath: (key) => [...LIST, key, 'value', 'title'],
    entries: (c) => wrappedHelpers.entries(c as Record<string, ContainerEntry<El>>),
    payload: (_pos, title) => ({ title }),
  },
];

const containerOf = (root: unknown): Record<string, unknown> => {
  const list = (root as { list?: unknown })?.list;
  return list && typeof list === 'object' && !Array.isArray(list) ? (list as Record<string, unknown>) : {};
};
const listSig = (conv: ConvergingApply, rep: Rep): string =>
  JSON.stringify(rep.entries(containerOf(conv.materialize())).map((e) => [e.key, e.value]));
const listKeys = (conv: ConvergingApply, rep: Rep): string[] =>
  rep.entries(containerOf(conv.materialize())).map((e) => e.key);

/** the world's current container positions, for computing neighbor-relative inserts/moves. Both
 *  representations keep `~pos` at the element root, so ordering reads the same either way. */
const worldEntries = (world: ConvergingApply) => orderedEntries(containerOf(world.materialize()));

const POOL = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'];

/** a mixed keyed-container workload emitted through the REAL stamp path against a sequential world
 *  (well-formed cites/epochs/clears); tests deliver the flat envelope list in arbitrary orders. */
function genListEnvs(seed: number, rounds: number, rep: Rep): OpEnvelope[] {
  const r = mulberry32(seed);
  const world = createConvergingApply();
  const out: OpEnvelope[] = [];
  let clock = 0;
  const emit = (ops: readonly StoreOp[], writer: string, opt?: { bump?: boolean }): void => {
    const stamped = world.stamp(ops, opt);
    const e: OpEnvelope = {
      proto: OP_PROTO_VERSION,
      origin: writer,
      writer,
      version: ++clock,
      hlc: { p: clock, l: 0 },
      policyVersion: 0,
      ops: stamped,
    };
    world.ingest(e, { local: true });
    out.push(e);
  };
  const posPick = (): string => {
    const cur = worldEntries(world);
    if (cur.length && r() < 0.25) return cur[Math.floor(r() * cur.length)].pos; // deliberate pos tie
    const at = Math.floor(r() * (cur.length + 1));
    return posBetween(cur[at - 1]?.pos, cur[at]?.pos);
  };

  emit([{ kind: 'set', path: LIST, next: {} }], 'w0');
  emit([{ kind: 'set', path: [...LIST, 'k0'], next: rep.element(posBetween(), 'seed0') }], 'w0');
  emit([{ kind: 'set', path: [...LIST, 'k1'], next: rep.element(posBetween('k0'), 'seed1') }], 'w0');

  for (let i = 0; i < rounds; i++) {
    const writer = 'w' + Math.floor(r() * 3);
    const live = worldEntries(world).map((e) => e.key);
    const roll = r();
    if (roll < 0.3 || live.length === 0) {
      const k = POOL[Math.floor(r() * POOL.length)];
      emit([{ kind: 'set', path: [...LIST, k], next: rep.element(posPick(), `${writer}:${i}`) }], writer);
    } else if (roll < 0.5) {
      const k = live[Math.floor(r() * live.length)];
      emit([{ kind: 'set', path: [...LIST, k, POS], next: posPick() }], writer);
    } else if (roll < 0.68) {
      const k = live[Math.floor(r() * live.length)];
      emit([{ kind: 'set', path: rep.titlePath(k), next: `edit:${writer}:${i}` }], writer);
    } else if (roll < 0.82) {
      const k = live[Math.floor(r() * live.length)];
      emit([{ kind: 'delete', path: [...LIST, k], prev: undefined }], writer);
    } else if (roll < 0.92) {
      const value: Record<string, unknown> = {};
      let p: string | undefined = undefined;
      for (const k of live) {
        if (r() < 0.7) {
          p = posBetween(p, undefined);
          value[k] = rep.element(p, `rw:${writer}:${i}:${k}`);
        }
      }
      const fresh = POOL[Math.floor(r() * POOL.length)];
      p = posBetween(p, undefined);
      value[fresh] = rep.element(p, `rw-new:${writer}:${i}`);
      emit([{ kind: 'set', path: LIST, next: value }], writer);
    } else {
      // rebalance: one bumped set per element at [C, k, POS], all in one envelope
      let p: string | undefined = undefined;
      const ops: StoreOp[] = worldEntries(world).map((e) => {
        p = posBetween(p, undefined);
        return { kind: 'set', path: [...LIST, e.key, POS], next: p };
      });
      if (ops.length) emit(ops, writer, { bump: true });
    }
  }
  return out;
}

const run = (envs: readonly OpEnvelope[], seed: number): ConvergingApply => {
  const conv = createConvergingApply();
  let root: unknown = {};
  for (const e of shuffle(envs, seed)) root = applyOps(root, conv.ingest(e));
  // materialize() is the register-derived tree; drive both surfaces to keep them coherent
  void root;
  return conv;
};

describe.each(REPS)(
  'PROPERTY: real register + orderedEntries converge over a keyed container ($name, impl parity)',
  (rep) => {
    it('identical ordered list (keys AND values) across arrival orders, split + duplicated (20 seeds x 6 orders)', () => {
      for (let seed = 1; seed <= 20; seed++) {
        const envs = genListEnvs(seed * 47, 22, rep);
        const expected = listSig(run(envs, 1), rep);
        for (let order = 2; order <= 6; order++) {
          expect(listSig(run(envs, order + seed * 11), rep)).toBe(expected);
        }
        // split every group into one op per envelope, then duplicate half the stream
        const split = envs.flatMap((e) => e.ops.map((op) => ({ ...e, ops: [op] })));
        const dup = [...split, ...split.slice(0, Math.floor(split.length / 2))];
        expect(listSig(run(split, seed * 7), rep)).toBe(expected);
        expect(listSig(run(dup, seed * 29), rep)).toBe(expected);
      }
    });

    it('vacuity guard: the workload exercises every op class and leaves populated lists', () => {
      const editDepth = rep.titlePath('k').length;
      let inserts = 0, moves = 0, edits = 0, deletes = 0, rewrites = 0, rebalances = 0, clears = 0, populated = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const envs = genListEnvs(seed * 47, 22, rep);
        for (const e of envs) {
          const posSets = e.ops.filter((o) => o.kind === 'set' && o.path[o.path.length - 1] === POS);
          if (e.ops.length >= 2 && posSets.length === e.ops.length && posSets.length >= 2) rebalances++;
          for (const o of e.ops) {
            const depth = o.path.length;
            const last = o.path[depth - 1];
            if (o.kind === 'clear') clears++;
            else if (o.kind === 'delete' && depth === 2) deletes++;
            else if (o.kind === 'set' && depth === 2) inserts++;
            else if (o.kind === 'set' && depth === 3 && last === POS) moves++;
            else if (o.kind === 'set' && depth === editDepth && last === 'title') edits++;
            else if (o.kind === 'set' && depth === 1 && e.version > 1) rewrites++;
          }
        }
        if (listKeys(run(envs, 1), rep).length >= 2) populated++;
      }
      for (const n of [inserts, moves, edits, deletes, rewrites, rebalances, clears]) {
        expect(n).toBeGreaterThan(0);
      }
      expect(populated).toBeGreaterThanOrEqual(10);
    });
  },
);

// ────────────────────────────────────────────────────────────────────────────
// Targeted convergence obligations (mirroring the Part 3 LIST proofs on the real register)
// ────────────────────────────────────────────────────────────────────────────

/** A small hand-authored scenario against one world. `emit` stamps AND ingests (a sequential,
 *  observed write). `stamp` stamps WITHOUT ingesting, so several `stamp` calls all observe the same
 *  world state and land as genuine concurrent siblings (stamp only reads register state; the floors
 *  and registers move at ingest). */
function scenario(rep: Rep): {
  world: ConvergingApply;
  base: OpEnvelope[];
  emit: (ops: readonly StoreOp[], writer: string, opt?: { bump?: boolean }) => OpEnvelope;
  stamp: (ops: readonly StoreOp[], writer: string, opt?: { bump?: boolean }) => OpEnvelope;
} {
  const world = createConvergingApply();
  const base: OpEnvelope[] = [];
  let clock = 0;
  const wrap = (ops: readonly StoreOp[], writer: string, opt?: { bump?: boolean }): OpEnvelope => ({
    proto: OP_PROTO_VERSION,
    origin: writer,
    writer,
    version: ++clock,
    hlc: { p: clock, l: 0 },
    policyVersion: 0,
    ops: world.stamp(ops, opt),
  });
  const emit = (ops: readonly StoreOp[], writer: string, opt?: { bump?: boolean }): OpEnvelope => {
    const e = wrap(ops, writer, opt);
    world.ingest(e, { local: true });
    base.push(e);
    return e;
  };
  emit([{ kind: 'set', path: LIST, next: {} }], 'w0');
  emit([{ kind: 'set', path: [...LIST, 'a'], next: rep.element('3', 'A') }], 'w0');
  emit([{ kind: 'set', path: [...LIST, 'b'], next: rep.element('6', 'B') }], 'w0');
  return { world, base, emit, stamp: wrap };
}

const convergedList = (envs: readonly OpEnvelope[], rep: Rep, orders = 6): ConvergingApply => {
  const expected = listSig(run(envs, 1), rep);
  for (let o = 2; o <= orders; o++) expect(listSig(run(envs, o * 7 + 3), rep)).toBe(expected);
  return run(envs, 1);
};

describe.each(REPS)('KEYED CONTAINER obligations on the real register ($name)', (rep) => {
  it('move vs data edit (disjoint paths) both survive; order follows the move', () => {
    const { stamp, base } = scenario(rep);
    const move = stamp([{ kind: 'set', path: [...LIST, 'a', POS], next: '9' }], 'w1'); // a after b
    const edit = stamp([{ kind: 'set', path: rep.titlePath('a'), next: 'edited' }], 'w2');
    const conv = convergedList([...base, move, edit], rep);
    const a = rep.entries(containerOf(conv.materialize())).find((e) => e.key === 'a');
    expect(a?.pos).toBe('9');
    expect(a?.value).toEqual(rep.payload('9', 'edited'));
    expect(listKeys(conv, rep)).toEqual(['b', 'a']);
  });

  it('un-bumped whole-list rewrite SPARES a concurrent element edit (grafted into the new list)', () => {
    const { stamp, base } = scenario(rep);
    const edit = stamp([{ kind: 'set', path: rep.titlePath('a'), next: 'edited' }], 'w1');
    // rewrite keeps a (new pos), drops b, adds c; NOT bumped, so its clears do not kill the edit
    const rewrite = stamp(
      [{ kind: 'set', path: LIST, next: { a: rep.element('2', 'A2'), c: rep.element('5', 'C') } }],
      'w2',
    );
    const conv = convergedList([...base, edit, rewrite], rep);
    const entries = rep.entries(containerOf(conv.materialize()));
    expect(entries.map((e) => e.key)).toEqual(['a', 'c']); // b gone
    expect(entries[0].value).toEqual(rep.payload('2', 'edited')); // new list, your edit
    expect(entries[1].value).toEqual(rep.payload('5', 'C'));
  });

  it('bumped rebalance KILLS a concurrent move but LEAVES a concurrent data edit', () => {
    const { stamp, base } = scenario(rep);
    const reb = stamp(
      [
        { kind: 'set', path: [...LIST, 'a', POS], next: '1' },
        { kind: 'set', path: [...LIST, 'b', POS], next: '2' },
      ],
      'admin',
      { bump: true },
    );
    const move = stamp([{ kind: 'set', path: [...LIST, 'a', POS], next: 'z' }], 'w1'); // higher hlc, epoch 0
    const edit = stamp([{ kind: 'set', path: rep.titlePath('b'), next: 'kept' }], 'w2');
    const conv = convergedList([...base, reb, move, edit], rep);
    const entries = rep.entries(containerOf(conv.materialize()));
    const a = entries.find((e) => e.key === 'a');
    const b = entries.find((e) => e.key === 'b');
    expect(a?.pos).toBe('1'); // rebalanced pos won over the higher-hlc move (epoch outermost)
    expect(b?.pos).toBe('2');
    expect(b?.value).toEqual(rep.payload('2', 'kept')); // rebalanced pos AND the edit both present
    expect(entries.map((e) => e.key)).toEqual(['a', 'b']);
  });

  it('element delete WINS the [C,k] race; the orphan pos register REVIVES on a re-create that did not observe the move', () => {
    const { emit, stamp, base } = scenario(rep);
    const move0 = emit([{ kind: 'set', path: [...LIST, 'a', POS], next: '4' }], 'w0'); // real POS register
    // move + del both observe move0 (so both supersede it) but NOT each other: genuine concurrency
    const move = stamp([{ kind: 'set', path: [...LIST, 'a', POS], next: '8' }], 'w1');
    const del = stamp([{ kind: 'delete', path: [...LIST, 'a'], prev: undefined }], 'w2'); // delete + clears
    const conv0 = convergedList([...base, move0, move, del], rep);
    expect(listKeys(conv0, rep)).toEqual(['b']); // delete cited the element → gone

    // re-create citing only the tombstone (did NOT observe the orphan move): the orphan pos resurfaces
    const recreate: OpEnvelope = {
      proto: OP_PROTO_VERSION,
      origin: 'w3',
      writer: 'w3',
      version: 1,
      hlc: { p: 30, l: 0 },
      policyVersion: 0,
      ops: [
        {
          kind: 'set',
          path: [...LIST, 'a'],
          next: rep.element('7', 're'),
          cites: [{ origin: del.origin, hlc: del.hlc }], // cites the tombstone only
          epoch: 1,
        },
      ],
    };
    const revived = convergedList([...base, move0, move, del, recreate], rep);
    const a = rep.entries(containerOf(revived.materialize())).find((e) => e.key === 'a');
    expect(a?.pos).toBe('8'); // orphan pos 8 resurfaced over the re-create's 7
    expect(a?.value).toEqual(rep.payload('8', 're'));
  });

  it('duplicate delivery of whole insert/delete/rebalance groups is idempotent', () => {
    const { emit, base } = scenario(rep);
    const edit = emit([{ kind: 'set', path: rep.titlePath('a'), next: 'edited' }], 'w1');
    const reins = emit([{ kind: 'set', path: [...LIST, 'a'], next: rep.element('4', 'A2') }], 'w2');
    const del = emit([{ kind: 'delete', path: [...LIST, 'b'], prev: undefined }], 'w1');
    const all = [...base, edit, reins, del];
    const once = listSig(run(all, 1), rep);
    for (let order = 1; order <= 5; order++) {
      expect(listSig(run([...all, reins, del, del], order * 13 + 1), rep)).toBe(once);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Write helpers over a REAL store + opSync: element-granular ops, pos-only move, bumped rebalance
// ────────────────────────────────────────────────────────────────────────────

describe('write helpers over a real store + opSync', () => {
  function setup(initial: Record<string, El & { [POS]?: string }>) {
    return TestBed.runInInjectionContext(() => {
      const s = store<{ list: Record<string, El> }>({ list: initial });
      const sync = opSync(s, { writer: 'w' });
      const emitted: OpEnvelope[] = [];
      sync.subscribe((e) => emitted.push(e));
      const node = s.list as unknown as ContainerNode<El>;
      return { s, sync, emitted, node };
    });
  }

  it('insert adds a per-key element and reads back in order', () => {
    const { node, sync, emitted } = setup({ a: { [POS]: '3', title: 'A' } as El });
    insertElement(node, 'c', { title: 'C' }, 1); // append after a
    insertElement(node, 'b', { title: 'B' }, 0); // prepend before a
    sync.flush();
    const flat = emitted.flatMap((e) => e.ops);
    expect(flat.every((o) => o.kind === 'set' && o.path[0] === 'list' && o.path.length === 2)).toBe(true);
    expect(orderedEntries(node()).map((e) => e.key)).toEqual(['b', 'a', 'c']);
  });

  it('move writes ONLY the [list, k, ~pos] path (never conflicts with a data edit)', () => {
    const { node, sync, emitted } = setup({
      a: { [POS]: '3', title: 'A' } as El,
      b: { [POS]: '6', title: 'B' } as El,
    });
    moveElement(node, 'a', 2); // a to the end
    sync.flush();
    const flat = emitted.flatMap((e) => e.ops);
    expect(flat.length).toBe(1);
    expect(flat[0].path).toEqual(['list', 'a', POS]);
    expect(orderedEntries(node()).map((e) => e.key)).toEqual(['b', 'a']);
  });

  it('remove deletes the whole element at its key', () => {
    const { node, sync, emitted } = setup({
      a: { [POS]: '3', title: 'A' } as El,
      b: { [POS]: '6', title: 'B' } as El,
    });
    removeElement(node, 'a');
    sync.flush();
    const flat = emitted.flatMap((e) => e.ops);
    expect(flat.some((o) => o.kind === 'delete' && o.path.join('/') === 'list/a')).toBe(true);
    expect(Object.keys(node())).toEqual(['b']);
  });

  it('rebalance emits a pos-only, epoch-bumped sweep and preserves order', () => {
    const { node, sync, emitted } = setup({
      a: { [POS]: '3', title: 'A' } as El,
      b: { [POS]: '6', title: 'B' } as El,
      c: { [POS]: '9', title: 'C' } as El,
    });
    const before = orderedEntries(node()).map((e) => e.key);
    rebalanceContainer(sync, node);
    sync.flush();
    const flat = emitted.flatMap((e) => e.ops) as SyncOp[];
    expect(flat.length).toBe(3);
    expect(flat.every((o) => o.kind === 'set' && o.path[o.path.length - 1] === POS)).toBe(true);
    expect(flat.every((o) => (o.epoch ?? 0) >= 1)).toBe(true); // authority-bumped
    expect(orderedEntries(node()).map((e) => e.key)).toEqual(before); // order preserved
  });
});

// ────────────────────────────────────────────────────────────────────────────
// The wrapped flavour's write paths, and the key extractor, over a real store + opSync
// ────────────────────────────────────────────────────────────────────────────

type Entry = ContainerEntry<El>;
const entry = (pos: string, title: string): Entry => ({ [POS]: pos, value: { title } });

function setupWrapped(initial: Record<string, Entry>) {
  return TestBed.runInInjectionContext(() => {
    const s = store<{ list: Record<string, Entry> }>({ list: initial });
    const sync = opSync(s, { writer: 'w' });
    const emitted: OpEnvelope[] = [];
    sync.subscribe((e) => emitted.push(e));
    const node = s.list as unknown as ContainerNode<Entry>;
    return { s, sync, emitted, node, ops: () => emitted.flatMap((e) => e.ops) };
  });
}

describe('wrapped container write paths', () => {
  const helpers = wrappedContainer<El>();

  it('insert sets the ENTIRE wrapper at [list, key] and reads back the payload in order', () => {
    const { node, sync, ops } = setupWrapped({ a: entry('3', 'A') });
    const pos = helpers.insert(node, 'b', { title: 'B' }, 0); // prepend
    sync.flush();
    expect(ops().length).toBe(1);
    expect(ops()[0].kind).toBe('set');
    expect(ops()[0].path).toEqual(['list', 'b']);
    expect((ops()[0] as { next?: unknown }).next).toEqual({ [POS]: pos, value: { title: 'B' } });
    expect(helpers.entries(node())).toEqual([
      { key: 'b', pos, value: { title: 'B' } },
      { key: 'a', pos: '3', value: { title: 'A' } },
    ]);
  });

  it('move writes ONLY [list, key, ~pos] — never the wrapper or the payload', () => {
    const { node, sync, ops } = setupWrapped({ a: entry('3', 'A'), b: entry('6', 'B') });
    helpers.move(node, 'a', 2);
    sync.flush();
    expect(ops().length).toBe(1);
    expect(ops()[0].path).toEqual(['list', 'a', POS]);
    expect(helpers.entries(node()).map((e) => e.key)).toEqual(['b', 'a']);
    expect(helpers.entries(node()).map((e) => e.value)).toEqual([{ title: 'B' }, { title: 'A' }]);
  });

  it('a payload edit lands at [list, key, value, field] — disjoint from any move', () => {
    const { node, sync, ops } = setupWrapped({ a: entry('3', 'A') });
    node.update((c) => ({ ...c, a: { ...c['a'], value: { title: 'edited' } } }));
    sync.flush();
    expect(ops().length).toBe(1);
    expect(ops()[0].path).toEqual(['list', 'a', 'value', 'title']);
  });

  it('remove deletes exactly [list, key]', () => {
    const { node, sync, ops } = setupWrapped({ a: entry('3', 'A'), b: entry('6', 'B') });
    helpers.remove(node, 'a');
    sync.flush();
    expect(ops().length).toBe(1);
    expect(ops()[0].kind).toBe('delete');
    expect(ops()[0].path).toEqual(['list', 'a']);
    expect(Object.keys(node())).toEqual(['b']);
  });

  it('rebalance sweeps positions only, epoch-bumped, leaving every payload untouched', () => {
    const { node, sync, emitted } = setupWrapped({
      a: entry('3', 'A'),
      b: entry('6', 'B'),
      c: entry('9', 'C'),
    });
    const before = helpers.entries(node());
    helpers.rebalance(sync, node);
    sync.flush();
    const flat = emitted.flatMap((e) => e.ops) as SyncOp[];
    expect(flat.length).toBe(3);
    expect(flat.every((o) => o.kind === 'set' && o.path[o.path.length - 1] === POS)).toBe(true);
    expect(flat.every((o) => (o.epoch ?? 0) >= 1)).toBe(true);
    const after = helpers.entries(node());
    expect(after.map((e) => e.key)).toEqual(before.map((e) => e.key));
    expect(after.map((e) => e.value)).toEqual(before.map((e) => e.value));
    expect(after.map((e) => e.pos)).not.toEqual(before.map((e) => e.pos));
  });

  it('leaves a payload that carries its own ~pos field alone, and orders by the ENTRY position', () => {
    type Odd = { [POS]: string; title: string };
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // control: inline, where `~pos` IS the element's position, the same value is a caller error
    const inlineNode = setupWrapped({}).node as unknown as ContainerNode<Odd>;
    insertElement(inlineNode, 'a', { [POS]: 'zzz', title: 'A' });
    expect(warn).toHaveBeenCalled();
    warn.mockClear();

    const odd = wrappedContainer<Odd>();
    const oddNode = setupWrapped({}).node as unknown as ContainerNode<ContainerEntry<Odd>>;
    odd.insert(oddNode, 'a', { [POS]: 'zzz', title: 'A' });
    odd.insert(oddNode, 'b', { [POS]: 'aaa', title: 'B' });
    expect(warn).not.toHaveBeenCalled(); // wrapped: `~pos` is an ordinary payload field
    warn.mockRestore();
    expect(odd.entries(oddNode()).map((e) => e.key)).toEqual(['a', 'b']); // entry order, not 'aaa' < 'zzz'
    expect(odd.entries(oddNode())[0].value).toEqual({ [POS]: 'zzz', title: 'A' }); // payload verbatim
  });
});

describe('key extractor', () => {
  type Item = { id: string; title: string };

  it('derives the key from the value, extracting exactly once per insertion', () => {
    let calls = 0;
    const helpers = wrappedContainer({
      key: (v: Item) => {
        calls++;
        return v.id;
      },
    });
    const { node, sync, ops } = setupWrapped({});
    const items = node as unknown as ContainerNode<ContainerEntry<Item>>;
    const pos = helpers.insert(items, { id: 'x', title: 'X' });
    sync.flush();
    expect(calls).toBe(1);
    expect(ops()[0].path).toEqual(['list', 'x']);
    expect(items()['x']).toEqual({ [POS]: pos, value: { id: 'x', title: 'X' } });
  });

  it('overwrites on a duplicate key, taking a fresh position at the requested index', () => {
    const helpers = wrappedContainer({ key: (v: Item) => v.id });
    const { node } = setupWrapped({});
    const items = node as unknown as ContainerNode<ContainerEntry<Item>>;
    helpers.insert(items, { id: 'a', title: 'A' });
    helpers.insert(items, { id: 'b', title: 'B' });
    helpers.insert(items, { id: 'c', title: 'C' });
    helpers.insert(items, { id: 'c', title: 'C2' }, 0); // same identity, to the front
    expect(helpers.entries(items()).map((e) => e.key)).toEqual(['c', 'a', 'b']);
    expect(helpers.entries(items()).map((e) => e.value.title)).toEqual(['C2', 'A', 'B']);
    // the index counts the OTHER elements, so re-inserting at their end lands last
    helpers.insert(items, { id: 'c', title: 'C3' }, 2);
    expect(helpers.entries(items()).map((e) => e.key)).toEqual(['a', 'b', 'c']);
  });

  it('works the same for the inline flavour, keeping identity in the payload', () => {
    const helpers = keyedContainer({ key: (v: Item) => v.id });
    const { node } = setupWrapped({});
    const items = node as unknown as ContainerNode<Item>;
    const pos = helpers.insert(items, { id: 'x', title: 'X' }, 0);
    expect(items()['x']).toEqual({ [POS]: pos, id: 'x', title: 'X' });
  });
});
