import {
  computed,
  DestroyRef,
  inject,
  Injector,
  isDevMode,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import {
  MESH_PROTO_VERSION,
  type ClientSignalMsg,
  type IceServer,
  type ServerMsg,
} from '@mmstack/mesh-protocol';
import {
  emptyLifecycle,
  retryDelay,
  step,
  type LifecycleEffect,
  type LifecycleEvent,
} from './peer-lifecycle';
import type { MeshTransport, MeshTransportFactory } from './transport';

/** A data channel as the P2P engine needs it; opens later, buffers nothing itself. */
export type DataChannelLike = {
  send(frame: string): void;
  onMessage(cb: (frame: string) => void): () => void;
  onOpen(cb: () => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
};

/** One data channel on a peer link. `ordered: false` + `maxRetransmits: 0` makes it lossy. */
export type PeerChannelSpec = {
  readonly label: string;
  readonly ordered?: boolean;
  readonly maxRetransmits?: number;
};

/** How many signals are held for replay while a connection waits for its welcome. */
const HELD_SIGNALS = 256;

/** The single reliable channel every link carries when no channels are asked for. */
export const defaultPeerChannels: readonly PeerChannelSpec[] = [
  { label: 'mmstack-mesh' },
];

/**
 * Creates one peer link. `polite` assigns the perfect-negotiation role (derived
 * deterministically from origin ordering); `sendSignal` routes offer/answer/ICE payloads
 * through the relay; `signal` delivers the remote side's payloads. Object payloads gain a
 * `link` field on the way out (the sending link's instance id) and, once the remote instance
 * is known, a `to` field; both are stripped before `signal` sees the payload.
 *
 * `channels` lists the labelled channels the link carries; `channel` is the first of them and
 * `channels` (by label) all of them. A connector that returns only `channel` supports a single
 * channel. Signal payloads carry no channel field: one link per remote carries every channel,
 * so nothing needs routing. The field name `ch` is kept free for a future where it does.
 *
 * `onClose`, when the connector has it, reports the link as a whole finished even if no channel
 * said so; the links then rebuild it.
 */
export type PeerConnector = (opt: {
  readonly remote: string;
  readonly polite: boolean;
  readonly sendSignal: (data: unknown) => void;
  readonly channels: readonly PeerChannelSpec[];
  /** ICE servers the relay issued in the last welcome, if any. */
  readonly iceServers?: readonly IceServer[];
}) => {
  readonly channel: DataChannelLike;
  readonly channels?: Readonly<Record<string, DataChannelLike>>;
  signal(data: unknown): void;
  /** Fires once when the link as a whole is gone, whether or not its channels reported it. */
  onClose?(cb: () => void): () => void;
  close(): void;
};

/**
 * WebRTC `PeerConnector` implementing the perfect-negotiation pattern. Browser-only.
 *
 * `config` is the static configuration; ICE servers the relay issues replace its `iceServers`.
 * Without any ICE servers browsers hide host addresses behind mDNS names, so links only form
 * on one network segment. When ICE fails, or stays `disconnected` longer than
 * `disconnectGraceMs` (default 5000), the connector restarts ICE once. A second failure before
 * the link connects again, a closed connection, or a negotiation step the browser rejects
 * reports the link gone through `onClose`.
 */
export function rtcPeerConnector(
  config?: RTCConfiguration,
  opt?: { readonly disconnectGraceMs?: number },
): PeerConnector {
  const graceMs = opt?.disconnectGraceMs ?? 5000;
  return ({
    polite,
    sendSignal,
    channels = defaultPeerChannels,
    iceServers,
  }) => {
    const pc = new RTCPeerConnection(
      iceServers
        ? {
            ...config,
            iceServers: iceServers.map((server) => ({
              ...server,
              urls:
                typeof server.urls === 'string'
                  ? server.urls
                  : [...server.urls],
            })),
          }
        : config,
    );
    let makingOffer = false;
    let ignoreOffer = false;
    const goneCbs = new Set<() => void>();
    let finished = false;
    let restartTried = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const clearGrace = (): void => {
      if (grace !== undefined) clearTimeout(grace);
      grace = undefined;
    };
    const reportGone = (): void => {
      if (finished) return;
      finished = true;
      clearGrace();
      for (const cb of [...goneCbs]) cb();
    };
    // one ICE restart per connected period; a second failure is the end of the link
    const failed = (): void => {
      if (finished) return;
      if (restartTried) return reportGone();
      restartTried = true;
      pc.restartIce();
    };
    const rejected = (step: string, err: unknown): void => {
      if (finished || pc.signalingState === 'closed') return;
      if (isDevMode()) {
        console.warn(
          `[@mmstack/mesh] a peer link could not ${step}; it will be rebuilt`,
          err,
        );
      }
      reportGone();
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        clearGrace();
        restartTried = false;
      } else if (state === 'failed') {
        clearGrace();
        failed();
      } else if (state === 'disconnected' && grace === undefined) {
        grace = setTimeout(() => {
          grace = undefined;
          const now = pc.iceConnectionState;
          if (now === 'disconnected' || now === 'failed') failed();
        }, graceMs);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'closed') reportGone();
    };

    const makeChannel = () => {
      const messageCbs = new Set<(frame: string) => void>();
      const openCbs = new Set<() => void>();
      const closeCbs = new Set<() => void>();
      const pending: string[] = [];
      let dc: RTCDataChannel | null = null;
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
      const like: DataChannelLike = {
        send: (frame) => {
          if (dc && dc.readyState === 'open') dc.send(frame);
          else pending.push(frame);
        },
        onMessage: (cb) => (messageCbs.add(cb), () => messageCbs.delete(cb)),
        onOpen: (cb) => (openCbs.add(cb), () => openCbs.delete(cb)),
        onClose: (cb) => (closeCbs.add(cb), () => closeCbs.delete(cb)),
        close: () => dc?.close(),
      };
      return { attach, like };
    };

    const made = new Map(channels.map((c) => [c.label, makeChannel()]));

    // the impolite side opens every channel; the polite side adopts them by label
    if (!polite) {
      for (const spec of channels) {
        const init: RTCDataChannelInit = {};
        if (spec.ordered !== undefined) init.ordered = spec.ordered;
        if (spec.maxRetransmits !== undefined)
          init.maxRetransmits = spec.maxRetransmits;
        made.get(spec.label)?.attach(pc.createDataChannel(spec.label, init));
      }
    } else {
      pc.ondatachannel = (e) => made.get(e.channel.label)?.attach(e.channel);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal({ ice: e.candidate.toJSON() });
    };
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        sendSignal({ description: pc.localDescription });
      } catch (err) {
        rejected('make an offer', err);
      } finally {
        makingOffer = false;
      }
    };

    const byLabel: Record<string, DataChannelLike> = {};
    for (const [label, ch] of made) byLabel[label] = ch.like;

    return {
      channel: byLabel[channels[0].label],
      channels: byLabel,
      signal: async (data) => {
        if (pc.signalingState === 'closed') return;
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
          try {
            await pc.setRemoteDescription(description);
            if (description.type === 'offer') {
              await pc.setLocalDescription();
              sendSignal({ description: pc.localDescription });
            }
          } catch (err) {
            rejected('apply the remote description', err);
          }
        } else if (ice) {
          try {
            await pc.addIceCandidate(ice);
          } catch (err) {
            if (!ignoreOffer) throw err;
          }
        }
      },
      onClose: (cb) => (goneCbs.add(cb), () => goneCbs.delete(cb)),
      close: () => {
        finished = true;
        clearGrace();
        for (const ch of made.values()) ch.like.close();
        pc.close();
      },
    };
  };
}

