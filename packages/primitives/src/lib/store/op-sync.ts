import {
  effect,
  inject,
  Injector,
  isDevMode,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { merge3 } from './fork-store';
import { compareTotal, createHlcClock, type Hlc, type HlcClock } from './hlc';
import {
  applyOps,
  diffOps,
  invertBatch,
  opLog,
  type OpLogDriver,
  type StoreOp,
} from './op-log';

export const OP_PROTO_VERSION = 1;

type Key = string | number;

/**
 * The wire/journal recor. `writer` is an opaque principal pseudonym —
 * natural identity never enters the envelope; `origin` identifies the emitting log instance.
 */
export type OpEnvelope = {
  readonly proto: number;
  readonly origin: string;
  readonly writer: string;
  readonly version: number;
  readonly hlc: Hlc;
  readonly policyVersion: number;
  readonly ops: readonly StoreOp[];
};

const CONFLICT_BRAND = '~mmstackConflict';

/**
 * A preserved (jj-style) conflict: both sides survive as data, sync never blocks, and
 * resolution is just a later write. String-branded so it survives structured clone.
 */
export type Conflicted<T = unknown> = {
  readonly [CONFLICT_BRAND]: true;
  readonly mine: T;
  readonly theirs: T;
  readonly ancestor?: T;
};

export function isConflicted<T = unknown>(
  value: unknown,
): value is Conflicted<T> {
  return typeof value === 'object' && value !== null && CONFLICT_BRAND in value;
}

export type MergeContext = {
  readonly path: readonly Key[];
};

/**
 * Resolves a concurrent set-vs-set collision. Called with a deterministic argument order
 * (`mine` = the side winning the total order) so every peer computes the same value.
 */
export type MergeFn = (
  ancestor: unknown,
  mine: unknown,
  theirs: unknown,
  ctx: MergeContext,
) => unknown;

export type MergePolicyEntry = {
  /** `'todos.*.title'` or a segment array; `'*'` matches exactly one segment. */
  readonly path: string | readonly Key[];
  readonly merge: MergeFn;
};

export const lww: MergeFn = (_ancestor, mine) => mine;

export const mergeThree: MergeFn = (ancestor, mine, theirs) =>
  merge3(ancestor, mine, theirs);

export const preserve: MergeFn = (ancestor, mine, theirs) =>
  ({ [CONFLICT_BRAND]: true, mine, theirs, ancestor }) satisfies Conflicted;

/**
 * Identity-aware array merge: reconciles two concurrent versions of
 * an array item-wise by a user-provided identity, instead of last-writer-wins on the whole
 * array. Items are matched by key; per-item fields merge via `merge3` against the ancestor
 * item; items added on either side survive; an item removed on either side and unedited on
 * the other stays removed. Item ORDER follows `mine` (the total-order winner), with `theirs`-
 * only additions appended — positional merging is out of scope (fractional indexing is the
 * known upgrade if dogfooding demands it). Arrays still TRAVEL as whole-value sets; identity
 * only shapes conflict resolution, so the wire format is untouched.
 */
export function keyedArray(
  identity: (item: unknown) => unknown,
  opt?: { item?: MergeFn },
): MergeFn {
  const mergeItem: MergeFn = opt?.item ?? mergeThree;
  return (ancestor, mine, theirs, ctx) => {
    if (!Array.isArray(mine) || !Array.isArray(theirs)) {
      return mine; // type conflict → total-order winner, like lww
    }
    const anc = Array.isArray(ancestor) ? ancestor : [];
    const byKey = (arr: readonly unknown[]) => {
      const map = new Map<unknown, unknown>();
      for (const item of arr) map.set(identity(item), item);
      return map;
    };
    const ancMap = byKey(anc);
    const mineMap = byKey(mine);
    const theirsMap = byKey(theirs);

    const out: unknown[] = [];
    for (const item of mine) {
      const key = identity(item);
      const other = theirsMap.get(key);
      const base = ancMap.get(key);
      if (theirsMap.has(key)) {
        out.push(
          structuralEq(item, other) ? item : mergeItem(base, item, other, ctx),
        );
      } else if (!ancMap.has(key) || !structuralEq(item, base)) {
        out.push(item); // added by mine, or edited by mine while theirs removed it → keep
      }
      // else: theirs removed it and mine left it untouched → stays removed
    }
    for (const item of theirs) {
      const key = identity(item);
      if (mineMap.has(key)) continue;
      if (!ancMap.has(key) || !structuralEq(item, ancMap.get(key))) {
        out.push(item); // added by theirs, or edited by theirs while mine removed it → keep
      }
    }
    return out;
  };
}

type CompiledPolicy = {
  readonly segments: readonly string[];
  readonly merge: MergeFn;
};

function compilePolicies(
  entries: readonly MergePolicyEntry[],
): CompiledPolicy[] {
  return entries.map((e) => ({
    segments:
      typeof e.path === 'string' ? e.path.split('.') : e.path.map(String),
    merge: e.merge,
  }));
}

function policyFor(
  policies: readonly CompiledPolicy[],
  path: readonly Key[],
): MergeFn {
  outer: for (const p of policies) {
    if (p.segments.length !== path.length) continue;
    for (let i = 0; i < path.length; i++) {
      if (p.segments[i] !== '*' && p.segments[i] !== String(path[i]))
        continue outer;
    }
    return p.merge;
  }
  return lww;
}

const SEP = '';
const keyOf = (path: readonly Key[]): string => path.map(String).join(SEP);

function structuralEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false;
    if (
      !structuralEq(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    ) {
      return false;
    }
  }
  return true;
}

