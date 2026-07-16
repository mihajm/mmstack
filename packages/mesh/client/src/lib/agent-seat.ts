import { createWatch } from '@angular/core/primitives/signals';
import type {
  OpPolicy,
  PresenceState,
  PrincipalCtx,
} from '@mmstack/mesh-protocol';
import {
  createStoreContext,
  forkStore,
  opSync,
  store,
  type DotFrontier,
  type ForkStoreOptions,
  type MergePolicyEntry,
  type OpLogDriver,
  type OpSync,
  type StoreOp,
  type SyncedFork,
  type toStoreOptions,
  type WritableSignalStore,
} from '@mmstack/primitives';
import { meshSession, type MeshStatus } from './session';
import type { MeshTransportFactory } from './transport';

const microtaskDriver = (): OpLogDriver => (run) => {
  let scheduled = false;
  const watch = createWatch(
    () => run(),
    (w) => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        w.run();
      });
    },
    false,
  );
  watch.notify();
  return { destroy: () => watch.destroy() };
};

/** A sequenced batch of another writer's ops, delivered in relay order. */
export type SeatChange = {
  readonly kind: 'change';
  /** The relay's total-order stamp. Strictly increasing across `change` events between resyncs. */
  readonly seq: number;
  readonly writer: string;
  readonly ops: readonly StoreOp[];
};

/**
 * Seq continuity broke: the seat re-established state from a room snapshot (a reconnect past
 * the relay's retention, or a relay restart) without seeing the individual changes in
 * between. Anything accumulated from prior `change` events — narration buffers, cached
 * prompt prefixes — no longer extends the stream and must be rebuilt from current state.
 */
export type SeatResync = {
  readonly kind: 'resync';
  /** The seq the re-established state corresponds to. */
  readonly seq: number;
};

export type SeatEvent = SeatChange | SeatResync;

/** A base state provably derivable from the room's history alone — safe to cache. */
export type StableSnapshot<T> = {
  /** The relay seq this state is the fold of. */
  readonly seq: number;
  readonly doc: T;
};

export type AgentSeatOptions = {
  readonly room: string;
  /** Opaque principal pseudonym — provided, never minted. One identity per seat. */
  readonly writer: string;
  readonly transport: MeshTransportFactory;
  /** Per-path merge policies for rebase/convergence (`lww` default). */
  readonly policies?: readonly MergePolicyEntry[];
  /**
   * Emit-side validation, symmetric with the relay's — an optimization, not the
   * enforcement (the relay validates every envelope regardless). A violating write is
   * never sent and ejects the seat exactly as the relay would have; the refused value
   * stays visible in the local replica for post-mortem, and `stableSnapshot` is `null`.
   */
  readonly policy?: OpPolicy;
  /** kind/claims of this principal (e.g. `{ kind: 'agent' }`), for policy evaluation. */
  readonly ctx?: Omit<PrincipalCtx, 'writer'>;
  readonly policyVersion?: number;
  readonly schemaVersion?: number;
  /** Exponential backoff cap for reconnects (default 15s; base 500ms + jitter). */
  readonly reconnect?: { readonly maxDelayMs?: number };
  /**
   * Store context for the replica (from `createStoreContext()`). Defaults to a fresh one;
   * pass your own to share proxy caches across several seats in one process.
   */
  readonly context?: toStoreOptions;
  readonly onEject?: (reason: string) => void;
};