/**
 * A relay connection someone else owns (a live session, say). Peer links ride on it without
 * saying hello, so the links share that connection's origin and room membership.
 */
export type SignalingPort = {
  /** Current relay membership for this room, or undefined until welcomed. Read after subscribing. */
  members(): readonly string[] | undefined;
  /** ICE servers from the owner's last welcome, if it keeps them. Read after subscribing. */
  iceServers?(): readonly IceServer[] | undefined;
  send(msg: ClientSignalMsg): void;
  onMessage(cb: (msg: ServerMsg) => void): () => void;
};

export type PeerLinksOptions = {
  readonly room: string;
  /** This side's origin; also decides the perfect-negotiation role against each remote. */
  readonly origin: string;
  /**
   * A transport factory means the links own their relay connection (hello, reconnect); a
   * {@link SignalingPort} means they ride on one that is already joined.
   */
  readonly signaling: MeshTransportFactory | SignalingPort;
  /** Peer link factory; defaults to {@link rtcPeerConnector}. Injectable for tests. */
  readonly connector?: PeerConnector;
  /**
   * The channels every link carries, first one the default for `send` and `broadcast`.
   * Defaults to {@link defaultPeerChannels}. Both sides must ask for the same labels.
   */
  readonly channels?: readonly PeerChannelSpec[];
  /** Sent in the hello when the links own their connection. */
  readonly policyVersion?: number;
  /**
   * `false` defers signaling until {@link PeerLinks.connect}, so a consumer can subscribe
   * before the first link opens. Defaults to `true`.
   */
  readonly autoConnect?: boolean;
  /** How long a link may take to open every channel before it counts as lost. Default 15000. */
  readonly openTimeoutMs?: number;
  /** Backoff bounds for rebuilding a lost link. Defaults 1000 and 30000. */
  readonly retry?: { readonly minMs?: number; readonly maxMs?: number };
  /** Random source for the backoff jitter; tests pass a seeded one. Default Math.random. */
  readonly random?: () => number;
  readonly injector?: Injector;
};