type Stamp = {
  readonly hlc: Hlc;
  readonly writer: string;
  readonly origin: string;
};

type Register = { hlc: Hlc; writer: string; origin: string; op: StoreOp };

// total order (hlc, writer, origin): two origins can share a writer AND a stamp
// (independent clocks, same ms), so only origin makes the order strict
const compareStamp = (a: Stamp, b: Stamp): number => {
  const byTotal = compareTotal(a.hlc, a.writer, b.hlc, b.writer);
  if (byTotal !== 0) return byTotal;
  return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0;
};

const beats = (a: Stamp, b: Stamp): boolean => compareStamp(a, b) > 0;

export type ConvergingApply = {
  /**
   * Fold an envelope into the register map and return the ops the local store must apply
   * (post-dominance, post-policy, including replays of newer descendant winners). Pass
   * `local: true` for envelopes this peer emitted itself: registered, nothing returned.
   */
  ingest(env: OpEnvelope, opt?: { local?: boolean }): StoreOp[];
  /** Drop all registers (snapshot compaction / rehydration boundary). */
  reset(): void;
};

/**
 * The unsequenced-topology convergence core: a per-path last-writer-wins
 * register map over the total order (hlc, writer), with subtree dominance. Order-independent:
 * any arrival order of the same envelope set yields the same state.
 */
export function createConvergingApply(opt?: {
  policies?: readonly MergePolicyEntry[];
}): ConvergingApply {
  const registers = new Map<string, Register>();
  const policies = compilePolicies(opt?.policies ?? []);

  const resolveConcurrent = (
    winner: StoreOp,
    loser: StoreOp,
    path: readonly Key[],
  ): StoreOp => {
    const merge = policyFor(policies, path);
    if (merge === lww || winner.kind === 'delete' || loser.kind === 'delete') {
      return winner;
    }
    const resolved = merge(loser.prev, winner.next, loser.next, { path });
    if (Object.is(resolved, winner.next)) return winner;
    return { kind: 'set', path, next: resolved, prev: winner.next };
  };

  const concurrentWith = (incoming: StoreOp, registered: StoreOp): boolean => {
    if (incoming.kind === 'delete' || registered.kind === 'delete')
      return false;
    if (!Object.hasOwn(incoming, 'prev')) return true;
    return !structuralEq(incoming.prev, registered.next);
  };

  return {
    ingest: (env, o) => {
      const stamp: Stamp = {
        hlc: env.hlc,
        writer: env.writer,
        origin: env.origin,
      };
      const out: StoreOp[] = [];

      for (const op of env.ops) {
        const key = keyOf(op.path);

        let dominated = false;
        let exact: Register | undefined;
        for (let len = 0; len <= op.path.length; len++) {
          const reg = registers.get(keyOf(op.path.slice(0, len)));
          if (!reg) continue;
          if (len === op.path.length) exact = reg;
          else if (beats(reg, stamp)) {
            dominated = true;
            break;
          }
        }
        if (dominated) continue;

        if (exact && beats(exact, stamp)) {
          if (concurrentWith(op, exact.op)) {
            const resolved = resolveConcurrent(exact.op, op, op.path);
            if (resolved !== exact.op) {
              exact.op = resolved;
              if (!o?.local) out.push(resolved);
            }
          }
          continue;
        }

        let accepted = op;
        if (exact && concurrentWith(op, exact.op)) {
          accepted = resolveConcurrent(op, exact.op, op.path);
        }

        const isDescendant =
          key === ''
            ? (k: string) => k !== ''
            : (k: string) => k.startsWith(key + SEP);
        const replays: Register[] = [];
        for (const [k, reg] of registers) {
          if (!isDescendant(k)) continue;
          if (beats(stamp, reg)) registers.delete(k);
          else replays.push(reg);
        }
        replays.sort(compareStamp);

        registers.set(key, {
          hlc: env.hlc,
          writer: env.writer,
          origin: env.origin,
          op: accepted,
        });
        if (!o?.local) {
          out.push(accepted);
          for (const r of replays) out.push(r.op);
        }
      }

      return out;
    },
    reset: () => registers.clear(),
  };
}