export type AgentSeat<T extends object> = {
  /** The live converging replica. Reads exactly like a local signal store. */
  readonly doc: WritableSignalStore<T & Record<string, any>>;
  status(): MeshStatus;
  peers(): readonly PresenceState[];
  /** The current document value — plain JSON-serializable data, for context assembly. */
  snapshot(): T;
  /**
   * The current document, stamped with the relay seq it is provably the pure fold of — or
   * `null` whenever that proof does not hold: before the first welcome, while any local
   * write is still unacknowledged, and permanently once the doc holds a write the room will
   * never sequence (a write the emit-side `policy` refused, or one orphaned by an eject or
   * close). A non-null result is byte-stable for its seq: re-deriving the room at that seq
   * yields exactly this document, which is what makes it safe to place in a prompt cache or
   * any other content-addressed store. Pair with `changes` to append everything after `seq`.
   */
  stableSnapshot(): StableSnapshot<T> | null;
  /** Run local writes and emit them to the room as one envelope, like any peer's edit. */
  write(fn: () => void): void;
  /** Path-addressed write (`'a.b.c'` or segments), emitted immediately. */
  setAtPath(path: string | readonly (string | number)[], value: unknown): void;
  /**
   * The room's sequenced history as it arrives: `change` events carry another writer's ops
   * in strictly increasing seq order, so a listener may append them (narration, prompt
   * suffixes) without any diffing. A `resync` event voids that guarantee — everything
   * accumulated so far must be rebuilt from current state (take a fresh `stableSnapshot`).
   * Own writes never echo here.
   */
  changes(cb: (event: SeatEvent) => void): () => void;
  /**
   * An isolated branch for a reviewable proposal. The fork observes the room as it is now;
   * `commit()` emits its diff citing only those observed writes, so a room edit that lands
   * while the fork is open survives as a concurrent value for the merge policy to resolve
   * instead of being overwritten. `rebase()` re-observes the room; `discard()` drops the
   * staged edits.
   */
  fork(
    opt?: ForkStoreOptions<T & Record<string, any>>,
  ): SyncedFork<T & Record<string, any>>;
  /** Publish this seat's ephemeral presence payload (e.g. `{ name, kind: 'agent' }`). */
  setPresence(data: unknown): void;
  close(): void;
};

/**
 * A headless mesh peer: the same replica and wire contract `meshSync` implements in the
 * browser, without Angular's injector or any browser API — for agents, server-side bridges,
 * and device writers joining a room as first-class, attributed participants. Each call is
 * one identity with its own replica; run several seats in one process for several
 * collaborators. Governance is the room's: the relay's policy applies to a seat exactly as
 * to any human peer.
 */
export function agentSeat<T extends object>(
  initial: T,
  opt: AgentSeatOptions,
): AgentSeat<T> {
  const context = opt.context ?? createStoreContext();
  const root = store(initial as T & Record<string, any>, context);
  const doc = root as unknown as WritableSignalStore<T & Record<string, any>>;
  const read = root as unknown as () => T;
  const policyVersion = opt.policyVersion ?? 0;

  // onReject fires synchronously inside receive(); the flag keeps a malformed envelope's
  // ops (which did NOT apply) out of the change stream.
  let rejected = false;
  const sync = opSync(root as never, {
    writer: opt.writer,
    policies: opt.policies,
    policyVersion,
    driver: microtaskDriver(),
    onReject: (_env, reason) => {
      rejected = true;
      console.warn(
        `[@mmstack/mesh] agent seat dropped a malformed envelope (${reason})`,
      );
    },
  }) as OpSync<T>;

  const listeners = new Set<(event: SeatEvent) => void>();
  const emit = (event: SeatEvent): void => {
    for (const cb of [...listeners]) cb(event);
  };
  let welcomed = false;
  let diverged = false;

  const session = meshSession({
    room: opt.room,
    writer: opt.writer,
    transport: opt.transport,
    sync,
    policies: opt.policies,
    policy: opt.policy,
    ctx: opt.ctx,
    policyVersion,
    schemaVersion: opt.schemaVersion,
    reconnect: opt.reconnect,
    hooks: {
      onStatus: (s, reason) => {
        if (s === 'live') welcomed = true;
        if (s === 'ejected' && reason !== undefined) opt.onEject?.(reason);
      },
      onRemote: (batch) => {
        if (rejected) {
          rejected = false;
          return;
        }
        emit({ kind: 'change', ...batch });
      },
      onResync: (seq) => emit({ kind: 'resync', seq }),
      onLocalReject: (violation) => {
        diverged = true; // the write stays in the replica but will never reach the room
        console.warn(
          '[@mmstack/mesh] agent seat write violates the room policy — not sent',
          violation,
        );
      },
      onTerminal: () => {
        if (session.hasUnacked()) diverged = true;
      },
    },
  });
  session.connect();

  return {
    doc,
    status: () => session.status(),
    peers: () => [...session.peers().values()],
    snapshot: () => read(),
    stableSnapshot: () => {
      sync.flush(); // a write made this tick must count as pending, not linger unstamped
      if (!welcomed || diverged || session.hasUnacked()) return null;
      return { seq: session.lastSeq(), doc: read() };
    },
    write: (fn) => {
      fn();
      sync.flush();
    },
    setAtPath: (path, value) => {
      setAtPath(doc, path, value);
      sync.flush();
    },
    changes: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    fork: (forkOpt) => {
      const f = forkStore(doc, forkOpt);
      let frontier: DotFrontier = sync.captureFrontier();
      const recapture = (): void => {
        frontier = sync.captureFrontier();
      };
      return {
        store: f.store,
        ops: f.ops,
        commit: () => {
          sync.commitScope(frontier, () => f.commit());
          sync.flush();
        },
        discard: () => {
          f.discard();
          recapture();
        },
        rebase: recapture,
      };
    },
    setPresence: (data) => session.setPresence(data),
    close: () => {
      session.close();
      sync.destroy();
    },
  };
}

