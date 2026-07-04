import {
  computed,
  DestroyRef,
  inject,
  Injector,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { MESH_PROTO_VERSION, type ServerMsg } from '@mmstack/mesh-protocol';
import {
  opSync,
  type MergePolicyEntry,
  type OpEnvelope,
} from '@mmstack/primitives';
import type { MeshTransport, MeshTransportFactory } from './transport';

/** A data channel as the P2P engine needs it; opens later, buffers nothing itself. */
export type DataChannelLike = {
  send(frame: string): void;
  onMessage(cb: (frame: string) => void): () => void;
  onOpen(cb: () => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
};

/**
 * Creates one peer link. `polite` assigns the perfect-negotiation role (derived
 * deterministically from origin ordering); `sendSignal` routes offer/answer/ICE payloads
 * through the relay; `signal` delivers the remote side's payloads.
 */
export type PeerConnector = (opt: {
  readonly remote: string;
  readonly polite: boolean;
  readonly sendSignal: (data: unknown) => void;
}) => {
  readonly channel: DataChannelLike;
  signal(data: unknown): void;
  close(): void;
};

/** WebRTC `PeerConnector` implementing the perfect-negotiation pattern. Browser-only. */
export function rtcPeerConnector(config?: RTCConfiguration): PeerConnector {
  return ({ polite, sendSignal }) => {
    const pc = new RTCPeerConnection(config);
    const messageCbs = new Set<(frame: string) => void>();
    const openCbs = new Set<() => void>();
    const closeCbs = new Set<() => void>();
    const pending: string[] = [];
    let dc: RTCDataChannel | null = null;
    let makingOffer = false;
    let ignoreOffer = false;

    const attach = (channel: RTCDataChannel): void => {
      dc = channel;
      channel.onmessage = (e) => {
        for (const cb of [...messageCbs]) cb(String(e.data));
      };
      channel.onopen = () => {
        for (const frame of pending.splice(0)) channel.send(frame);
        for (const cb of [...openCbs]) cb();
      };
      channel.onclose = () => {
        for (const cb of [...closeCbs]) cb();
      };
    };

    if (!polite) attach(pc.createDataChannel('mmstack-mesh'));
    else pc.ondatachannel = (e) => attach(e.channel);

    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal({ ice: e.candidate.toJSON() });
    };
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        sendSignal({ description: pc.localDescription });
      } finally {
        makingOffer = false;
      }
    };

    return {
      channel: {
        send: (frame) => {
          if (dc && dc.readyState === 'open') dc.send(frame);
          else pending.push(frame);
        },
        onMessage: (cb) => (messageCbs.add(cb), () => messageCbs.delete(cb)),
        onOpen: (cb) => (openCbs.add(cb), () => openCbs.delete(cb)),
        onClose: (cb) => (closeCbs.add(cb), () => closeCbs.delete(cb)),
        close: () => dc?.close(),
      },
      signal: async (data) => {
        const { description, ice } = (data ?? {}) as {
          description?: RTCSessionDescriptionInit;
          ice?: RTCIceCandidateInit;
        };
        if (description) {
          const collision =
            description.type === 'offer' &&
            (makingOffer || pc.signalingState !== 'stable');
          ignoreOffer = !polite && collision;
          if (ignoreOffer) return;
          await pc.setRemoteDescription(description);
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            sendSignal({ description: pc.localDescription });
          }
        } else if (ice) {
          try {
            await pc.addIceCandidate(ice);
          } catch (err) {
            if (!ignoreOffer) throw err;
          }
        }
      },
      close: () => {
        dc?.close();
        pc.close();
      },
    };
  };
}

type P2PMsg =
  | { t: 'hello'; wm: Record<string, number> }
  | { t: 'state'; root: unknown; wm: Record<string, number> }
  | { t: 'uptodate' }
  | { t: 'env'; env: OpEnvelope };

export type WebRtcMeshOptions = {
  readonly room: string;
  readonly writer: string;
  /** Signaling path to the relay (ws or direct) — data flows peer-to-peer. */
  readonly signaling: MeshTransportFactory;
  /** Peer link factory; defaults to {@link rtcPeerConnector}. Injectable for tests. */
  readonly connector?: PeerConnector;
  readonly policies?: readonly MergePolicyEntry[];
  readonly policyVersion?: number;
  readonly injector?: Injector;
};

export type WebRtcMeshRef = {
  readonly status: Signal<'connecting' | 'live'>;
  /** Origins with an OPEN data channel. */
  readonly peers: Signal<readonly string[]>;
  close(): void;
};

type Peer = {
  link: ReturnType<PeerConnector>;
  open: boolean;
  unsubs: (() => void)[];
};

/**
 * Peer-to-peer mesh sync (unsequenced topology, op-protocol RFC §4): the relay only signals
 * and tracks membership; envelopes flow over WebRTC data channels and converge via the
 * per-path register map. Catch-up is pairwise: on channel open both sides exchange
 * watermarks; a side whose state is strictly covered hydrates from the other. Two peers that
 * diverged while BOTH held state keep their convergent go-forward guarantees but do not
 * retroactively merge history (same contract as the tab rung).
 */
