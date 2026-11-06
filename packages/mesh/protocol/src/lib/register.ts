import type {
  Dot,
  Hlc,
  Key,
  OpEnvelope,
  RegisterCheckpoint,
  SyncSibling,
} from './wire';

const SEP = ''; // unit separator: keeps joined path keys prefix-unambiguous
const keyOf = (path: readonly Key[]): string => path.map(String).join(SEP);

/**
 * The register identity of a path: its segments as strings, joined with the unit separator. The
 * key of the generation record's `extent`. Sound only for paths `validateEnvelope` accepts (no
 * empty segment, no control character), and the root's key is the empty string.
 */
export const pathKey = keyOf;

/** The frozen extent of a seed: per register path key, per origin, the highest retained stamp. */
export function extentOf(
  seed: readonly RegisterCheckpoint[],
): Record<string, Record<string, Hlc>> {
  const out: Record<string, Record<string, Hlc>> = {};
  for (const r of seed) {
    const at = (out[keyOf(r.path)] ??= {});
    for (const s of r.siblings) {
      const cur = at[s.origin];
      if (!cur || compareHlc(s.hlc, cur) > 0) at[s.origin] = s.hlc;
    }
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
/** Does `value` hold the relative path `rel` (every step an own key of an object)? */
const contains = (value: unknown, rel: readonly Key[]): boolean => {
  let cur = value;
  for (const seg of rel) {
    if (!isObj(cur) || !Object.hasOwn(cur, String(seg))) return false;
    cur = cur[String(seg)];
  }
  return true;
};

/**
 * A sibling as the register keeps it: only a `set` keeps `prev` (a merge fold's ancestor). A
 * checkpoint written before that rule may hold a delete sibling with the whole deleted record as
 * `prev`; loading it drops the field, so the next checkpoint no longer carries it.
 */
const retained = (s: SyncSibling): SyncSibling => {
  if (s.kind === 'set' || !Object.hasOwn(s, 'prev')) return s;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { prev: _dropped, ...rest } = s;
  return rest;
};

const compareHlc = (a: Hlc, b: Hlc): number =>
  a.p !== b.p ? a.p - b.p : a.l - b.l;

type Reg = {
  readonly path: readonly Key[];
  readonly siblings: Map<string, SyncSibling>;
  readonly water: Map<string, Hlc>;
};

/**
 * The relay's per-room register retention. It runs the same pure ingest rules a client's
 * register runs (per path, keep the best op per origin plus the per-origin citation
 * watermarks; live means above-watermark) and NOTHING else: it never resolves a conflict
 * and never materializes a value. Conflict resolution (the fold) is client-configured
 * policy, so a relay that folded values would seed joiners with one client's semantics;
 * retention is uniform and policy-free, and identical register state folds identically on
 * every client.
 */
export type RegisterStore = {
  /** Fold one sequenced envelope's ops into the per-path registers (retention only). */
  ingest(env: OpEnvelope): void;
  /** Serializable register state for a welcome snapshot or a persistence checkpoint. */
  checkpoint(): RegisterCheckpoint[];
  /** Merge checkpointed register state in (idempotent): the hydrate path. */
  load(registers: readonly RegisterCheckpoint[]): void;
  /**
   * Effect-preserving garbage collection `settled[o]` is the stamp of origin `o`'s last contiguously admitted version: nothing new
   * from `o` at or below it can arrive, and anything that does is a duplicate the relay refuses.
   * Drops a superseded sibling `(o, h)` only when `h ≤ settled[o]` (and it is covered), and a
   * watermark `water[o] = w` only when `w ≤ settled[o]`. Never drops a tombstone. A register
   * with nothing left goes.
   */
  settle(settled: Readonly<Record<string, Hlc>>): void;
  /** Drop all register state (a migration establishes a fresh retention window). */
  reset(): void;
  /**
   * The live retained siblings at `path`: every origin's best op there that no citation has
   * superseded, in no particular order. This is the register as the relay holds it, UNFOLDED:
   * two live siblings are a conflict the clients resolve, not a value. An admission rule that
   * reads it must hold for every sibling it could be looking at (refuse when any one would make
   * the write illegitimate), never pick a winner. Empty where nothing is retained.
   */
  siblings(path: readonly Key[]): readonly SyncSibling[];
  /**
   * The max epoch across ALL retained siblings at `path` (0 when nothing is retained): the
   * room's observed epoch, the baseline an admission gate compares an incoming op's epoch
   * against. Superseded siblings count too, so a carry that superseded the
   * bump it cites never lowers the observed max, and neither does garbage collection: the
   * baseline is kept apart from the siblings and reset only with the room.
   */
  maxEpoch(path: readonly Key[]): number;
  /**
   * Does the retained state at `path` cover `dot` — is it at or below that origin's known
   * extent there? True when the origin's retained sibling or its supersession watermark sits
   * at or above the dot's stamp. Every op sequenced into the room leaves such a trace until
   * `settle` collects it, so above the origin's settled stamp a cite of an uncovered dot is a
   * forgery (or an op the relay never saw). A per-origin extent, not admission evidence for
   * one dot: a later write from the same origin at the path answers yes as well.
   */
  covers(path: readonly Key[], dot: Dot): boolean;
  /**
   * May a compaction cut drop the register at `path`? Only when no fold can observe it: it holds
   * no live `set`, at most one live sibling that is not a `clear`, no register below it holds a
   * live `set`, and, when it holds a live `delete`, no live `set` at a proper ancestor has a value
   * containing the path. Decided on retention alone: no fold, no winner. True where nothing is
   * retained.
   */
  droppable(path: readonly Key[]): boolean;
  /**
   * The seed of a compaction cut: every register that is not {@link droppable}, with its live
   * siblings (original dots, full identity), no watermarks, and its epoch baseline when above 0.
   */
  compactionSeed(): RegisterCheckpoint[];
  /**
   * The registers a compaction cut would drop that hold exactly one retained sibling, a `delete`,
   * and no watermark: the count a tombstone budget is held against. Maintained as the store
   * changes; equal to a full scan by construction.
   */
  droppableTombstones(): number;
  /** The registers a compaction cut would keep: the size of its seed. Maintained like the count. */
  keptRegisters(): number;
};

export function createRegisterStore(): RegisterStore {
  const registers = new Map<string, Reg>();
  /** Epoch baseline per path (C4): raised on ingest and load, never lowered by collection. */
  const epochs = new Map<
    string,
    { readonly path: readonly Key[]; epoch: number }
  >();
  const raiseEpoch = (path: readonly Key[], epoch: number): void => {
    if (epoch <= 0) return;
    const key = keyOf(path);
    const cur = epochs.get(key);
    if (!cur) epochs.set(key, { path, epoch });
    else if (epoch > cur.epoch) cur.epoch = epoch;
  };

  // The cut's keep rule depends on a register's own live siblings, on the registers below it
  // (a live `set` there) and on the live `set` values above it. A path tree indexes both
  // directions, so a write reclassifies only its path's ancestors and descendants.
  type Node = { readonly children: Set<string>; setBelow: number };
  const nodes = new Map<string, Node>();
  const liveSet = new Map<string, boolean>();
  const cls = new Map<string, { kept: boolean; lone: boolean }>();
  let tombstones = 0;
  let keptCount = 0;

  /** The keys of every proper prefix of `path`, root first. */
  const prefixKeys = (path: readonly Key[]): string[] => {
    const out: string[] = [];
    let key = '';
    for (let i = 0; i < path.length; i++) {
      out.push(key);
      key = i === 0 ? String(path[0]) : key + SEP + String(path[i]);
    }
    return out;
  };
  const ensureNode = (path: readonly Key[]): void => {
    let parent: Node | undefined;
    for (const key of [...prefixKeys(path), keyOf(path)]) {
      let node = nodes.get(key);
      if (!node) nodes.set(key, (node = { children: new Set(), setBelow: 0 }));
      parent?.children.add(key);
      parent = node;
    }
  };

  const regAt = (path: readonly Key[]): Reg => {
    const key = keyOf(path);
    let reg = registers.get(key);
    if (!reg) {
      reg = { path, siblings: new Map(), water: new Map() };
      registers.set(key, reg);
      ensureNode(path);
    }
    return reg;
  };

  const liveOf = (reg: Reg | undefined): SyncSibling[] => {
    if (!reg) return [];
    const live: SyncSibling[] = [];
    for (const s of reg.siblings.values()) {
      const w = reg.water.get(s.origin);
      if (!w || compareHlc(s.hlc, w) > 0) live.push(s);
    }
    return live;
  };
  /** A live `set` at a proper ancestor whose value contains `path`. */
  const masked = (path: readonly Key[]): boolean =>
    prefixKeys(path).some((key, i) =>
      liveOf(registers.get(key)).some(
        (s) => s.kind === 'set' && contains(s.value, path.slice(i)),
      ),
    );
  const keeps = (path: readonly Key[], live: readonly SyncSibling[]): boolean =>
    live.length > 0 &&
    (live.some((s) => s.kind === 'set') ||
      (nodes.get(keyOf(path))?.setBelow ?? 0) > 0 ||
      (live.some((s) => s.kind === 'delete') && masked(path)) ||
      live.filter((s) => s.kind !== 'clear').length >= 2);

  /** Records whether the register holds a live `set`, carrying a change to every ancestor. */
  const refreshLiveSet = (key: string): void => {
    const reg = registers.get(key);
    const now = liveOf(reg).some((s) => s.kind === 'set');
    if ((liveSet.get(key) ?? false) === now) return;
    if (reg && now) liveSet.set(key, true);
    else liveSet.delete(key);
    for (const up of prefixKeys(reg?.path ?? [])) {
      const node = nodes.get(up);
      if (node) node.setBelow += now ? 1 : -1;
    }
  };
  const classify = (key: string): void => {
    const prev = cls.get(key);
    if (prev?.kept) keptCount--;
    if (prev?.lone) tombstones--;
    const reg = registers.get(key);
    if (!reg) {
      cls.delete(key);
      return;
    }
    const kept = keeps(reg.path, liveOf(reg));
    const only =
      reg.siblings.size === 1 ? [...reg.siblings.values()][0] : undefined;
    const lone = !kept && only?.kind === 'delete' && reg.water.size === 0;
    cls.set(key, { kept, lone });
    if (kept) keptCount++;
    if (lone) tombstones++;
  };
  const below = (key: string, out: Set<string>): void => {
    for (const child of nodes.get(key)?.children ?? []) {
      out.add(child);
      below(child, out);
    }
  };
  /** Reclassify after `touched` changed: their ancestors and descendants are the only others. */
  const reclassify = (touched: ReadonlyMap<string, readonly Key[]>): void => {
    for (const key of touched.keys()) refreshLiveSet(key);
    const affected = new Set<string>();
    for (const [key, path] of touched) {
      affected.add(key);
      for (const up of prefixKeys(path)) affected.add(up);
      below(key, affected);
    }
    for (const key of affected) if (registers.has(key)) classify(key);
  };
  /** The full scan: every register reclassified from nothing. */
  const recount = (): void => {
    nodes.clear();
    liveSet.clear();
    cls.clear();
    tombstones = 0;
    keptCount = 0;
    for (const reg of registers.values()) ensureNode(reg.path);
    for (const key of registers.keys()) refreshLiveSet(key);
    for (const key of registers.keys()) classify(key);
  };

  return {
    ingest: (env) => {
      const touched = new Map<string, readonly Key[]>();
      for (const op of env.ops) {
        // a delete or clear at the root has no parent register to abstain to; retaining one would
        // ship register state a client can only materialize as a blanked document, so drop it
        if (!op.path.length && op.kind !== 'set') continue;
        const reg = regAt(op.path);
        touched.set(keyOf(op.path), op.path);
        raiseEpoch(op.path, op.epoch ?? 0);
        for (const c of op.cites ?? []) {
          // a self-citation would born-dead the write; ignore it (matches the client register)
          if (c.origin === env.origin && compareHlc(c.hlc, env.hlc) === 0)
            continue;
          const cur = reg.water.get(c.origin);
          if (!cur || compareHlc(c.hlc, cur) > 0)
            reg.water.set(c.origin, c.hlc);
        }
        const best = reg.siblings.get(env.origin);
        if (!best || compareHlc(env.hlc, best.hlc) > 0) {
          const sib: { -readonly [K in keyof SyncSibling]: SyncSibling[K] } = {
            kind: op.kind,
            writer: env.writer,
            origin: env.origin,
            hlc: env.hlc,
            epoch: op.epoch ?? 0,
          };
          if (op.kind === 'set') sib.value = op.next;
          // the op keeps `prev` for its emitter's inversion; the room keeps it on a set only
          if (op.kind === 'set' && Object.hasOwn(op, 'prev')) {
            sib.prev = op.prev;
          }
          reg.siblings.set(env.origin, sib);
        }
      }
      reclassify(touched);
    },

    checkpoint: () => {
      const out: RegisterCheckpoint[] = [];
      for (const [key, reg] of registers) {
        const base = epochs.get(key);
        out.push({
          path: reg.path,
          siblings: [...reg.siblings.values()],
          water: Object.fromEntries(reg.water),
          ...(base ? { epoch: base.epoch } : {}),
        });
      }
      // a baseline outlives its register: nothing retained there any more, the policy answer stays
      for (const [key, base] of epochs) {
        if (!registers.has(key)) {
          out.push({
            path: base.path,
            siblings: [],
            water: {},
            epoch: base.epoch,
          });
        }
      }
      return out;
    },

    load: (regs) => {
      for (const r of regs) {
        raiseEpoch(r.path, r.epoch ?? 0);
        for (const s of r.siblings) raiseEpoch(r.path, s.epoch);
        if (r.siblings.length === 0 && Object.keys(r.water).length === 0)
          continue;
        const reg = regAt(r.path);
        for (const s of r.siblings) {
          const cur = reg.siblings.get(s.origin);
          if (!cur || compareHlc(s.hlc, cur.hlc) > 0) {
            reg.siblings.set(s.origin, retained(s));
          }
        }
        for (const [origin, h] of Object.entries(r.water)) {
          const cur = reg.water.get(origin);
          if (!cur || compareHlc(h, cur) > 0) reg.water.set(origin, h);
        }
      }
      recount();
    },

    settle: (settled) => {
      for (const [key, reg] of [...registers]) {
        for (const [origin, s] of [...reg.siblings]) {
          const w = reg.water.get(origin);
          const done = settled[origin];
          if (
            w &&
            done &&
            compareHlc(s.hlc, w) <= 0 &&
            compareHlc(s.hlc, done) <= 0
          ) {
            reg.siblings.delete(origin);
          }
        }
        for (const [origin, h] of [...reg.water]) {
          const done = settled[origin];
          if (done && compareHlc(h, done) <= 0) reg.water.delete(origin);
        }
        if (reg.siblings.size === 0 && reg.water.size === 0) {
          registers.delete(key);
        }
      }
      recount();
    },
    reset: () => {
      registers.clear();
      epochs.clear();
      recount();
    },

    siblings: (path) => liveOf(registers.get(keyOf(path))),

    maxEpoch: (path) => {
      const key = keyOf(path);
      let max = epochs.get(key)?.epoch ?? 0;
      const reg = registers.get(key);
      if (!reg) return max;
      for (const s of reg.siblings.values()) if (s.epoch > max) max = s.epoch;
      return max;
    },

    covers: (path, dot) => {
      const reg = registers.get(keyOf(path));
      if (!reg) return false;
      const s = reg.siblings.get(dot.origin);
      if (s && compareHlc(dot.hlc, s.hlc) <= 0) return true;
      const w = reg.water.get(dot.origin);
      return !!w && compareHlc(dot.hlc, w) <= 0;
    },

    droppable: (path) => !keeps(path, liveOf(registers.get(keyOf(path)))),

    compactionSeed: () => {
      const seed: RegisterCheckpoint[] = [];
      for (const [key, reg] of registers) {
        const live = liveOf(reg);
        if (!keeps(reg.path, live)) continue;
        let epoch = epochs.get(key)?.epoch ?? 0;
        for (const s of reg.siblings.values())
          if (s.epoch > epoch) epoch = s.epoch;
        seed.push({
          path: reg.path,
          siblings: live,
          water: {},
          ...(epoch > 0 ? { epoch } : {}),
        });
      }
      return seed;
    },

    droppableTombstones: () => tombstones,
    keptRegisters: () => keptCount,
  };
}
