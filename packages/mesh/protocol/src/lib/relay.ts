import {
  checkEnvelope,
  type OpPolicy,
  type PolicyViolation,
  type PrincipalCtx,
} from './policy';
import {
  applyWireOps,
  MESH_PROTO_VERSION,
  type ClientMsg,
  type PresenceState,
  type SeqEnvelope,
  type ServerMsg,
} from './wire';

/** What the relay needs from a connection — implement over ws, a DO WebSocket, or a test pair. */
export type RelaySocket = {
  send(msg: ServerMsg): void;
  close?(): void;
};

export type RelayLimits = {
  /** Ops per envelope; a larger envelope is a violation (default 1024). */
  readonly maxOpsPerEnvelope?: number;
  /** Sustained envelopes/second per writer (token bucket, burst = 2×; off by default). */
  readonly maxEnvelopesPerSecond?: number;
};

export type RelayOptions = {
  /** Validation/ACL applied to every envelope; violations eject the writer (tripwire). */
  readonly policy?: OpPolicy;
  readonly policyVersion?: number;
  readonly limits?: RelayLimits;
  /** Seq-envelopes retained per room for delta answers; older fold into the snapshot (default 1000). */
  readonly journalLimit?: number;
  readonly now?: () => number;
  readonly onViolation?: (room: string, violation: PolicyViolation) => void;
  /**
   * The persistence egress: fired after an envelope is sequenced, folded into the room
   * snapshot, and broadcast. The envelope is the persistence record (append it to a journal);
   * `state` carries the folded root for throttled checkpoints. Called synchronously and never
   * awaited: batch, debounce, and store at the adapter layer. Pair with {@link Relay.hydrate}.
   */
  readonly onCommit?: (room: string, env: SeqEnvelope, state: RoomState) => void;
};

/** The room's durable state at a commit: what a checkpoint needs to capture. */
export type RoomState = {
  readonly seq: number;
  readonly epoch: string;
  readonly root: unknown;
};

/** A persisted room to restore via {@link Relay.hydrate}. */
export type RoomSnapshot = {
  readonly seq: number;
  readonly root: unknown;
  /**
   * Restore the persisted epoch so clients reconnecting across the restart keep their seq
   * watermark and get a `delta` answer; omit to mint a fresh one (they re-snapshot instead).
   */
  readonly epoch?: string;
  /** Journal tail (ascending seq, entries at or below `seq`) enabling those delta answers. */
  readonly journal?: readonly SeqEnvelope[];
};

export type RelayConnection = {
  receive(msg: ClientMsg): void;
  disconnect(): void;
};

export type RoomInfo = {
  readonly seq: number;
  readonly members: number;
  readonly journal: number;
};

export type Relay = {
  /** Attach an authenticated connection. `ctx.writer` is the trusted principal. */
  connect(socket: RelaySocket, ctx: PrincipalCtx): RelayConnection;
  room(name: string): RoomInfo | undefined;
  /**
   * Restore a persisted room before clients join (relay boot, Durable Object wake). Refused
   * (`false`) once the room has state or members: hydrating a live seq space would corrupt
   * it. Load asynchronously at the adapter layer, then hydrate synchronously.
   */
  hydrate(name: string, snapshot: RoomSnapshot): boolean;
};

type Member = {
  readonly socket: RelaySocket;
  readonly ctx: PrincipalCtx;
  origin: string;
};

type Bucket = { tokens: number; last: number };

type Room = {
  seq: number;
  epoch: string;
  root: unknown;
  journal: SeqEnvelope[];
  members: Set<Member>;
  presence: Map<string, { peer: PresenceState; by: Member }>;
  ejected: Set<string>;
  buckets: Map<string, Bucket>;
};

let epochCounter = 0;

