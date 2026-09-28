import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { throttled } from '@mmstack/primitives/core';
import type { PeerChannelSpec, PeerLinks } from './peer-links';

/**
 * The channel `rtcPresence` uses by default. Lossy and unordered on purpose: a pointer that
 * waits for a retransmit is already stale, and ordering would hold newer frames behind it.
 * Put it in the `channels` of the {@link PeerLinks} the presence rides on.
 */
export const presenceChannel: PeerChannelSpec = {
  label: 'mmstack-presence',
  ordered: false,
  maxRetransmits: 0,
};

/**
 * What goes over the wire. `seq` counts frames sent on one channel of one links object, in
 * send order, and is shared by every sender created on those links; it never restarts while
 * the links live. It orders frames of one link only, and is never compared across links.
 */
export type PresenceFrame<T> = {
  readonly seq: number;
  readonly value: T;
};

export type RtcPresenceOptions = {
  /** The channel label on the links; defaults to {@link presenceChannel}'s. */
  readonly channel?: string;
  /** Minimum gap between two published frames. Defaults to 33 ms (about 30 per second). */
  readonly throttleMs?: number;
  /**
   * Who is in the room, from the relay. A value is held only for an origin in it: a peer link
   * can outlive the relay membership on a dead socket, so the link is not proof of presence.
   * Subscribe synchronously with the current roster, then report every transition, including
   * a leave followed immediately by a rejoin. Use `links.onMembers` for the links' relay roster.
   * A sampled signal or an effect cannot preserve these transitions.
   */
  readonly roster: (cb: (members: readonly string[]) => void) => () => void;
  readonly injector?: Injector;
};

export type RtcPresenceRef<T> = {
  /** Publishes this side's value; throttled, and the last value of a burst always goes out. */
  set(value: T): void;
  /** The latest value per origin, only for origins in the roster. */
  readonly peers: Signal<ReadonlyMap<string, T>>;
  /** Stops publishing and forgets every held value. The links stay open. */
  close(): void;
};

const none = Symbol('none');

// one send counter per links object and channel, shared by every sender created on them
const counters = new WeakMap<PeerLinks, Map<string, { seq: number }>>();
const counterOf = (links: PeerLinks, label: string): { seq: number } => {
  let byLabel = counters.get(links);
  if (!byLabel) counters.set(links, (byLabel = new Map()));
  let counter = byLabel.get(label);
  if (!counter) byLabel.set(label, (counter = { seq: 0 }));
  return counter;
};

const isNum = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x);

/**
 * Ephemeral per-peer values (pointers, viewports) over peer links: last value per sender, no
 * ordering, no retransmits, no catch-up and no persistence. A new link sees nothing until the
 * sender's next `set`.
 *
 * Order comes from causality the receiver observes, never from clocks or from numbers chosen
 * by different senders. A value is held only for an origin in the roster, and it is removed
 * as soon as the origin leaves. Within one link the highest `seq` wins and anything at or
 * below it is dropped: one counter stamps every frame sent on that link in send order, so a
 * lower `seq` was sent earlier. A link that opens or closes starts its origin fresh, and a
 * frame of an old link cannot arrive on a new one. An origin that leaves and comes back
 * starts fresh. Every roster transition is consumed synchronously, even if no frame arrives
 * and nobody reads `peers` between leave and rejoin.
 *
 * The counter belongs to the links and the channel, not to this sender, so a sender closed
 * and recreated on the same links carries on where the last one stopped and is heard at
 * once. A new tab or device is a new link, which every receiver already treats as fresh.
 *
 * Values travel as JSON.
 */
export function rtcPresence<T>(
  links: PeerLinks,
  opt: RtcPresenceOptions,
): RtcPresenceRef<T> {
  const injector = opt.injector ?? inject(Injector);
  const label = opt.channel ?? presenceChannel.label;
  if (!links.channels.includes(label)) {
    throw new Error(
      `[@mmstack/mesh] rtcPresence needs a '${label}' channel on its peer links`,
    );
  }

  const held = new Map<string, { seq: number; value: T }>();
  const version = signal(0);
  const counter = counterOf(links, label);
  let closed = false;
  let roster: ReadonlySet<string> = new Set();

  const forget = (origin: string): void => {
    if (held.delete(origin)) version.update((v) => v + 1);
  };

  const receive = (origin: string, frame: string): void => {
    if (closed) return;
    let msg: PresenceFrame<T>;
    try {
      msg = JSON.parse(frame) as PresenceFrame<T>;
    } catch {
      return;
    }
    if (
      typeof msg !== 'object' ||
      msg === null ||
      !isNum(msg.seq) ||
      !('value' in msg)
    ) {
      return;
    }
    if (!roster.has(origin)) return;
    const prev = held.get(origin);
    if (prev && msg.seq <= prev.seq) return;
    held.set(origin, { seq: msg.seq, value: msg.value });
    version.update((v) => v + 1);
  };

  const unsubs = [
    opt.roster((members) => {
      roster = new Set(members);
      for (const origin of held.keys()) if (!roster.has(origin)) forget(origin);
    }),
    links.onMessage((origin, frame, channel) => {
      if (channel === label) receive(origin, frame);
    }),
    // the link is the epoch: a new or lost link starts the origin fresh
    links.onOpen((origin, channel) => {
      if (channel === label) forget(origin);
    }),
    links.onClose(forget),
    links.onEnd(() => close()),
  ];

  const peers = computed<ReadonlyMap<string, T>>(() => {
    version();
    if (closed) return new Map();
    const out = new Map<string, T>();
    for (const [origin, entry] of held) {
      if (roster.has(origin)) out.set(origin, entry.value);
    }
    return out;
  });

  const destroyRef = injector.get(DestroyRef);
  const outgoing = throttled<T | typeof none>(none, {
    ms: opt.throttleMs ?? 33,
    leading: true,
    trailing: true,
    destroyRef,
  });
  const publisher = effect(
    () => {
      const value = outgoing();
      if (value === none || closed) return;
      untracked(() =>
        links.broadcast(
          JSON.stringify({
            seq: counter.seq++,
            value,
          } satisfies PresenceFrame<T>),
          label,
        ),
      );
    },
    { injector },
  );

  const close = (): void => {
    if (closed) return;
    closed = true;
    publisher.destroy();
    for (const unsub of unsubs.splice(0)) unsub();
    held.clear();
    version.update((v) => v + 1);
  };

  destroyRef.onDestroy(close);

  return {
    set: (value) => {
      if (!closed) outgoing.set(value);
    },
    peers,
    close,
  };
}
