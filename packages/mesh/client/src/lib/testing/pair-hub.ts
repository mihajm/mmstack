import type { DataChannelLike, PeerConnector } from '../peer-links';

/**
 * An in-memory channel hub for peer links, derived from the `fakeHub()` in
 * `webrtc-mesh.spec.ts`: it pairs the two ends of a link by (local, remote) origin rather than
 * by call order, so rooms with more than two peers link correctly, and it gives every link one
 * half per requested channel label.
 *
 * For recovery tests it also counts builds and live connectors per (local, remote) pair, can
 * `fail` a link (the connector reports it gone on the chosen side, whose halves go dead
 * without the other side hearing anything) and can `refuse` the next builds of a pair (their
 * halves never pair, so they never open).
 */
export function pairHub() {
  type Half = {
    channel: DataChannelLike;
    deliver(frame: string): void;
    fireOpen(): void;
    fireClose(): void;
    link(other: Half): void;
    /** Goes dead in place: no frame in or out, no callback on either side. */
    sever(): void;
  };
  type Built = {
    readonly halves: Record<string, Half>;
    readonly goneCbs: Set<() => void>;
  };
  const parked = new Map<string, Record<string, Half>>();
  const live = new Map<string, Set<Built>>();
  const builds = new Map<string, number>();
  const refusals = new Map<string, number>();

  const makeHalf = (): Half => {
    const messageCbs = new Set<(f: string) => void>();
    const openCbs = new Set<() => void>();
    const closeCbs = new Set<() => void>();
    const buffered: string[] = [];
    const inbound: string[] = [];
    let remote: Half | null = null;
    let open = false;
    let dead = false;
    const half: Half = {
      channel: {
        send: (frame) => {
          if (dead) return;
          if (open && remote) remote.deliver(frame);
          else buffered.push(frame);
        },
        onMessage: (cb) => {
          for (const frame of inbound.splice(0)) cb(frame);
          messageCbs.add(cb);
          return () => messageCbs.delete(cb);
        },
        onOpen: (cb) => {
          if (open) cb();
          openCbs.add(cb);
          return () => openCbs.delete(cb);
        },
        onClose: (cb) => (closeCbs.add(cb), () => closeCbs.delete(cb)),
        close: () => {
          if (!open) return;
          open = false;
          remote?.fireClose();
          half.fireClose();
        },
      },
      deliver: (frame) => {
        if (dead) return;
        if (messageCbs.size === 0) inbound.push(frame);
        else for (const cb of [...messageCbs]) cb(frame);
      },
      fireOpen: () => {
        open = true;
        const frames = buffered.splice(0);
        for (const cb of [...openCbs]) cb();
        for (const frame of frames) remote?.deliver(frame);
      },
      fireClose: () => {
        if (dead) return;
        open = false;
        for (const cb of [...closeCbs]) cb();
      },
      link: (other) => {
        remote = other;
      },
      sever: () => {
        dead = true;
        open = false;
        remote = null;
      },
    };
    return half;
  };

  const connectorFor =
    (local: string): PeerConnector =>
    ({ remote, channels }) => {
      const key = `${local}|${remote}`;
      builds.set(key, (builds.get(key) ?? 0) + 1);
      const refused = refusals.get(key) ?? 0;
      if (refused > 0) refusals.set(key, refused - 1);
      const mine: Record<string, Half> = {};
      for (const c of channels) mine[c.label] = makeHalf();
      const theirs = refused > 0 ? undefined : parked.get(`${remote}|${local}`);
      if (theirs) {
        parked.delete(`${remote}|${local}`);
        for (const c of channels) {
          mine[c.label].link(theirs[c.label]);
          theirs[c.label].link(mine[c.label]);
        }
        for (const c of channels) mine[c.label].fireOpen();
        for (const c of channels) theirs[c.label].fireOpen();
      } else if (refused === 0) {
        parked.set(key, mine);
      }
      const built: Built = { halves: mine, goneCbs: new Set() };
      if (!live.has(key)) live.set(key, new Set());
      live.get(key)?.add(built);
      const byLabel: Record<string, DataChannelLike> = {};
      for (const c of channels) byLabel[c.label] = mine[c.label].channel;
      return {
        channel: byLabel[channels[0].label],
        channels: byLabel,
        signal: () => undefined,
        onClose: (cb) => (
          built.goneCbs.add(cb),
          () => built.goneCbs.delete(cb)
        ),
        close: () => {
          if (parked.get(key) === mine) parked.delete(key);
          live.get(key)?.delete(built);
          for (const half of Object.values(mine)) half.channel.close();
        },
      };
    };

  const failOne = (key: string): void => {
    for (const built of [...(live.get(key) ?? [])]) {
      if (parked.get(key) === built.halves) parked.delete(key);
      for (const half of Object.values(built.halves)) half.sever();
      for (const cb of [...built.goneCbs]) cb();
    }
  };

  return {
    connectorFor,
    /** The connector on the chosen side(s) reports the link gone; its halves go dead silently. */
    fail: (
      local: string,
      remote: string,
      side: 'local' | 'remote' | 'both',
    ) => {
      if (side !== 'remote') failOne(`${local}|${remote}`);
      if (side !== 'local') failOne(`${remote}|${local}`);
    },
    /** The next `attempts` builds on each side of the pair never open. */
    refuse: (local: string, remote: string, attempts: number) => {
      refusals.set(`${local}|${remote}`, attempts);
      refusals.set(`${remote}|${local}`, attempts);
    },
    /** Connectors `local` built toward `remote` so far. */
    builds: (local: string, remote: string) =>
      builds.get(`${local}|${remote}`) ?? 0,
    /** Connectors `local` holds toward `remote` that are not closed. */
    live: (local: string, remote: string) =>
      live.get(`${local}|${remote}`)?.size ?? 0,
  };
}
