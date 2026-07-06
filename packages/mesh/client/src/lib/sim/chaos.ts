import type { ClientMsg, ServerMsg } from '@mmstack/mesh-protocol';
import type { MeshTransport, MeshTransportFactory } from '../transport';
import type { Prng } from './prng';

/** Network fault profile for a link. Latency variance across messages is what produces reorder. */
export type Faults = {
  readonly minLatencyMs?: number;
  readonly maxLatencyMs?: number;
  /** Per-message drop probability while connected (distinct from a partition). */
  readonly dropRate?: number;
};

export type ChaosLink = {
  /** Pass as `meshSync`'s `transport`; re-wraps the inner transport on every (re)connect. */
  readonly transport: MeshTransportFactory;
  /** Cut the link: drop traffic both ways and close any live socket (→ meshSync reconnect loop). */
  partition(): void;
  /** Restore: the next reconnect attempt establishes. */
  heal(): void;
  readonly isCut: () => boolean;
  /** Go silent: drop traffic both ways but KEEP the socket open (no close → no reconnect). The
   *  zombie fault — meshSync still thinks it is live, its writes pile up unacked, it misses inbound. */
  silence(): void;
  unsilence(): void;
  readonly isSilenced: () => boolean;
};

/**
 * Wraps a `MeshTransportFactory` with deterministic network faults: per-message latency (which,
 * with variance, reorders), independent drops, and partition (cut both directions + close the
 * socket so `meshSync` enters its reconnect loop, healing on {@link ChaosLink.heal}). Delivery is
 * scheduled on `setTimeout`, so a run drives it via fake timers. All randomness comes from `r`,
 * so a link is a pure function of its seed.
 */
export function chaosLink(
  inner: MeshTransportFactory,
  r: Prng,
  faults: Faults = {},
): ChaosLink {
  const minL = Math.max(0, faults.minLatencyMs ?? 0);
  const maxL = Math.max(minL, faults.maxLatencyMs ?? minL);
  const dropRate = faults.dropRate ?? 0;
  let cut = false;
  let silenced = false;
  const live = new Set<() => void>();

  const latency = (): number => (maxL === minL ? minL : minL + r.int(maxL - minL + 1));
  const drop = (): boolean => dropRate > 0 && r.float() < dropRate;

  const transport: MeshTransportFactory = () => {
    const t: MeshTransport = inner();
    const messageCbs = new Set<(m: ServerMsg) => void>();
    const closeCbs = new Set<() => void>();
    let open = true;

    const shut = (): void => {
      if (!open) return;
      open = false;
      live.delete(shut);
      t.close();
      for (const cb of [...closeCbs]) cb();
    };
    live.add(shut);

    t.onMessage((m) => {
      if (!open || cut || silenced || drop()) return;
      const at = latency();
      setTimeout(() => {
        if (open && !cut && !silenced) for (const cb of [...messageCbs]) cb(m);
      }, at);
    });
    t.onClose(() => shut());

    if (cut) setTimeout(shut, 0); // a connect during a partition can't establish

    return {
      send: (m: ClientMsg) => {
        if (!open || cut || silenced || drop()) return;
        const at = latency();
        setTimeout(() => {
          if (open && !cut && !silenced) t.send(m);
        }, at);
      },
      onMessage: (cb) => {
        messageCbs.add(cb);
        return () => messageCbs.delete(cb);
      },
      onClose: (cb) => {
        closeCbs.add(cb);
        return () => closeCbs.delete(cb);
      },
      close: shut,
    };
  };

  return {
    transport,
    partition: () => {
      cut = true;
      for (const s of [...live]) s();
    },
    heal: () => {
      cut = false;
    },
    isCut: () => cut,
    silence: () => {
      silenced = true;
    },
    unsilence: () => {
      silenced = false;
    },
    isSilenced: () => silenced,
  };
}