/**
 * The reference relay core (op-protocol RFC §6/§7): room-scoped sequencing, journal +
 * snapshot compaction, the tri-state join answer, presence fan-out, and tripwire policy
 * enforcement. Pure over injected sockets — runs identically under ws, Bun, a Durable
 * Object, or an in-memory test pair. The relay never interprets ops beyond folding them
 * for snapshots, and never mints identity: `writer` comes from the adapter's auth.
 *
 * Room-initialization contract: a fresh room (seq 0) answers `up-to-date`; the first client
 * then SEEDS it with a root-set envelope so the room's snapshot root is complete (deletes
 * fold correctly, joiners replace-hydrate). Near-simultaneous first-joins of a brand-new
 * room may last-writer-wins their seeds; rooms created by a single client first (the
 * overwhelmingly common case) are unaffected.
 */
export function createRelay(opt: RelayOptions = {}): Relay {
  const rooms = new Map<string, Room>();
  const policyVersion = opt.policyVersion ?? 0;
  const journalLimit = opt.journalLimit ?? 1000;
  const maxOps = opt.limits?.maxOpsPerEnvelope ?? 1024;
  const rate = opt.limits?.maxEnvelopesPerSecond;
  const now = opt.now ?? Date.now;

  const roomOf = (name: string): Room => {
    let room = rooms.get(name);
    if (!room) {
      room = {
        seq: 0,
        epoch: `${now().toString(36)}-${(++epochCounter).toString(36)}`,
        root: undefined,
        journal: [],
        members: new Set(),
        presence: new Map(),
        ejected: new Set(),
        buckets: new Map(),
      };
      rooms.set(name, room);
    }
    return room;
  };

  const broadcast = (room: Room, msg: ServerMsg, except?: Member): void => {
    for (const member of room.members) {
      if (member !== except) member.socket.send(msg);
    }
  };

  const eject = (name: string, room: Room, writer: string, violation: PolicyViolation): void => {
    room.ejected.add(writer);
    opt.onViolation?.(name, violation);
    broadcast(room, { t: 'eject', room: name, writer, reason: violation.reason });
    for (const member of [...room.members]) {
      if (member.ctx.writer !== writer) continue;
      room.members.delete(member);
      dropPresence(name, room, member);
      broadcast(room, { t: 'member', room: name, origin: member.origin, gone: true });
      member.socket.close?.();
    }
  };

  const dropPresence = (name: string, room: Room, member: Member): void => {
    const entry = room.presence.get(member.origin);
    if (!entry || entry.by !== member) return;
    room.presence.delete(member.origin);
    broadcast(room, { t: 'presence', room: name, peer: entry.peer, gone: true });
  };

  const overRate = (room: Room, writer: string): boolean => {
    if (!rate) return false;
    const at = now();
    let bucket = room.buckets.get(writer);
    if (!bucket) {
      bucket = { tokens: rate * 2, last: at };
      room.buckets.set(writer, bucket);
    }
    bucket.tokens = Math.min(rate * 2, bucket.tokens + ((at - bucket.last) / 1000) * rate);
    bucket.last = at;
    if (bucket.tokens < 1) return true;
    bucket.tokens -= 1;
    return false;
  };

  return {
    room: (name) => {
      const room = rooms.get(name);
      return room
        ? { seq: room.seq, members: room.members.size, journal: room.journal.length }
        : undefined;
    },
    hydrate: (name, snapshot) => {
      const room = roomOf(name);
      if (room.seq !== 0 || room.members.size > 0 || room.journal.length > 0) return false;
      room.seq = snapshot.seq;
      room.root = snapshot.root;
      if (snapshot.epoch !== undefined) room.epoch = snapshot.epoch;
      if (snapshot.journal) {
        room.journal = snapshot.journal
          .filter((e) => e.seq <= snapshot.seq)
          .sort((a, b) => a.seq - b.seq)
          .slice(-journalLimit);
      }
      return true;
    },
    connect: (socket, ctx) => {
      const joined = new Map<string, Member>();

      const disconnect = (): void => {
        for (const [name, member] of joined) {
          const room = rooms.get(name);
          if (!room || !room.members.has(member)) continue;
          room.members.delete(member);
          dropPresence(name, room, member);
          broadcast(room, { t: 'member', room: name, origin: member.origin, gone: true });
        }
        joined.clear();
      };

      return {
        disconnect,
        receive: (msg) => {
          const room = roomOf(msg.room);

          if (msg.t === 'hello') {
            if (room.ejected.has(ctx.writer)) {
              socket.send({ t: 'reject', room: msg.room, reason: 'unauthorized' });
              return;
            }
            if (msg.proto !== MESH_PROTO_VERSION) {
              socket.send({
                t: 'reject',
                room: msg.room,
                reason: 'proto',
                expected: MESH_PROTO_VERSION,
              });
              return;
            }
            if (msg.policyVersion !== policyVersion) {
              socket.send({
                t: 'reject',
                room: msg.room,
                reason: 'policy-version',
                expected: policyVersion,
              });
              return;
            }

            for (const prior of [...room.members]) {
              if (prior.origin !== msg.origin) continue;
              room.members.delete(prior);
              dropPresence(msg.room, room, prior);
              if (prior.socket !== socket) prior.socket.close?.();
            }

            const member: Member = { socket, ctx, origin: msg.origin };
            joined.set(msg.room, member);
            room.members.add(member);
            broadcast(room, { t: 'member', room: msg.room, origin: msg.origin }, member);

            const peers = [...room.presence.values()].map((e) => e.peer);
            const base = {
              t: 'welcome',
              room: msg.room,
              seq: room.seq,
              epoch: room.epoch,
              peers,
              members: [...room.members]
                .filter((m) => m !== member)
                .map((m) => m.origin),
            } as const;
            if (room.seq === 0 || msg.seq === room.seq) {
              socket.send({ ...base, mode: 'up-to-date' });
            } else if (
              msg.seq !== undefined &&
              room.journal.length > 0 &&
              msg.seq >= room.journal[0].seq - 1
            ) {
              const since = msg.seq;
              socket.send({
                ...base,
                mode: 'delta',
                envs: room.journal.filter((e) => e.seq > since),
              });
            } else {
              socket.send({ ...base, mode: 'snapshot', root: room.root });
            }
            return;
          }

          const member = joined.get(msg.room);
          if (!member || room.ejected.has(ctx.writer)) return;

          if (msg.t === 'signal') {
            for (const target of room.members) {
              if (target.origin === msg.to) {
                target.socket.send({
                  t: 'signal',
                  room: msg.room,
                  from: member.origin,
                  data: msg.data,
                });
                break;
              }
            }
            return;
          }

          if (msg.t === 'presence') {
            const peer: PresenceState = {
              origin: member.origin,
              writer: ctx.writer,
              data: msg.data,
            };
            room.presence.set(member.origin, { peer, by: member });
            broadcast(room, { t: 'presence', room: msg.room, peer }, member);
            return;
          }

          const env = msg.env;
          const violation: PolicyViolation | null =
            env.policyVersion !== policyVersion || env.proto !== MESH_PROTO_VERSION
              ? { writer: ctx.writer, reason: 'proto' }
              : env.ops.length > maxOps
                ? { writer: ctx.writer, reason: 'ops-limit' }
                : overRate(room, ctx.writer)
                  ? { writer: ctx.writer, reason: 'rate' }
                  : checkEnvelope(opt.policy, env, ctx);
          if (violation) {
            eject(msg.room, room, ctx.writer, violation);
            return;
          }

          const seqEnv: SeqEnvelope = { ...env, seq: ++room.seq };
          room.journal.push(seqEnv);
          room.root = applyWireOps(room.root, env.ops);
          if (room.journal.length > journalLimit) room.journal.shift();
          broadcast(room, { t: 'env', room: msg.room, env: seqEnv });
          opt.onCommit?.(msg.room, seqEnv, {
            seq: room.seq,
            epoch: room.epoch,
            root: room.root,
          });
        },
      };
    },
  };
}