export type PeerLinks = {
  /**
   * `live` once the relay has welcomed this side (or, over a port, once it has seen a
   * welcome); back to `connecting` while an owned relay connection is being re-established.
   * Peer links outlive that: they are retired only by their own close or a relay `gone`. Over
   * a port the same holds across the session's socket drops; when the session itself ends, the
   * port reports `gone` for every member and the links are retired with it.
   */
  readonly status: Signal<'connecting' | 'live'>;
  /** Origins whose link has every channel open. */
  readonly peers: Signal<readonly string[]>;
  /** Members whose link was lost at least once since it last opened: waiting to rebuild, or rebuilding. */
  readonly stalled: Signal<readonly string[]>;
  /**
   * Other origins in the room as the relay reports them (welcome, then join and leave). The
   * relay is the authority on who is present; a link can outlive a dead socket for a while.
   */
  readonly members: Signal<readonly string[]>;
  /** Replays current membership synchronously, then reports every change without coalescing. */
  onMembers(cb: (members: readonly string[]) => void): () => void;
  /** The labels every link carries, in the order they were asked for. */
  readonly channels: readonly string[];
  /** Fires when one channel of a link opens; replays channels that are already open. */
  onOpen(cb: (origin: string, channel: string) => void): () => void;
  onMessage(
    cb: (origin: string, frame: string, channel: string) => void,
  ): () => void;
  /**
   * Fires when a link goes away: a channel closed, the connector reported it gone, it did not
   * open in time, or the relay reported the origin gone. A lost link is rebuilt while the relay
   * lists its origin.
   */
  onClose(cb: (origin: string) => void): () => void;
  /** Fires once when the links shut down: `close()`, or the relay rejected the hello. */
  onEnd(cb: () => void): () => void;
  /** Sends on one open channel; a frame for a channel that is not open is dropped. */
  send(origin: string, frame: string, channel?: string): void;
  /** Sends on the channel of every link where it is open. */
  broadcast(frame: string, channel?: string): void;
  /** Starts signaling when created with `autoConnect: false`; a no-op otherwise. */
  connect(): void;
  close(): void;
};

