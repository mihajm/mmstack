import {
  inject,
  Injector,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  opSync,
  type MergePolicyEntry,
  type OpEnvelope,
  type OpSyncCheckpoint,
} from '@mmstack/primitives/core';
import {
  defaultPeerChannels,
  peerLinks,
  type PeerChannelSpec,
  type PeerConnector,
  type PeerLinks,
} from './peer-links';
import type { MeshTransportFactory } from './transport';

export {
  rtcPeerConnector,
  type DataChannelLike,
  type PeerConnector,
} from './peer-links';

type P2PMsg =
  | { t: 'hello'; wm: Record<string, number> }
  // the full checkpoint (root + register state + watermark), NOT a bare value: the covered
  // side must inherit supersession state or already-superseded stragglers would resurrect
  | { t: 'state'; state: OpSyncCheckpoint<object> }
  | { t: 'uptodate' }
  | { t: 'env'; env: OpEnvelope };

export type WebRtcMeshOptions = {
  readonly room: string;
  readonly writer: string;
  /**
   * This replica's origin, its identity in the room; defaults to a random id per instance.
   * One origin is one seat, so never share one between two live instances.
   */
  readonly origin?: string;
  /** Signaling path to the relay (ws or direct) — data flows peer-to-peer. */
  readonly signaling: MeshTransportFactory;
  /** Peer link factory; defaults to {@link rtcPeerConnector}. Injectable for tests. */
  readonly connector?: PeerConnector;
  /**
   * Further channels every link carries beside the mesh's own reliable one, for consumers
   * that share the links (`rtcPresence`, say). Reach them through {@link WebRtcMeshRef.links}.
   */
  readonly channels?: readonly PeerChannelSpec[];
  readonly policies?: readonly MergePolicyEntry[];
  readonly policyVersion?: number;
  readonly injector?: Injector;
};

export type WebRtcMeshRef = {
  /** This replica's origin: what other peers see this side as, in `peers` and on the wire. */
  readonly origin: string;
  readonly status: Signal<'connecting' | 'live'>;
  /** Origins with an OPEN data channel. */
  readonly peers: Signal<readonly string[]>;
  /** The links the mesh runs on; other channels asked for in `channels` are sent on these. */
  readonly links: PeerLinks;
  close(): void;
};

/**
 * Peer-to-peer mesh sync: the relay only signals
 * and tracks membership; envelopes flow over WebRTC data channels and converge via the
 * per-path register map. Catch-up is pairwise: on channel open both sides exchange
 * watermarks; a side whose state is strictly covered hydrates from the other's FULL
 * checkpoint (root + per-path register state + watermark), so supersession and precedence
 * carry over intact: a late joiner is indistinguishable from a peer that saw every
 * envelope. Two peers that each hold envelopes the other lacks keep their convergent
 * go-forward guarantees but do not exchange the missed envelopes retroactively.
 *
 * There is no relay admission here: no sequence, no generation, no refusals. Beside a
 * relay-backed session over the same document a peer channel may hand on only envelopes the
 * relay has sequenced, never a peer's own unacknowledged writes.
 */
export function webRtcMesh<T extends object>(
  source: WritableSignal<T>,
  opt: WebRtcMeshOptions,
): WebRtcMeshRef {
  const injector = opt.injector ?? inject(Injector);
  const meshChannel = defaultPeerChannels[0];
  let closed = false;

  const sync = opSync(source, {
    writer: opt.writer,
    origin: opt.origin,
    policies: opt.policies,
    policyVersion: opt.policyVersion,
    injector,
  });

  // subscribe before signaling starts: a link can open, and its first frame arrive, while
  // the hello is still being answered
  const links = peerLinks({
    room: opt.room,
    origin: sync.origin,
    signaling: opt.signaling,
    connector: opt.connector,
    channels: [
      meshChannel,
      ...(opt.channels ?? []).filter((c) => c.label !== meshChannel.label),
    ],
    policyVersion: opt.policyVersion,
    autoConnect: false,
    injector,
  });

  const covered = (
    mine: Record<string, number>,
    theirs: Record<string, number>,
  ): boolean => Object.entries(mine).every(([o, v]) => (theirs[o] ?? 0) >= v);

  const sendTo = (origin: string, msg: P2PMsg): void => {
    links.send(origin, JSON.stringify(msg));
  };

  const handlePeerMsg = (origin: string, msg: P2PMsg): void => {
    switch (msg.t) {
      case 'hello': {
        const snap = sync.snapshot();
        if (covered(snap.wm, msg.wm)) sendTo(origin, { t: 'uptodate' });
        else sendTo(origin, { t: 'state', state: snap });
        return;
      }
      case 'state': {
        if (covered(sync.watermark(), msg.state.wm)) {
          sync.hydrate(msg.state as OpSyncCheckpoint<T>);
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

  links.onOpen((origin, channel) => {
    if (channel === meshChannel.label)
      sendTo(origin, { t: 'hello', wm: sync.watermark() });
  });
  links.onMessage((origin, frame, channel) => {
    if (channel !== meshChannel.label) return;
    let msg: P2PMsg;
    try {
      msg = JSON.parse(frame) as P2PMsg;
    } catch {
      return;
    }
    handlePeerMsg(origin, msg);
  });

  const unsubLocal = sync.subscribe((env) =>
    links.broadcast(JSON.stringify({ t: 'env', env } satisfies P2PMsg)),
  );

  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubLocal();
    links.close();
    sync.destroy();
  };

  // a relay reject ends the links; the mesh ends with them
  links.onEnd(close);
  links.connect();

  return {
    origin: sync.origin,
    status: links.status,
    peers: links.peers,
    links,
    close,
  };
}