type PathSegment = string | number;

const parsePath = (
  path: string | readonly PathSegment[],
): readonly PathSegment[] =>
  typeof path === 'string' ? path.split('.').filter((s) => s !== '') : path;

// resolve a string segment against an array ('0' → 0) so dot-paths address list items
const resolveKey = (current: unknown, seg: PathSegment): PathSegment =>
  Array.isArray(current) && typeof seg === 'string' && /^\d+$/.test(seg)
    ? Number(seg)
    : seg;

function withPathSet(
  current: unknown,
  path: readonly PathSegment[],
  value: unknown,
): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(current)) {
    const idx = typeof head === 'number' ? head : Number(head);
    const copy = [...current];
    copy[idx] = withPathSet(current[idx], rest, value);
    return copy;
  }
  const base =
    current !== null && typeof current === 'object'
      ? (current as Record<PathSegment, unknown>)
      : {};
  return { ...base, [head]: withPathSet(base[head], rest, value) };
}

/**
 * Applies `value` at a path on a signal-store node — the write shape a tool-calling model
 * naturally produces (`'plan.endDate'`, `'tasks.t1.done'`). Walks child signals as far as
 * the path exists in the current value and finishes with one immutable set on the deepest
 * real node, which also covers paths that do not exist yet (a fresh record key creates it).
 * Works on a seat's `doc` and on a fork's `store` alike; on a seat, prefer
 * `seat.setAtPath`, which also emits immediately.
 */
export function setAtPath(
  node: unknown,
  path: string | readonly PathSegment[],
  value: unknown,
): void {
  const segs = parsePath(path);
  let cursor = node as Record<PathSegment, unknown> & {
    (): unknown;
    set(v: unknown): void;
  };
  let walked = 0;
  for (const seg of segs) {
    const current = cursor();
    if (current === null || typeof current !== 'object') break;
    const key = resolveKey(current, seg);
    if (!Object.hasOwn(current, key)) break;
    const child = cursor[key];
    if (typeof child !== 'function') break;
    cursor = child as typeof cursor;
    walked++;
  }
  const rest = segs.slice(walked);
  if (rest.length === 0) {
    cursor.set(value);
    return;
  }
  cursor.set(withPathSet(cursor(), rest, value));
}

const MAX_VALUE_CHARS = 120;

const printable = (value: unknown): string => {
  const json = JSON.stringify(value);
  if (json === undefined) return String(value);
  return json.length > MAX_VALUE_CHARS
    ? `${json.slice(0, MAX_VALUE_CHARS - 1)}…`
    : json;
};

/**
 * One store op as a plain-English line ("mira set plan.endDate to \"2026-10-11\""), for
 * activity feeds and model context. Values render as truncated JSON. Pair with a seat's
 * `changes` stream: narrating each batch's ops yields an append-only account of the room.
 */
export function describeOp(op: StoreOp, writer: string): string {
  const at = op.path.length === 0 ? 'the document root' : op.path.join('.');
  switch (op.kind) {
    case 'set':
      return `${writer} set ${at} to ${printable(op.next)}`;
    case 'delete':
      return `${writer} removed ${at}`;
    case 'clear':
      return `${writer} cleared ${at}`;
  }
}
