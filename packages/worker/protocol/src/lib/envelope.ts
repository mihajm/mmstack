import type { OpEnvelope, OpSyncCheckpoint } from '@mmstack/primitives';
import type { SerializedError } from './error';

/** Wire-protocol version, negotiated in the hello/ready handshake. Bump on breaking envelope change. */
export const PROTO_VERSION = 1;
export type ProtoVersion = typeof PROTO_VERSION;

/** The status a remote (worker-owned) computation reports across the boundary — the rung-3 seam. */
export type RemoteStatus =
  | 'idle'
  | 'loading'
  | 'reloading'
  | 'resolved'
  | 'error';

/**
 * Every message exchanged over a {@link WorkerPortLike}. One discriminated union shared by the
 * main-thread client and the worker host (and, later, `@mmstack/mesh`), so the two sides can never
 * drift.
 */
export type WorkerEnvelope =
  | { type: 'hello'; proto: ProtoVersion; clientId: string }
  | {
      type: 'ready';
      proto: ProtoVersion;
      hostId: string;
      stores: readonly string[];
      published: readonly string[];
      tasks: readonly string[];
    }
  | { type: 'fatal'; error: SerializedError }
  | { type: 'task:run'; runId: number; task: string; input: unknown }
  | { type: 'task:abort'; runId: number }
  | { type: 'task:ok'; runId: number; value: unknown }
  | { type: 'task:error'; runId: number; error: SerializedError }
  | { type: 'task:aborted'; runId: number }
  | { type: 'store:subscribe'; store: string; clientId: string }
  // The owner ships its opSync checkpoint (root + register state + watermark) on subscribe/resync,
  // so a joining replica hydrates through its own fold rather than adopting a bare value.
  | { type: 'store:checkpoint'; store: string; checkpoint: OpSyncCheckpoint }
  // A single op envelope, both directions: owner-emitted ops flow host -> clients, and a client's
  // routed write flows client -> host. The host relays each applied envelope to every subscriber
  // (including the sender, whose replica reads its own echo as the acknowledgement).
  | { type: 'store:sync'; store: string; env: OpEnvelope }
  | { type: 'store:unsubscribe'; store: string; clientId: string }
  | { type: 'store:status'; store: string; status: RemoteStatus; error?: SerializedError };

/** Narrows a raw message to a specific envelope variant by its `type`. */
export type EnvelopeOf<K extends WorkerEnvelope['type']> = Extract<
  WorkerEnvelope,
  { type: K }
>;