function getAtPath(root: unknown, path: readonly Key[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<Key, unknown>)[seg];
  }
  return cur;
}

export type RebaseResult<T = unknown> = {
  root: T;
  /** Pending batches re-based onto the remote state, `prev`s refreshed. */
  pending: StoreOp[][];
};

/**
 * The shared rebase routine: invert pending, apply remote, re-apply
 * pending through the merge policies. Pure — branching's `rebase()` and the sequenced relay
 * client both call this.
 */
export function rebaseOps<T>(
  root: T,
  pending: readonly (readonly StoreOp[])[],
  remote: readonly StoreOp[],
  policies?: readonly MergePolicyEntry[],
): RebaseResult<T> {
  const compiled = compilePolicies(policies ?? []);

  let base: unknown = root;
  for (let i = pending.length - 1; i >= 0; i--) {
    base = applyOps(base, invertBatch(pending[i]));
  }
  base = applyOps(base, remote);

  const rebased: StoreOp[][] = [];
  for (const batch of pending) {
    const next: StoreOp[] = [];
    for (const op of batch) {
      const cur = getAtPath(base, op.path);
      if (op.kind === 'delete') {
        next.push({ kind: 'delete', path: op.path, prev: cur });
      } else if (cur === undefined) {
        next.push({ kind: 'set', path: op.path, next: op.next });
      } else if (Object.hasOwn(op, 'prev') && !structuralEq(op.prev, cur)) {
        const merge = policyFor(compiled, op.path);
        const resolved = merge(op.prev, op.next, cur, { path: op.path });
        next.push({ kind: 'set', path: op.path, next: resolved, prev: cur });
      } else {
        next.push({ kind: 'set', path: op.path, next: op.next, prev: cur });
      }
    }
    base = applyOps(base, next);
    rebased.push(next);
  }

  return { root: base as T, pending: rebased };
}

/**
 * A per-path-policy `ForkStrategy` for `forkStore`: a three-way reconcile built from the
 * shared rebase (invert mine → apply theirs' delta → re-apply mine through the policies).
 * Paths only one side touched resolve like `merge3`; paths BOTH touched go through the
 * matching {@link MergePolicyEntry} (`lww` default — fork wins, matching `'fine'`; or
 * `mergeThree` / `preserve` / custom). Same copy-on-write contract as `'fine'`.
 */
export function policyStrategy<T>(
  policies: readonly MergePolicyEntry[],
): (ancestor: T, mine: T, theirs: T) => T {
  return (ancestor, mine, theirs) =>
    rebaseOps(
      mine,
      [diffOps(ancestor, mine)],
      diffOps(ancestor, theirs),
      policies,
    ).root;
}

export type OpSyncOptions = {
  /** Opaque principal pseudonym — provided by the app, never minted here. */
  readonly writer: string;
  readonly origin?: string;
  readonly policyVersion?: number;
  readonly policies?: readonly MergePolicyEntry[];
  readonly clock?: HlcClock;
  readonly injector?: Injector;
  readonly driver?: OpLogDriver;
  /** A version gap from a known origin (missed envelopes) — the resync hook. */
  readonly onGap?: (origin: string, expected: number, got: number) => void;
};

