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
   * Compaction at the retention frontier (the stamp the journal no longer covers): drops
   * superseded siblings and stale watermarks at or below it, and drops a register whose live
   * set is a lone tombstone below it, but only when nothing else still materializes that
   * key (no live descendant register, and no live ancestor `set` value containing it), so a
   * dropped tombstone can never resurrect the value it deleted.
   */
  compact(frontier: Hlc): void;
  /** Drop all register state (a migration establishes a fresh retention window). */
  reset(): void;
  /**
   * The max epoch across ALL retained siblings at `path` (0 when nothing is retained): the
   * room's observed epoch, the baseline an admission gate compares an incoming op's epoch
   * against. Superseded-but-uncompacted siblings count too, so a carry that superseded the
   * bump it cites never lowers the observed max within the retention window; a full
   * below-frontier prune legitimately resets it.
   */
  maxEpoch(path: readonly Key[]): number;
  /**
   * Does the retained state at `path` cover `dot` — is it at or below that origin's known
   * extent there? True when the origin's retained sibling or its supersession watermark sits
   * at or above the dot's stamp. Every op sequenced into the room leaves such a trace until
   * compaction, so above the compaction frontier a cite of an uncovered dot is a forgery (or
   * an op the relay never saw).
   */
  covers(path: readonly Key[], dot: Dot): boolean;
};

export function createRegisterStore(): RegisterStore {
  const registers = new Map<string, Reg>();

  const regAt = (path: readonly Key[]): Reg => {
    const key = keyOf(path);
    let reg = registers.get(key);
    if (!reg) {
      reg = { path, siblings: new Map(), water: new Map() };
      registers.set(key, reg);
    }
    return reg;
  };

  const liveOf = (reg: Reg): SyncSibling[] => {
    const out: SyncSibling[] = [];
    for (const [origin, s] of reg.siblings) {
      const w = reg.water.get(origin);
      if (!w || compareHlc(s.hlc, w) > 0) out.push(s);
    }
    return out;
  };

  const isContainer = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null;

  /** Does `value` (an ancestor sibling's set value) still contain the key at `rel`? */
  const contains = (value: unknown, rel: readonly Key[]): boolean => {
    let cur = value;
    for (let i = 0; i < rel.length; i++) {
      if (!isContainer(cur) || !Object.hasOwn(cur, String(rel[i]))) return false;
      cur = (cur as Record<string, unknown>)[String(rel[i])];
    }
    return true;
  };

  /** A lone tombstone is droppable only if nothing else still materializes its key. */
  const tombstoneDroppable = (key: string, reg: Reg): boolean => {
    for (const [k, other] of registers) {
      if (k === key) continue;
      if (k.startsWith(key + SEP)) {
        if (liveOf(other).length > 0) return false; // a live descendant would resurface
      } else if (key.startsWith(k === '' ? '' : k + SEP)) {
        const rel = reg.path.slice(other.path.length);
        for (const s of liveOf(other)) {
          if (s.kind === 'set' && contains(s.value, rel)) return false;
        }
      }
    }
    return true;
  };

  return {
    ingest: (env) => {
      for (const op of env.ops) {
        // a delete or clear at the root has no parent register to abstain to; retaining one would
        // ship register state a client can only materialize as a blanked document, so drop it
        if (!op.path.length && op.kind !== 'set') continue;
        const reg = regAt(op.path);
        for (const c of op.cites ?? []) {
          // a self-citation would born-dead the write; ignore it (matches the client register)
          if (c.origin === env.origin && compareHlc(c.hlc, env.hlc) === 0) continue;
          const cur = reg.water.get(c.origin);
          if (!cur || compareHlc(c.hlc, cur) > 0) reg.water.set(c.origin, c.hlc);
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
          if (op.kind !== 'clear' && Object.hasOwn(op, 'prev')) {
            sib.prev = (op as { prev?: unknown }).prev;
          }
          reg.siblings.set(env.origin, sib);
        }
      }
    },

    checkpoint: () => {
      const out: RegisterCheckpoint[] = [];
      for (const reg of registers.values()) {
        out.push({
          path: reg.path,
          siblings: [...reg.siblings.values()],
          water: Object.fromEntries(reg.water),
        });
      }
      return out;
    },

    load: (regs) => {
      for (const r of regs) {
        const reg = regAt(r.path);
        for (const s of r.siblings) {
          const cur = reg.siblings.get(s.origin);
          if (!cur || compareHlc(s.hlc, cur.hlc) > 0) {
            reg.siblings.set(s.origin, s);
          }
        }
        for (const [origin, h] of Object.entries(r.water)) {
          const cur = reg.water.get(origin);
          if (!cur || compareHlc(h, cur) > 0) reg.water.set(origin, h);
        }
      }
    },

    compact: (frontier) => {
      for (const [key, reg] of [...registers]) {
        for (const [origin, s] of [...reg.siblings]) {
          const w = reg.water.get(origin);
          if (
            compareHlc(s.hlc, frontier) <= 0 &&
            w &&
            compareHlc(s.hlc, w) <= 0
          ) {
            reg.siblings.delete(origin);
          }
        }
        for (const [origin, h] of [...reg.water]) {
          if (compareHlc(h, frontier) <= 0) reg.water.delete(origin);
        }
        if (reg.siblings.size === 0 && reg.water.size === 0) {
          registers.delete(key);
        }
      }
      // lone-tombstone drop, after the sibling prune settled the live sets. Deepest paths first so a
      // descendant tombstone is collected before its ancestor is evaluated: otherwise a still-present
      // descendant tombstone pins the ancestor, and a single pass would strand it until a later compaction.
      const byDepth = [...registers.entries()].sort(
        (a, b) => b[1].path.length - a[1].path.length,
      );
      for (const [key, reg] of byDepth) {
        const live = liveOf(reg);
        if (
          live.length === 1 &&
          live[0].kind === 'delete' &&
          reg.siblings.size === 1 &&
          compareHlc(live[0].hlc, frontier) <= 0 &&
          tombstoneDroppable(key, reg)
        ) {
          registers.delete(key);
        }
      }
    },

    reset: () => registers.clear(),

    maxEpoch: (path) => {
      const reg = registers.get(keyOf(path));
      if (!reg) return 0;
      let max = 0;
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
  };
}
