import {
  checkEnvelope,
  MESH_PROTO_VERSION,
  type OpPolicy,
  type PolicyViolation,
  type PresenceState,
  type PrincipalCtx,
  type SeqEnvelope,
  type ServerMsg,
} from '@mmstack/mesh-protocol';
import {
  createConvergingApply,
  type MergePolicyEntry,
  type OpEnvelope,
  type OpSync,
  type StoreOp,
} from '@mmstack/primitives';
import type { MeshTransport, MeshTransportFactory } from './transport';

export type MeshStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'ejected'
  | 'closed';

/** One sequenced remote envelope's ops, attributed to the writer that made them. */
export type RemoteBatch = {
  /** The relay's total-order stamp for this batch. */
  readonly seq: number;
  readonly writer: string;
  readonly ops: readonly StoreOp[];
};

/**
 * Environment callbacks a session shell provides. All are optional except `onStatus`; the
 * session never touches signals, timers beyond `schedule`, storage, or the DOM itself.
 */
export type MeshSessionHooks = {
  onStatus(status: MeshStatus, reason?: string): void;
  /** A welcome or envelope arrived — the shell's "last synced" moment. */
  onSynced?(): void;
  /** The presence roster changed (welcome replace, join/leave, teardown clear). */
  onPeers?(peers: ReadonlyMap<string, PresenceState>): void;
  /** A remote (non-own) envelope was ingested, in seq order. */
  onRemote?(batch: RemoteBatch): void;
  /**
   * Seq continuity broke: a snapshot welcome (or a relay instance change) established state
   * without delivering the individual envelopes in between. Any consumer deriving from the
   * `onRemote` stream must rebuild from current state at this seq; appending across a resync
   * would silently skip history.
   */
  onResync?(seq: number): void;
  /** The unacknowledged local tail changed (emit or ack) — the durable-outbox trigger. */
  onOutboxChange?(): void;
  /**
   * A local write violated the room policy. The session ejects itself immediately after —
   * the outcome the relay's own independent check would have produced one hop later. The
   * emit-side check spares the room the round trip; it is never the enforcement.
   */
  onLocalReject?(violation: PolicyViolation): void;
  /**
   * Teardown is starting; fired before the unacked tail is dropped, so a shell can persist
   * it (and release any single-writer locks) while it is still intact.
   */
  onTerminal?(state: 'ejected' | 'closed', reason?: string): void;
};

export type MeshSessionOptions<T extends object> = {
  readonly room: string;
  readonly writer: string;
  readonly transport: MeshTransportFactory;
  /** The op engine this session feeds. The shell creates (and destroys) it. */
  readonly sync: OpSync<T>;
  readonly policies?: readonly MergePolicyEntry[];
  readonly policy?: OpPolicy;
  readonly ctx?: Omit<PrincipalCtx, 'writer'>;
  readonly policyVersion: number;
  readonly schemaVersion?: number;
  readonly reconnect?: { readonly maxDelayMs?: number };
  /** Timer seam (tests, deterministic harnesses). Defaults to global timers. */
  readonly schedule?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
  readonly hooks: MeshSessionHooks;
};

/**
 * The relay-room session protocol, shell-agnostic: hello/welcome handshakes (snapshot
 * hydrate, delta replay, fresh-room seed), own-echo acknowledgement, unacked resend,
 * reconnect backoff, presence, eject/reject and frontier compaction. `meshSync` wraps it for
 * Angular; `agentSeat` wraps it for injector-free environments. One implementation of the
 * wire contract — shells differ only in environment concerns.
 */
export type MeshSession = {
  /** Open the first connection. Call once, after any outbox restore has replayed. */
  connect(): void;
  status(): MeshStatus;
  /** Highest relay seq observed. With no unacked writes, local state is the pure fold of the room at this seq. */
  lastSeq(): number;
  hasUnacked(): boolean;
  /** The unacknowledged local tail (the durable-outbox payload). */
  unackedEnvs(): readonly OpEnvelope[];
  peers(): ReadonlyMap<string, PresenceState>;
  setPresence(data: unknown): void;
  close(): void;
};

const RECONNECT_BASE_MS = 500;

