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

  const regAt = (path: readonly Key[]): Reg => {
    const key = keyOf(path);
    let reg = registers.get(key);
    if (!reg) {
      reg = { path, siblings: new Map(), water: new Map() };
      registers.set(key, reg);
    }
    return reg;
  };

  return {
    ingest: (env) => {
      for (const op of env.ops) {
        // a delete or clear at the root has no parent register to abstain to; retaining one would
        // ship register state a client can only materialize as a blanked document, so drop it
        if (!op.path.length && op.kind !== 'set') continue;
        const reg = regAt(op.path);
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
          if (op.kind !== 'clear' && Object.hasOwn(op, 'prev')) {
            sib.prev = (op as { prev?: unknown }).prev;
          }
          reg.siblings.set(env.origin, sib);
        }
      }
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
            reg.siblings.set(s.origin, s);
          }
        }
        for (const [origin, h] of Object.entries(r.water)) {
          const cur = reg.water.get(origin);
          if (!cur || compareHlc(h, cur) > 0) reg.water.set(origin, h);
        }
      }
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
    },
    reset: () => {
      registers.clear();
      epochs.clear();
    },

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
  };
}
