import {
  computed,
  DestroyRef,
  inject,
  Injector,
  isDevMode,
  runInInjectionContext,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  checkEnvelope,
  MESH_PROTO_VERSION,
  type OpPolicy,
  type PresenceState,
  type PrincipalCtx,
  type SeqEnvelope,
  type ServerMsg,
} from '@mmstack/mesh-protocol';
import {
  opSync,
  registerResource,
  type MergePolicyEntry,
  type OpEnvelope,
  type ResourceLike,
} from '@mmstack/primitives';
import type { MeshTransport, MeshTransportFactory } from './transport';

export type MeshStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'ejected'
  | 'closed';

export type MeshPeer = PresenceState;

export type MeshSyncOptions = {
  readonly room: string;
  /** Opaque principal pseudonym — provided, never minted (op-protocol RFC §3). */
  readonly writer: string;
  readonly transport: MeshTransportFactory;
  /** Per-path merge policies for rebase/convergence (`lww` default). */
  readonly policies?: readonly MergePolicyEntry[];
  /** Emit-side validation, symmetric with the relay's (tripwire honesty). */
  readonly policy?: OpPolicy;
  /** kind/claims of this principal, so a shared policy evaluates identically on both sides. */
  readonly ctx?: Omit<PrincipalCtx, 'writer'>;
  readonly policyVersion?: number;
  /** Exponential backoff cap for reconnects (default 15s; base 500ms + jitter). */
  readonly reconnect?: { readonly maxDelayMs?: number };
  readonly injector?: Injector;
  /** Register with the nearest transition scope so (re)connection surfaces as `pending`. */
  readonly register?: 'track' | 'suspend';
  readonly onEject?: (reason: string) => void;
};

export type MeshSyncRef = {
  readonly status: Signal<MeshStatus>;
  readonly peers: Signal<readonly MeshPeer[]>;
  /** Publish this client's ephemeral presence payload (cursor, section, activity…). */
  setPresence(data: unknown): void;
  close(): void;
};

const RECONNECT_BASE_MS = 500;

/**
 * Replicates a signal store across clients through a relay room: local writes emit stamped
 * envelopes, remote envelopes fold in convergently, reconnects resume via delta or snapshot
 * with unacknowledged local writes rebased on top, and presence rides an ephemeral channel.
 * A synced store reads exactly like a local one — connection state surfaces only through
 * `status` and the transition scope (op-protocol RFC §10).
 */
export function meshSync<T extends object>(
  source: WritableSignal<T>,
  opt: MeshSyncOptions,
): MeshSyncRef {
  const injector = opt.injector ?? inject(Injector);
  const status = signal<MeshStatus>('connecting');
  const peerMap = signal<ReadonlyMap<string, MeshPeer>>(new Map());
  const peers = computed(() => [...peerMap().values()]);
  const policyVersion = opt.policyVersion ?? 0;

  const sync = opSync(source, {
    writer: opt.writer,
    policies: opt.policies,
    policyVersion,
    injector,
  });

  const unacked = new Map<number, OpEnvelope>();
  let highestAcked = 0;
  let lastSeq = 0;
  let epoch: string | undefined;
  let presenceData: unknown;
  let hasPresence = false;
  let transport: MeshTransport | null = null;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubs: (() => void)[] = [];
  let closed = false;

  const terminal = (state: 'ejected' | 'closed', reason?: string): void => {
    closed = true;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    for (const unsub of unsubs.splice(0)) unsub();
    unsubLocal();
    unacked.clear();
    transport?.close();
    transport = null;
    peerMap.set(new Map());
    status.set(state);
    if (reason !== undefined) opt.onEject?.(reason);
  };

  const sendEnv = (env: OpEnvelope): void => {
    transport?.send({ t: 'env', room: opt.room, env });
  };

  const flushUnacked = (): void => {
    for (const env of [...unacked.values()].sort((a, b) => a.version - b.version)) {
      sendEnv(env);
    }
  };

  const handle = (msg: ServerMsg): void => {
    if (msg.room !== opt.room) return;
    switch (msg.t) {
      case 'welcome': {
        if (epoch !== undefined && msg.epoch !== epoch) lastSeq = 0;
        epoch = msg.epoch;
        peerMap.set(new Map(msg.peers.map((p) => [p.origin, p])));
        if (msg.mode === 'delta') {
          for (const env of msg.envs) applyRemote(env);
        } else if (msg.mode === 'snapshot') {
          sync.hydrate(msg.root as T, { [sync.origin]: highestAcked });
          lastSeq = msg.seq;
        } else if (msg.seq === 0 && lastSeq === 0) {
          sync.seed();
        }
        lastSeq = Math.max(lastSeq, msg.seq);
        attempts = 0;
        status.set('live');
        flushUnacked();
        if (hasPresence) transport?.send({ t: 'presence', room: opt.room, data: presenceData });
        return;
      }
      case 'env':
        applyRemote(msg.env);
        return;
      case 'presence': {
        const next = new Map(peerMap());
        if (msg.gone) next.delete(msg.peer.origin);
        else next.set(msg.peer.origin, msg.peer);
        peerMap.set(next);
        return;
      }
      case 'eject':
        if (msg.writer === opt.writer) terminal('ejected', msg.reason);
        return;
      case 'reject':
        terminal('ejected', msg.reason);
        return;
    }
  };

  const applyRemote = (env: SeqEnvelope): void => {
    lastSeq = Math.max(lastSeq, env.seq);
    if (env.origin === sync.origin) {
      unacked.delete(env.version);
      highestAcked = Math.max(highestAcked, env.version);
      return;
    }
    sync.receive(env);
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
        status.set('reconnecting');
        const delay = Math.min(
          opt.reconnect?.maxDelayMs ?? 15_000,
          RECONNECT_BASE_MS * 2 ** attempts++,
        );
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, delay + Math.random() * 100);
      }),
    ];
    t.send({
      t: 'hello',
      room: opt.room,
      origin: sync.origin,
      proto: MESH_PROTO_VERSION,
      policyVersion,
      seq: lastSeq > 0 ? lastSeq : undefined,
    });
  };

  const unsubLocal = sync.subscribe((env) => {
    const violation = checkEnvelope(opt.policy, env, { ...opt.ctx, writer: opt.writer });
    if (violation) {
      if (isDevMode()) {
        console.warn('[@mmstack/mesh] local write violates the room policy — not sent', violation);
      }
      return;
    }
    unacked.set(env.version, env);
    if (status() === 'live') sendEnv(env);
  });

  if (opt.register) {
    const connection: ResourceLike = {
      status: computed(() => {
        const s = status();
        return s === 'connecting'
          ? 'loading'
          : s === 'reconnecting'
            ? 'reloading'
            : s === 'ejected'
              ? 'error'
              : 'resolved';
      }),
      isLoading: computed(
        () => status() === 'connecting' || status() === 'reconnecting',
      ),
      hasValue: () => true,
    };
    runInInjectionContext(injector, () =>
      registerResource(connection, { suspends: opt.register === 'suspend' }),
    );
  }

  injector.get(DestroyRef).onDestroy(() => {
    if (!closed) terminal('closed');
    unsubLocal();
    sync.destroy();
  });

  connect();

  return {
    status: status.asReadonly(),
    peers,
    setPresence: (data) => {
      presenceData = data;
      hasPresence = true;
      if (status() === 'live') {
        transport?.send({ t: 'presence', room: opt.room, data });
      }
    },
    close: () => {
      if (!closed) terminal('closed');
      unsubLocal();
      sync.destroy();
    },
  };
}