export function webRtcMesh<T extends object>(
  source: WritableSignal<T>,
  opt: WebRtcMeshOptions,
): WebRtcMeshRef {
  const injector = opt.injector ?? inject(Injector);
  const connector = opt.connector ?? rtcPeerConnector();
  const status = signal<'connecting' | 'live'>('connecting');
  const openPeers = signal<ReadonlySet<string>>(new Set());
  const peers = new Map<string, Peer>();
  let signalingUnsubs: (() => void)[] = [];
  let transport: MeshTransport | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const sync = opSync(source, {
    writer: opt.writer,
    policies: opt.policies,
    policyVersion: opt.policyVersion,
    injector,
  });

  const covered = (
    mine: Record<string, number>,
    theirs: Record<string, number>,
  ): boolean => Object.entries(mine).every(([o, v]) => (theirs[o] ?? 0) >= v);

  const sendTo = (peer: Peer, msg: P2PMsg): void => {
    peer.link.channel.send(JSON.stringify(msg));
  };

  const broadcast = (msg: P2PMsg): void => {
    for (const peer of peers.values()) {
      if (peer.open) sendTo(peer, msg);
    }
  };

  const dropPeer = (origin: string): void => {
    const peer = peers.get(origin);
    if (!peer) return;
    peers.delete(origin);
    for (const unsub of peer.unsubs) unsub();
    peer.link.close();
    openPeers.update((set) => {
      const next = new Set(set);
      next.delete(origin);
      return next;
    });
  };

  const ensurePeer = (origin: string): Peer => {
    let peer = peers.get(origin);
    if (peer) return peer;
    const link = connector({
      remote: origin,
      polite: sync.origin > origin,
      sendSignal: (data) =>
        transport?.send({ t: 'signal', room: opt.room, to: origin, data }),
    });
    peer = { link, open: false, unsubs: [] };
    peers.set(origin, peer);
    peer.unsubs.push(
      link.channel.onOpen(() => {
        peer!.open = true;
        openPeers.update((set) => new Set(set).add(origin));
        sendTo(peer!, { t: 'hello', wm: sync.watermark() });
      }),
      link.channel.onMessage((frame) => {
        let msg: P2PMsg;
        try {
          msg = JSON.parse(frame) as P2PMsg;
        } catch {
          return;
        }
        handlePeerMsg(peer!, msg);
      }),
      link.channel.onClose(() => dropPeer(origin)),
    );
    return peer;
  };

  const handlePeerMsg = (peer: Peer, msg: P2PMsg): void => {
    switch (msg.t) {
      case 'hello': {
        const snap = sync.snapshot();
        if (covered(snap.wm, msg.wm)) sendTo(peer, { t: 'uptodate' });
        else sendTo(peer, { t: 'state', root: snap.root, wm: snap.wm });
        return;
      }
      case 'state': {
        if (covered(sync.watermark(), msg.wm)) {
          sync.hydrate(msg.root as T, msg.wm);
        }
        return;
      }
      case 'uptodate':
        return;
      case 'env':
        sync.receive(msg.env);
        return;
    }
  };

  const handleSignaling = (msg: ServerMsg): void => {
    if (msg.room !== opt.room) return;
    switch (msg.t) {
      case 'welcome':
        for (const origin of msg.members) ensurePeer(origin);
        status.set('live');
        return;
      case 'member':
        if (msg.gone) dropPeer(msg.origin);
        else ensurePeer(msg.origin);
        return;
      case 'signal':
        ensurePeer(msg.from).link.signal(msg.data);
        return;
      case 'reject':
        close();
        return;
    }
  };

  const connectSignaling = (): void => {
    if (closed) return;
    for (const unsub of signalingUnsubs.splice(0)) unsub();
    const t = opt.signaling();
    transport = t;
    signalingUnsubs = [
      t.onMessage(handleSignaling),
      t.onClose(() => {
        if (closed || transport !== t) return;
        transport = null;
        reconnectTimer = setTimeout(connectSignaling, 1000);
      }),
    ];
    t.send({
      t: 'hello',
      room: opt.room,
      origin: sync.origin,
      proto: MESH_PROTO_VERSION,
      policyVersion: opt.policyVersion ?? 0,
    });
  };

  const unsubLocal = sync.subscribe((env) => broadcast({ t: 'env', env }));

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    unsubLocal();
    for (const origin of [...peers.keys()]) dropPeer(origin);
    for (const unsub of signalingUnsubs.splice(0)) unsub();
    transport?.close();
    transport = null;
    sync.destroy();
    status.set('connecting');
  };

  injector.get(DestroyRef).onDestroy(close);
  connectSignaling();

  return {
    status: status.asReadonly(),
    peers: computed(() => [...openPeers()]),
    close,
  };
}
