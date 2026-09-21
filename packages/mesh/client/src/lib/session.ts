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
} from '@mmstack/primitives/core';
import type { MeshTransport, MeshTransportFactory } from './transport';

export type MeshStatus =
  'connecting' | 'live' | 'reconnecting' | 'ejected' | 'closed';

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
  /**
   * The relay refused one of this session's writes: it is not in the room and never will be.
   * `'generation'` — written in a room generation that has since been cut (the whole tail is
   * refused at the welcome that names the new one, or one envelope by the relay's reply);
   * `'schema'` — a data shape older than the room's; `'order'` — a version below this origin's
   * admitted maximum that was never admitted (a second tab on one origin). The session drops
   * the write locally and hydrates from a fresh snapshot; the envelope carries the values, so
   * the application can offer to write them again. Any `whenAcked` waiter rejects.
   */
  onRefused?(env: OpEnvelope, reason: 'generation' | 'schema' | 'order'): void;
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
  /** The room generation a restored outbox was written in; the first welcome decides whether it still holds. */
  readonly instance?: string;
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
 * the relay's per-envelope answers (`drop`), reconnect backoff, presence, eject/reject, the
 * generation fence and settled-vector garbage collection. `meshSync` wraps it for
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
  /**
   * Resolves once the unacknowledged local tail is empty — the acknowledgement barrier a
   * caller awaits before treating its writes as the room's. Resolves immediately when
   * nothing is outstanding. Rejects with the terminal reason if the session ends (eject or
   * close) while entries remain: those writes never reached the room, and every later call
   * rejects the same way.
   *
   * With a relay whose adapter confirms durability before echoing, acknowledged means
   * stored; against a relay that echoes eagerly it means only "the relay has it".
   */
  whenAcked(): Promise<void>;
  /** The unacknowledged local tail (the durable-outbox payload). */
  unackedEnvs(): readonly OpEnvelope[];
  /** The room generation this session is in, once a welcome (or a restored outbox) named one. */
  instance(): string | undefined;
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
  let instance: string | undefined = opt.instance;
  if (instance) sync.adopt(instance);
  // a refusal asks for a fresh snapshot; one hello per burst, cleared by the welcome it earns
  let rehydrating = false;
  let peers: ReadonlyMap<string, PresenceState> = new Map();
  let presenceData: unknown;
  let hasPresence = false;
  let transport: MeshTransport | null = null;
  let attempts = 0;
  let reconnectTimer: unknown;
  let unsubs: (() => void)[] = [];
  let closed = false;
  let ackFailure: Error | undefined;
  const ackWaiters: {
    resolve: () => void;
    reject: (cause: Error) => void;
  }[] = [];

  const releaseAckWaiters = (failure?: Error): void => {
    for (const waiter of ackWaiters.splice(0)) {
      if (failure) waiter.reject(failure);
      else waiter.resolve();
    }
  };

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
    if (unacked.size > 0) {
      // these writes are not in the room and never will be on this session
      ackFailure = new Error(reason ?? state);
      releaseAckWaiters(ackFailure);
    } else {
      releaseAckWaiters();
    }
    unacked.clear();
    transport?.close();
    transport = null;
    peers = new Map();
    hooks.onPeers?.(peers);
    setStatus(state, reason);
  };

  const sendEnv = (env: OpEnvelope): void => {
    // an envelope minted before any generation was known adopts the one this session is in
    let out = env;
    if (env.instance === '' && instance) {
      out = { ...env, instance };
      unacked.set(unackedKey(env), out);
    }
    transport?.send({ t: 'env', room: opt.room, env: out });
  };
  const sendHello = (): void => {
    transport?.send({
      t: 'hello',
      room: opt.room,
      origin: sync.origin,
      proto: MESH_PROTO_VERSION,
      policyVersion: opt.policyVersion,
      seq: lastSeq > 0 ? lastSeq : undefined,
      schemaVersion: opt.schemaVersion,
    });
  };
  const ackOwn = (origin: string, version: number): void => {
    if (!unacked.delete(unackedKey({ origin, version }))) return;
    acked.set(origin, Math.max(acked.get(origin) ?? 0, version));
    hooks.onOutboxChange?.();
    if (unacked.size === 0) releaseAckWaiters();
  };
  const refuse = (env: OpEnvelope, reason: 'generation' | 'schema' | 'order'): void => {
    unacked.delete(unackedKey(env));
    hooks.onRefused?.(env, reason);
    hooks.onOutboxChange?.();
    // "every write was classified" is not "every write was stored": a waiter rejects
    releaseAckWaiters(new Error(`refused: ${reason}`));
  };

  const flushUnacked = (): void => {
    for (const env of unacked.values()) sendEnv(env);
  };

  const applyRemote = (env: SeqEnvelope): void => {
    if (closed) return; // a delta welcome keeps iterating after an eject — nothing lands past it

    if (
      opt.schemaVersion !== undefined &&
      env.schemaVersion !== undefined &&
      env.schemaVersion > opt.schemaVersion
    ) {
      terminal('ejected', 'schema');
      return;
    }
    lastSeq = Math.max(lastSeq, env.seq);
    hooks.onSynced?.();
    if (ownOrigins.has(env.origin)) {
      ackOwn(env.origin, env.version);
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
        const prevSeq = lastSeq;
        if (instanceChanged) {
          // the generation boundary on the client: the tail written in the old one is refused
          // loudly, its acknowledgements mean nothing here, and the new generation's snapshot
          // replaces the whole applied state below
          lastSeq = 0;
          acked.clear();
          for (const env of [...unacked.values()]) refuse(env, 'generation');
        }
        instance = msg.instance;
        sync.adopt(msg.instance);
        rehydrating = false;
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
        if (closed) {
          if (instanceChanged && lastSeq === 0) lastSeq = prevSeq;
          return;
        }
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
      case 'settled':
        sync.settle(msg.settled);
        return;
      case 'drop': {
        const held = unacked.get(unackedKey(msg));
        if (!held) return; // already classified (a duplicate reply after the echo, or an old generation's)
        if (msg.reason === 'duplicate') {
          ackOwn(msg.origin, msg.version); // the room holds it: this is the acknowledgement
          return;
        }
        refuse(held, msg.reason);
        // the refused write is still applied locally: drop and rehydrate from a fresh snapshot
        if (!rehydrating) {
          rehydrating = true;
          lastSeq = 0;
          sendHello();
        }
        return;
      }
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
    sendHello();
  };

  const unsubLocal = sync.subscribe((env) => {
    const violation = checkEnvelope(
      opt.policy,
      env,
      { ...opt.ctx, writer: opt.writer },
      opt.room,
      // the last sequence this client observed; it can only lag the relay's, so a rule that
      // keys off an empty room is at worst more permissive here than it is at the relay
      { seq: lastSeq },
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
    whenAcked: () =>
      ackFailure
        ? Promise.reject(ackFailure)
        : unacked.size === 0
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
              ackWaiters.push({ resolve, reject });
            }),
    unackedEnvs: () => [...unacked.values()],
    instance: () => instance,
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