type Peer = {
  /** This side's instance id for the link, carried in every signal payload it sends. */
  readonly id: string;
  /** The remote side's instance id, bound by the first signal that carries one. */
  remote?: string;
  link: ReturnType<PeerConnector>;
  channels: Map<string, { channel: DataChannelLike; open: boolean }>;
  unsubs: (() => void)[];
};

/**
 * A signal payload split into its addressing and the connector's part: `link` is the sending
 * instance, `to` the receiving instance it was bound to when it sent (absent until it is).
 */
const unwrapSignal = (
  data: unknown,
): { link?: string; to?: string; payload?: unknown } => {
  if (typeof data !== 'object' || data === null) return { payload: data };
  const { link, to, ...rest } = data as { link?: unknown; to?: unknown };
  if (typeof link !== 'string') return { payload: data };
  return {
    link,
    to: typeof to === 'string' ? to : undefined,
    payload: Object.keys(rest).length ? rest : undefined,
  };
};

/**
 * The link layer under peer-to-peer consumers: one peer connection per remote origin in the
 * room, set up from relay membership and negotiated over relay `signal` frames. Each link
 * carries the same labelled channels; frames are opaque strings, what they mean is the
 * consumer's business.
 *
 * An origin is one seat: the relay hands a second connection with the same origin the seat
 * and reports it to the room as a plain join. Links tell seats apart by instance, not by
 * order: every link announces a random instance id in its signals and, once it knows the
 * instance across, addresses its signals to it. A signal addressed to an instance this side
 * no longer has is dropped. An unaddressed signal from an instance other than the one linked
 * is a new seat or a restarted link, and this side rebuilds its end, addressed; an addressed
 * one from a new instance is adopted. Only unaddressed signals cause a rebuild and a rebuilt
 * end never sends one, so a takeover settles in one exchange. Two tabs with the same origin
 * still take the seat from each other on every reconnect; give each tab its own origin.
 *
 * A link that does not open every channel within `openTimeoutMs`, loses a channel, or is
 * reported gone by its connector is dropped and rebuilt after a jittered, capped backoff, for
 * as long as the relay lists its origin; a welcome or a join rebuilds at once. Either side may
 * rebuild: its new instance announces itself unaddressed, which makes the other side rebuild
 * its end addressed to it, as for a takeover. `stalled` lists the origins in that state.
 *
 * No link is built before the welcome of the connection it signals over: joins before it are
 * superseded by the welcome's roster and signals are held and replayed after it, so every link
 * is built with that welcome's ICE servers and never an earlier connection's.
 */