export type OpSync<T = unknown> = {
  readonly origin: string;
  /** Locally-emitted envelopes, ready for a transport. */
  subscribe(cb: (env: OpEnvelope) => void): () => void;
  /** Converging apply of a remote envelope (echo-free; own-origin envelopes are ignored). */
  receive(env: OpEnvelope): void;
  /** Synchronously emit any pending local delta now. */
  flush(): void;
  /** Per-origin latest versions — the handshake watermark. */
  watermark(): Record<string, number>;
  /** The current root + watermark, for answering a peer's hello. */
  snapshot(): { root: T; wm: Record<string, number> };
  /**
   * Emit the CURRENT root as a root-set envelope — the fresh-room seed of the relay
   * contract (a room's snapshot root becomes complete once seeded).
   */
  seed(): void;
  /**
   * Replace local state with a peer's snapshot, atomically (one notification wave).
   * Local envelopes the snapshot doesn't cover (per its watermark) are re-applied on
   * top, so writes made before hydration are never silently lost.
   */
  hydrate(root: T, wm?: Record<string, number>): void;
  /**
   * Re-inject this origin's persisted local envelopes on boot (a durable outbox), WITHOUT minting
   * new versions: each is applied to the store (echo-free), registered as a local winner, and handed
   * to subscribers so a transport can resend the unacknowledged tail. `highWater` is the highest
   * version this origin ever emitted (>= every `env.version`); the next mint continues past it, so a
   * version acked before the reboot but dropped from a debounced outbox never collides. Call on a
   * FRESH instance, before any `receive`/`hydrate` — restoring onto already-ingested remote winners
   * would wrongly let a stale local op override them.
   */
  restore(envs: readonly OpEnvelope[], highWater?: number): void;
  destroy(): void;
};

function generateOrigin(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(36).substring(2);
}

/**
 * Wires a copy-on-write signal (a `store` root) to the op protocol: local writes emit
 * stamped envelopes, received envelopes fold in through the converging apply. The
 * unsequenced-topology client core that `tabSync(store)` and P2P transports build on.
 */
const RECENT_LOCAL_CAP = 64;