export function meshSession<T extends object>(
  opt: MeshSessionOptions<T>,
): MeshSession {
  const { sync, hooks } = opt;
  const schedule = opt.schedule ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  let status: MeshStatus = 'connecting';
  const ownOrigins = new Set<string>([sync.origin]);
  const unacked = new Map<string, OpEnvelope>();
  const acked = new Map<string, number>();
  const unackedKey = (env: { origin: string; version: number }): string =>
    `${env.origin} ${env.version}`;
  let lastSeq = 0;
  let instance: string | undefined;
  let peers: ReadonlyMap<string, PresenceState> = new Map();
  let presenceData: unknown;
  let hasPresence = false;
  let transport: MeshTransport | null = null;
  let attempts = 0;
  let reconnectTimer: unknown;
  let unsubs: (() => void)[] = [];
  let closed = false;

  const setStatus = (next: MeshStatus, reason?: string): void => {
    status = next;
    hooks.onStatus(next, reason);
  };

  const terminal = (state: 'ejected' | 'closed', reason?: string): void => {
    if (closed) return;
    closed = true;
    if (reconnectTimer !== undefined) {
      schedule.clear(reconnectTimer);
      reconnectTimer = undefined;
    }
    for (const unsub of unsubs.splice(0)) unsub();
    unsubLocal();
    hooks.onTerminal?.(state, reason); // unacked is still intact here — the persist window
    unacked.clear();
    transport?.close();
    transport = null;
    peers = new Map();
    hooks.onPeers?.(peers);
    setStatus(state, reason);
  };

  const sendEnv = (env: OpEnvelope): void => {
    transport?.send({ t: 'env', room: opt.room, env });
  };

  // Flushed in insertion order — emission order. An envelope only cites dots that existed
  // in its store when it was emitted, so any cited own-dot is either already acked or sits
  // EARLIER in this map; that holds across boots because the outbox persists and restores
  // the tail in this same order. Sorting across origins (a multi-boot tail spans several)
  // can send a citing envelope before its cited one — an honest writer ejected by a
  // citation-verifying relay.
  const flushUnacked = (): void => {
    for (const env of unacked.values()) sendEnv(env);
  };

  const applyRemote = (env: SeqEnvelope): void => {
    lastSeq = Math.max(lastSeq, env.seq);
    hooks.onSynced?.();
    if (
      opt.schemaVersion !== undefined &&
      env.schemaVersion !== undefined &&
      env.schemaVersion > opt.schemaVersion
    ) {
      terminal('ejected', 'schema');
      return;
    }
    if (ownOrigins.has(env.origin)) {
      unacked.delete(unackedKey(env));
      acked.set(env.origin, Math.max(acked.get(env.origin) ?? 0, env.version));
      hooks.onOutboxChange?.();
      return;
    }
    sync.receive(env);
    hooks.onRemote?.({ seq: env.seq, writer: env.writer, ops: env.ops });
  };

  const handle = (msg: ServerMsg): void => {
    if (msg.room !== opt.room) return;
    switch (msg.t) {
      case 'welcome': {
        const instanceChanged =
          instance !== undefined && msg.instance !== instance;
        if (instanceChanged) lastSeq = 0;
        instance = msg.instance;
        peers = new Map(msg.peers.map((p) => [p.origin, p]));
        hooks.onPeers?.(peers);
        const resync = msg.mode === 'snapshot' || instanceChanged;
        if (msg.mode === 'delta') {
          for (const env of msg.envs) applyRemote(env);
        } else if (msg.mode === 'snapshot') {
          const conv = createConvergingApply({ policies: opt.policies });
          conv.load(msg.registers);
          const ownWm: Record<string, number> = {};
          for (const o of ownOrigins) ownWm[o] = acked.get(o) ?? 0;
          sync.hydrate(
            {
              root: conv.materialize() as T,
              registers: msg.registers,
              wm: { ...msg.wm, ...ownWm },
            },
            [...unacked.values()],
          );
          lastSeq = msg.seq;
        } else if (msg.seq === 0 && lastSeq === 0) {
          sync.seed();
        }
        // every branch can end terminal (schema eject in a delta env, a seed or rebase
        // emission tripping the emit-side policy) — never revive to live
        if (closed) return;
        lastSeq = Math.max(lastSeq, msg.seq);
        attempts = 0;
        hooks.onSynced?.();
        if (resync) hooks.onResync?.(lastSeq);
        setStatus('live');
        flushUnacked();
        if (hasPresence)
          transport?.send({
            t: 'presence',
            room: opt.room,
            data: presenceData,
          });
        return;
      }
      case 'env':
        applyRemote(msg.env);
        return;
      case 'presence': {
        const next = new Map(peers);
        if (msg.gone) next.delete(msg.peer.origin);
        else next.set(msg.peer.origin, msg.peer);
        peers = next;
        hooks.onPeers?.(peers);
        return;
      }
      case 'eject':
        if (msg.writer === opt.writer) terminal('ejected', msg.reason);
        return;
      case 'reject':
        terminal('ejected', msg.reason);
        return;
      case 'frontier':
        sync.prune(msg.frontier);
        return;
    }
  };

  const connect = (): void => {
    if (closed) return;
    for (const unsub of unsubs.splice(0)) unsub();
    const t = opt.transport();
    transport = t;
    unsubs = [
      t.onMessage(handle),
      t.onClose(() => {
        if (closed || transport !== t) return;
        transport = null;
        setStatus('reconnecting');
        const delay = Math.min(
          opt.reconnect?.maxDelayMs ?? 15_000,
          RECONNECT_BASE_MS * 2 ** attempts++,
        );
        reconnectTimer = schedule.set(
          () => {
            reconnectTimer = undefined;
            connect();
          },
          delay + Math.random() * 100,
        );
      }),
    ];
    t.send({
      t: 'hello',
      room: opt.room,
      origin: sync.origin,
      proto: MESH_PROTO_VERSION,
      policyVersion: opt.policyVersion,
      seq: lastSeq > 0 ? lastSeq : undefined,
      schemaVersion: opt.schemaVersion,
    });
  };

  const unsubLocal = sync.subscribe((env) => {
    const violation = checkEnvelope(
      opt.policy,
      env,
      { ...opt.ctx, writer: opt.writer },
      opt.room,
    );
    if (violation) {
      // same outcome the relay's own check would produce one hop later — the emit-side
      // check is an optimization, never the enforcement
      hooks.onLocalReject?.(violation);
      terminal('ejected', violation.reason);
      return;
    }
    ownOrigins.add(env.origin); // the fresh mint, or a restored-tail origin resending verbatim
    unacked.set(unackedKey(env), env);
    hooks.onOutboxChange?.();
    if (status === 'live') sendEnv(env);
  });

  return {
    connect,
    status: () => status,
    lastSeq: () => lastSeq,
    hasUnacked: () => unacked.size > 0,
    unackedEnvs: () => [...unacked.values()],
    peers: () => peers,
    setPresence: (data) => {
      presenceData = data;
      hasPresence = true;
      if (status === 'live') {
        transport?.send({ t: 'presence', room: opt.room, data });
      }
    },
    close: () => terminal('closed'),
  };
}