export function peerLinks(opt: PeerLinksOptions): PeerLinks {
  const injector = opt.injector ?? inject(Injector);
  const connector = opt.connector ?? rtcPeerConnector();
  const specs = opt.channels?.length ? opt.channels : defaultPeerChannels;
  const labels = specs.map((c) => c.label);
  const primary = labels[0];
  const status = signal<'connecting' | 'live'>('connecting');
  const openPeers = signal<ReadonlySet<string>>(new Set());
  const members = signal<ReadonlySet<string>>(new Set());
  const peers = new Map<string, Peer>();
  const lifecycle = signal(emptyLifecycle);
  // one timer slot per origin: the open timeout or the rebuild timer, never both
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const openTimeoutMs = opt.openTimeoutMs ?? 15_000;
  const bounds = {
    minMs: opt.retry?.minMs ?? 1000,
    maxMs: opt.retry?.maxMs ?? 30_000,
  };
  const random = opt.random ?? Math.random;
  // the relay's ICE servers from the last welcome; undefined leaves the connector's own
  let iceServers: readonly IceServer[] | undefined;
  const openCbs = new Set<(origin: string, channel: string) => void>();
  const messageCbs = new Set<
    (origin: string, frame: string, channel: string) => void
  >();
  const closeCbs = new Set<(origin: string) => void>();
  const endCbs = new Set<() => void>();
  const memberCbs = new Set<(members: readonly string[]) => void>();
  let signalingUnsubs: (() => void)[] = [];
  let transport: MeshTransport | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connected = false;
  let closed = false;
  // no link is built before the welcome of the connection it signals over, so every link
  // carries that welcome's ICE servers: joins are ignored and signals held until then
  let welcomed = false;
  let held: Extract<ServerMsg, { t: 'signal' }>[] = [];
  let heldWarned = false;
  // links are told apart by instance, never by order: a random tag plus a counter
  const tag = Math.random().toString(36).slice(2, 10);
  let linkSeq = 0;

  const port: SignalingPort | null =
    typeof opt.signaling === 'function' ? null : opt.signaling;
  const sendSignal = (msg: ClientSignalMsg): void => {
    if (port) port.send(msg);
    else transport?.send(msg);
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
    for (const cb of [...closeCbs]) cb(origin);
  };

  /**
   * Builds the link to `origin`; `remote` is the instance on the other side when the link is
   * built in answer to one of its signals, so everything this side sends is addressed to it.
   */
  const ensurePeer = (origin: string, remote?: string): Peer => {
    const existing = peers.get(origin);
    if (existing) return existing;
    const id = `${tag}.${++linkSeq}`;
    // signals the connector sends while it is still being built wait until the peer is
    // registered, so the remote's synchronous answer finds it instead of building another
    let building: unknown[] | null = [];
    let retired = false;
    const signal = (data: unknown): void => {
      if (retired) return;
      if (building) {
        building.push(data);
        return;
      }
      const stamped =
        typeof data === 'object' && data !== null
          ? {
              ...data,
              link: id,
              ...(p.remote === undefined ? {} : { to: p.remote }),
            }
          : data;
      sendSignal({ t: 'signal', room: opt.room, to: origin, data: stamped });
    };
    const link = connector({
      remote: origin,
      polite: opt.origin > origin,
      sendSignal: signal,
      channels: specs,
      ...(iceServers ? { iceServers } : {}),
    });
    const p: Peer = {
      id,
      remote,
      link,
      channels: new Map(),
      unsubs: [() => (retired = true)],
    };
    peers.set(origin, p);
    const lost = (): void => {
      if (peers.get(origin) === p) feed({ t: 'lost', origin });
    };
    if (link.onClose) p.unsubs.push(link.onClose(lost));
    const early = building;
    building = null;
    // announce the instance, so a side that still holds a link to an earlier seat of this
    // origin (a takeover the relay reports as a plain join) replaces it
    signal({});
    for (const data of early) signal(data);
    for (const label of labels) {
      const channel =
        link.channels?.[label] ??
        (label === primary ? link.channel : undefined);
      if (!channel) {
        if (isDevMode()) {
          console.warn(
            `[@mmstack/mesh] the peer connector returned no channel labelled '${label}'`,
          );
        }
        continue;
      }
      const state = { channel, open: false };
      p.channels.set(label, state);
      p.unsubs.push(
        channel.onOpen(() => {
          state.open = true;
          if (
            peers.get(origin) === p &&
            labels.every((l) => p.channels.get(l)?.open)
          ) {
            openPeers.update((set) => new Set(set).add(origin));
            feed({ t: 'opened', origin });
            // a link rebuilt by a takeover opens while its origin is already open to the
            // lifecycle, which then ignores the report: its open timeout ends here all the same
            if (untracked(lifecycle).get(origin)?.state === 'open')
              disarm(origin);
          }
          for (const cb of [...openCbs]) cb(origin, label);
        }),
        channel.onMessage((frame) => {
          for (const cb of [...messageCbs]) cb(origin, frame, label);
        }),
        channel.onClose(lost),
      );
    }
    return p;
  };

  const disarm = (origin: string): void => {
    const timer = timers.get(origin);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(origin);
  };

  const arm = (origin: string, ms: number, fire: LifecycleEvent): void => {
    disarm(origin);
    const timer = setTimeout(() => {
      if (timers.get(origin) !== timer) return;
      timers.delete(origin);
      feed(fire);
    }, ms);
    timers.set(origin, timer);
  };

  const execute = (f: LifecycleEffect, remote?: string): void => {
    switch (f.t) {
      case 'drop':
        return dropPeer(f.origin);
      case 'disarm':
        return disarm(f.origin);
    }
    if (closed) return;
    switch (f.t) {
      case 'build':
        ensurePeer(f.origin, remote);
        return;
      case 'armOpen':
        return arm(f.origin, openTimeoutMs, { t: 'lost', origin: f.origin });
      case 'armRetry':
        return arm(f.origin, retryDelay(f.attempt, bounds, random), {
          t: 'due',
          origin: f.origin,
        });
    }
  };

  /**
   * Steps the lifecycle and runs its effects in order. The new state is stored first, so an
   * event an effect causes on the spot (a link that opens while it is built) steps from it.
   * `remote` addresses the build of a link made in answer to a signal.
   */
  function feed(e: LifecycleEvent, remote?: string): void {
    const { next, effects } = step(untracked(lifecycle), e);
    if (next !== untracked(lifecycle)) lifecycle.set(next);
    for (const f of effects) execute(f, remote);
  }

  const setMembers = (origins: readonly string[]): void => {
    const next = new Set(origins);
    members.set(next);
    for (const cb of [...memberCbs]) cb([...next]);
  };

  const welcomeMembers = (
    origins: readonly string[],
    ice: readonly IceServer[] | undefined,
  ): void => {
    setMembers(origins);
    iceServers = ice;
    welcomed = true;
    status.set('live');
    feed({ t: 'welcome', members: origins });
    const replay = held;
    held = [];
    for (const msg of replay) {
      if (closed) return;
      handleSignaling(msg);
    }
  };

  const handleSignaling = (msg: ServerMsg): void => {
    if (closed || msg.room !== opt.room) return;
    if (!welcomed && msg.t !== 'welcome' && msg.t !== 'reject') {
      // the welcome's roster supersedes joins before it; a leave discards what the origin sent
      if (msg.t === 'signal') {
        if (held.length < HELD_SIGNALS) held.push(msg);
        else if (isDevMode() && !heldWarned) {
          heldWarned = true;
          console.warn(
            `[@mmstack/mesh] more than ${HELD_SIGNALS} signals arrived before the welcome; the rest are dropped`,
          );
        }
      } else if (msg.t === 'member' && msg.gone) {
        held = held.filter((h) => h.from !== msg.origin);
      }
      return;
    }
    switch (msg.t) {
      case 'welcome':
        welcomeMembers(msg.members, msg.ice);
        return;
      case 'member':
        setMembers(
          msg.gone
            ? [...members()].filter((origin) => origin !== msg.origin)
            : [...new Set([...members(), msg.origin])],
        );
        feed({ t: msg.gone ? 'gone' : 'listed', origin: msg.origin });
        return;
      case 'signal': {
        if (!members().has(msg.from)) {
          // the relay routes signals among members only and reports a join before the
          // joiner's first signal; anything else must not become a link that retries forever
          if (isDevMode()) {
            console.warn(
              `[@mmstack/mesh] dropped a signal from '${msg.from}', which the relay does not list`,
            );
          }
          return;
        }
        const { link, to, payload } = unwrapSignal(msg.data);
        let peer = peers.get(msg.from);
        if (link === undefined || (!peer && to === undefined)) {
          // no link to this member (lost and waiting to rebuild): its announce is the reason
          // to build now, addressed to its instance if stamped
          if (!peer) feed({ t: 'listed', origin: msg.from }, link);
          peer = peers.get(msg.from);
          if (!peer) return;
        } else if (to !== undefined && to !== peer?.id) {
          // addressed to an instance this side no longer has: a retired link's leftovers
          return;
        } else if (!peer) {
          return;
        } else if (peer.remote === undefined) {
          peer.remote = link;
        } else if (peer.remote !== link) {
          if (to === undefined) {
            // a new instance over there that does not know this side yet: a new seat or a
            // restarted link, so this side rebuilds, addressing it, which is what makes the
            // rebuild final: the other side never rebuilds in answer to an addressed signal.
            // It replaces the instance, not a lost link: the lifecycle state stays and only
            // the open timeout moves to the new instance.
            dropPeer(msg.from);
            arm(msg.from, openTimeoutMs, { t: 'lost', origin: msg.from });
            peer = ensurePeer(msg.from, link);
          } else {
            // built for this very instance, so it is the newer end of this link: adopt it
            peer.remote = link;
          }
        }
        if (payload !== undefined) peer.link.signal(payload);
        return;
      }
      case 'reject':
        close();
        return;
    }
  };

  const connectSignaling = (): void => {
    if (closed) return;
    for (const unsub of signalingUnsubs.splice(0)) unsub();
    if (port) {
      const unsub = port.onMessage(handleSignaling);
      if (closed) {
        unsub();
        return;
      }
      signalingUnsubs = [unsub];
      const current = port.members();
      if (current !== undefined) welcomeMembers(current, port.iceServers?.());
      return;
    }
    const t = (opt.signaling as MeshTransportFactory)();
    transport = t;
    signalingUnsubs = [
      t.onMessage(handleSignaling),
      t.onClose(() => {
        if (closed || transport !== t) return;
        transport = null;
        welcomed = false;
        held = [];
        status.set('connecting');
        reconnectTimer = setTimeout(connectSignaling, 1000);
      }),
    ];
    t.send({
      t: 'hello',
      room: opt.room,
      origin: opt.origin,
      proto: MESH_PROTO_VERSION,
      policyVersion: opt.policyVersion ?? 0,
    });
  };

  const connect = (): void => {
    if (connected || closed) return;
    connected = true;
    connectSignaling();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    held = [];
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    feed({ t: 'close' });
    // a takeover's open timeout on a link the lifecycle already counts open
    for (const origin of [...timers.keys()]) disarm(origin);
    for (const origin of [...peers.keys()]) dropPeer(origin);
    for (const unsub of signalingUnsubs.splice(0)) unsub();
    transport?.close();
    transport = null;
    setMembers([]);
    memberCbs.clear();
    status.set('connecting');
    for (const cb of [...endCbs]) cb();
    endCbs.clear();
  };

  const openChannel = (origin: string, label: string) => {
    const state = peers.get(origin)?.channels.get(label);
    return state?.open ? state.channel : null;
  };

  injector.get(DestroyRef).onDestroy(close);
  if (opt.autoConnect !== false) connect();

  return {
    status: status.asReadonly(),
    peers: computed(() => [...openPeers()]),
    stalled: computed(() =>
      [...lifecycle()].filter(([, e]) => e.stalled).map(([origin]) => origin),
    ),
    members: computed(() => [...members()]),
    onMembers: (cb) => {
      if (!closed) memberCbs.add(cb);
      cb([...members()]);
      return () => memberCbs.delete(cb);
    },
    channels: labels,
    onOpen: (cb) => {
      openCbs.add(cb);
      for (const [origin, peer] of peers) {
        for (const [label, state] of peer.channels) {
          if (state.open) cb(origin, label);
        }
      }
      return () => openCbs.delete(cb);
    },
    onMessage: (cb) => (messageCbs.add(cb), () => messageCbs.delete(cb)),
    onClose: (cb) => (closeCbs.add(cb), () => closeCbs.delete(cb)),
    onEnd: (cb) => (endCbs.add(cb), () => endCbs.delete(cb)),
    send: (origin, frame, channel = primary) => {
      openChannel(origin, channel)?.send(frame);
    },
    broadcast: (frame, channel = primary) => {
      for (const origin of peers.keys())
        openChannel(origin, channel)?.send(frame);
    },
    connect,
    close,
  };
}