export function opSync<T extends object>(
  source: WritableSignal<T>,
  opt: OpSyncOptions,
): OpSync<T> {
  const origin = opt.origin ?? generateOrigin();
  const clock = opt.clock ?? createHlcClock();
  const conv = createConvergingApply({ policies: opt.policies });
  const subscribers = new Set<(env: OpEnvelope) => void>();
  // per-origin high-watermark; `versions.get(origin)` IS the local emit counter, so a hydrate/restore
  // that raises our own watermark also advances the next mint — no separate counter to drift out of
  // sync and collide with a version acked before a reboot but dropped from a debounced outbox.
  const versions = new Map<string, number>();
  const recentLocal: OpEnvelope[] = [];

  const resolvedInjector = opt.driver
    ? null
    : (opt.injector ?? inject(Injector));

  const log = opLog(
    source,
    opt.driver
      ? { origin, driver: opt.driver }
      : { origin, injector: resolvedInjector as Injector },
  );

  // Local envelopes stamped + registered but not yet handed to the transport. A `receive` freezes
  // this peer's pending writes here so it can ingest the remote WITHOUT emitting mid-receive — the
  // synchronous re-entrant emission that used to scramble the relay's commit order. The outbox
  // drains on a LATER tick, so emission always lands outside any receive callstack. Writes made
  // while a drain is still owed queue here too, keeping wire order == version order (else a receiver
  // would dedup the older, still-frozen envelope).
  //
  // Deferral rides an Angular effect, so it arms only on the injector path — the transport
  // topologies (`tabSync`, `meshSync`) that actually re-enter through a relay. A custom `driver`
  // (worker mirror, pure sim, multi-reader) owns its own scheduling and has no such re-entrancy, so
  // it emits synchronously; the freeze-before-observe STAMPING fix below is identical either way.
  const canDefer = !opt.driver;
  const outbox: OpEnvelope[] = [];
  let receiving = false;

  // a signal the drain reaction tracks; bumping it schedules an outbox drain for the next tick
  const drainTick = signal(0);
  const scheduleDrain = (): void => drainTick.update((v) => v + 1);

  const notify = (env: OpEnvelope): void => {
    for (const cb of [...subscribers]) cb(env);
  };
  const drainOutbox = (): void => {
    for (const env of outbox.splice(0)) notify(env);
  };

  const emitLocal = (ops: readonly StoreOp[]): void => {
    const nextVersion = (versions.get(origin) ?? 0) + 1;
    const env: OpEnvelope = {
      proto: OP_PROTO_VERSION,
      origin,
      writer: opt.writer,
      version: nextVersion,
      hlc: clock.next(),
      policyVersion: opt.policyVersion ?? 0,
      ops,
    };
    versions.set(origin, nextVersion);
    conv.ingest(env, { local: true });
    recentLocal.push(env);
    if (recentLocal.length > RECENT_LOCAL_CAP) recentLocal.shift();
    // mid-receive, or a drain still owed → queue (frozen stamp verbatim) instead of emitting now
    if (canDefer && (receiving || outbox.length)) {
      outbox.push(env);
      scheduleDrain();
      return;
    }
    notify(env);
  };

  const unsub = log.subscribe((batch) => emitLocal(batch.ops));

  // fires on the tick after `scheduleDrain`: emits frozen local envelopes outside any receive frame
  const drainRun = (): void => {
    drainTick();
    untracked(drainOutbox);
  };
  const drainRef = canDefer
    ? effect(drainRun, { injector: resolvedInjector as Injector })
    : null;

  return {
    origin,
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    receive: (env) => {
      if (env.origin === origin) return;
      if (env.proto !== OP_PROTO_VERSION) {
        if (isDevMode()) {
          console.warn(
            `[@mmstack/primitives] dropped envelope with proto ${env.proto} (expected ${OP_PROTO_VERSION})`,
          );
        }
        return;
      }
      const known = versions.get(env.origin);
      if (known !== undefined && env.version <= known) return; // duplicate/covered — idempotent
      if (known !== undefined && env.version !== known + 1) {
        opt.onGap?.(env.origin, known + 1, env.version);
      }
      versions.set(env.origin, env.version);
      receiving = true;
      try {
        // Freeze pending local FIRST — stamped by a clock that has NOT yet observed this remote, so
        // the local write keeps its causally-independent (original) stamp rather than being lifted
        // above the remote and always winning. Emission is deferred to a tick via the outbox; this
        // only registers + stamps.
        log.flush();
        clock.observe(env.hlc);
        const ops = conv.ingest(env);
        // apply the converged result — a local write that LOST its path rolls back visibly here
        if (ops.length) log.apply(ops);
      } finally {
        receiving = false;
      }
    },
    flush: () => {
      drainOutbox();
      log.flush();
    },
    watermark: () => Object.fromEntries(versions),
    snapshot: () => {
      log.flush();
      return { root: untracked(source), wm: Object.fromEntries(versions) };
    },
    seed: () => {
      log.flush();
      emitLocal([{ kind: 'set', path: [], next: untracked(source) }]);
    },
    hydrate: (root, wm) => {
      log.flush();
      const covered = wm?.[origin] ?? 0;
      const pending = recentLocal.filter((e) => e.version > covered);
      conv.reset();
      let next: unknown = root;
      for (const e of pending) next = applyOps(next, e.ops);
      log.apply([{ kind: 'set', path: [], next }]);
      for (const [o, v] of Object.entries(wm ?? {})) {
        versions.set(o, Math.max(versions.get(o) ?? 0, v));
      }
      for (const e of pending) conv.ingest(e, { local: true });
    },
    restore: (envs, highWater) => {
      let maxV = versions.get(origin) ?? 0;
      for (const env of envs) {
        if (env.origin !== origin) continue; // only this origin's own durable outbox
        clock.observe(env.hlc); // keep the clock ≥ restored stamps before any future mint
        log.apply(env.ops); // reflect the offline edit in the store, echo-free
        conv.ingest(env, { local: true }); // register as a local winner (survives a reconnect merge)
        recentLocal.push(env);
        if (recentLocal.length > RECENT_LOCAL_CAP) recentLocal.shift();
        maxV = Math.max(maxV, env.version);
        notify(env); // hand to the transport to resend the unacknowledged tail
      }
      versions.set(origin, Math.max(maxV, highWater ?? 0));
    },
    destroy: () => {
      drainOutbox(); // don't silently drop frozen-but-unsent local writes
      unsub();
      subscribers.clear();
      drainRef?.destroy();
      log.destroy();
    },
  };
}
