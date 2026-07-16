import {
  checkEnvelope,
  type OpPolicy,
  type PolicyViolation,
  type PrincipalCtx,
} from './policy';
import { createRegisterStore, type RegisterStore } from './register';
import { validateEnvelope } from './validate';
import {
  MESH_PROTO_VERSION,
  type ClientMsg,
  type Hlc,
  type OpEnvelope,
  type PresenceState,
  type RegisterCheckpoint,
  type RejectMsg,
  type SeqEnvelope,
  type ServerMsg,
} from './wire';

/** What the relay needs from a connection — implement over ws, a DO WebSocket, or a test pair. */
export type RelaySocket = {
  send(msg: ServerMsg): void;
  close?(): void;
};

export type RelayLimits = {
  /**
   * Ops per envelope; a larger envelope is a violation (default 1024). A subtree replace
   * legitimately emits one `set` plus one `clear` per observed live descendant register in a
   * single envelope, so a tightened limit must still accommodate honest clear-groups.
   */
  readonly maxOpsPerEnvelope?: number;
  /** Sustained envelopes/second per writer (token bucket, burst = 2×; off by default). */
  readonly maxEnvelopesPerSecond?: number;
};

export type RelayOptions = {
  /** Validation/ACL applied to every envelope; violations eject the writer (tripwire). */
  readonly policy?: OpPolicy;
  readonly policyVersion?: number;
  readonly limits?: RelayLimits;
  /** Seq-envelopes retained per room for delta answers; older compact into register state (default 1000). */
  readonly journalLimit?: number;
  readonly now?: () => number;
  readonly onViolation?: (room: string, violation: PolicyViolation) => void;
  /**
   * The persistence egress: fired after an envelope is sequenced, retained into the room's
   * register state, and broadcast. The envelope is the persistence record (append it to a
   * journal); `state` carries the retained register state for throttled checkpoints. Called
   * synchronously and never awaited: batch, debounce, and store at the adapter layer. Pair
   * with {@link Relay.hydrate}.
   */
  readonly onCommit?: (
    room: string,
    env: SeqEnvelope,
    state: RoomState,
  ) => void;
  /**
   * Observation of a silently dropped envelope: received but neither sequenced nor a
   * violation (today: a stale-schema straggler arriving after a migration — its sender is
   * outdated, not malicious, so it is not ejected and nothing is broadcast). Without this
   * hook the drop is invisible to an audit adapter. Pure observation, zero semantic effect;
   * synchronous and never awaited, like {@link RelayOptions.onCommit}.
   */
  readonly onDrop?: (room: string, env: OpEnvelope, reason: 'schema') => void;
  /**
   * Observation of a rejected hello: an ejected writer knocking again (`'unauthorized'`), or
   * a client whose proto / policy-version / schema pin is behind the room's. The client
   * already receives the `reject` message; this is the server-side trace for an audit
   * adapter, with `expected` carrying the room's version where one applies. Pure
   * observation; synchronous and never awaited.
   */
  readonly onReject?: (
    room: string,
    ctx: PrincipalCtx,
    reason: RejectMsg['reason'],
    expected?: number,
  ) => void;
  /**
   * Observation of an admitted hello: the server-side record that `origin` (the replica) now
   * speaks for `ctx` (the authenticated principal) in this room — the origin-to-principal
   * binding an audit adapter joins ops against. Fires on EVERY accepted hello, including a
   * reconnect re-asserting an existing binding (dedupe at the adapter). Pure observation;
   * synchronous and never awaited.
   */
  readonly onJoin?: (room: string, ctx: PrincipalCtx, origin: string) => void;
};

/** The room's durable state at a commit: what a checkpoint needs to capture. */
export type RoomState = {
  readonly seq: number;
  readonly instance: string;
  /** The room's retained per-path register state, never a folded value. */
  readonly registers: readonly RegisterCheckpoint[];
  /** Per-origin envelope-version high-water marks. */
  readonly wm: Readonly<Record<string, number>>;
  /** The room's data shape; restored via {@link Relay.hydrate}. */
  readonly schemaVersion: number;
};

/** A persisted room to restore via {@link Relay.hydrate}. */
export type RoomSnapshot = {
  readonly seq: number;
  /** The retained register state captured at the checkpoint. */
  readonly registers?: readonly RegisterCheckpoint[];
  /** Per-origin envelope-version high-water marks captured at the checkpoint. */
  readonly wm?: Readonly<Record<string, number>>;
  /**
   * Restore the persisted instance nonce so clients reconnecting across the restart keep
   * their seq watermark and get a `delta` answer; omit to mint a fresh one (they re-snapshot
   * instead).
   */
  readonly instance?: string;
  /** Restore the persisted schema version (a compacted snapshot is post-migration). */
  readonly schemaVersion?: number;
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
  instance: string;
  schemaVersion: number;
  registers: RegisterStore;
  wm: Map<string, number>;
  /** The stamp compaction has folded past: what the journal no longer covers. */
  frontier: Hlc | undefined;
  journal: SeqEnvelope[];
  members: Set<Member>;
  presence: Map<string, { peer: PresenceState; by: Member }>;
  ejected: Set<string>;
  buckets: Map<string, Bucket>;
};

let instanceCounter = 0;

/**
 * The reference relay core: room-scoped sequencing, journal + register-state compaction, the
 * tri-state join answer, presence fan-out, and tripwire policy enforcement. Pure over
 * injected sockets — runs identically under ws, Bun, a Durable Object, or an in-memory test
 * pair. The relay RETAINS ops (per-path registers, the same pure ingest rules every client
 * runs) but never resolves them: conflict resolution is client-configured policy, so a relay
 * that folded values would seed late joiners into permanent divergence from established
 * peers. Snapshots therefore ship register state, never a value tree. It also never mints
 * identity: `writer` comes from the adapter's auth.
 *
 * Room-initialization contract: a fresh room (seq 0) answers `up-to-date`; the first client
 * then SEEDS it with a root-set envelope so the room's register state is complete (joiners
 * hydrate from it). Near-simultaneous first-joins of a brand-new room may race their seeds
 * (the register retains both as concurrent siblings); rooms created by a single client first
 * (the overwhelmingly common case) are unaffected.
 */
export function createRelay(opt: RelayOptions = {}): Relay {
  const rooms = new Map<string, Room>();
  const policyVersion = opt.policyVersion ?? 0;
  const journalLimit = opt.journalLimit ?? 1000;
  const maxOps = opt.limits?.maxOpsPerEnvelope ?? 1024;
  const rate = opt.limits?.maxEnvelopesPerSecond;
  const now = opt.now ?? Date.now;

  const mintInstance = (): string =>
    `${now().toString(36)}-${(++instanceCounter).toString(36)}`;

  const roomOf = (name: string): Room => {
    let room = rooms.get(name);
    if (!room) {
      room = {
        seq: 0,
        instance: mintInstance(),
        schemaVersion: 0,
        registers: createRegisterStore(),
        wm: new Map(),
        frontier: undefined,
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

  const maybeEvictEmpty = (name: string): void => {
    const room = rooms.get(name);
    if (
      room &&
      room.members.size === 0 &&
      room.seq === 0 &&
      room.ejected.size === 0
    ) {
      rooms.delete(name);
    }
  };

  const broadcast = (room: Room, msg: ServerMsg, except?: Member): void => {
    for (const member of room.members) {
      if (member !== except) member.socket.send(msg);
    }
  };

  const eject = (
    name: string,
    room: Room,
    writer: string,
    violation: PolicyViolation,
  ): void => {
    room.ejected.add(writer);
    opt.onViolation?.(name, violation);
    broadcast(room, {
      t: 'eject',
      room: name,
      writer,
      reason: violation.reason,
    });
    for (const member of [...room.members]) {
      if (member.ctx.writer !== writer) continue;
      room.members.delete(member);
      dropPresence(name, room, member);
      broadcast(room, {
        t: 'member',
        room: name,
        origin: member.origin,
        gone: true,
      });
      member.socket.close?.();
    }
  };

  const dropPresence = (name: string, room: Room, member: Member): void => {
    const entry = room.presence.get(member.origin);
    if (!entry || entry.by !== member) return;
    room.presence.delete(member.origin);
    broadcast(room, {
      t: 'presence',
      room: name,
      peer: entry.peer,
      gone: true,
    });
  };

  const overRate = (room: Room, writer: string): boolean => {
    if (!rate) return false;
    const at = now();
    let bucket = room.buckets.get(writer);
    if (!bucket) {
      bucket = { tokens: rate * 2, last: at };
      room.buckets.set(writer, bucket);
    }
    bucket.tokens = Math.min(
      rate * 2,
      bucket.tokens + ((at - bucket.last) / 1000) * rate,
    );
    bucket.last = at;
    if (bucket.tokens < 1) return true;
    bucket.tokens -= 1;
    return false;
  };

  const laterHlc = (a: Hlc | undefined, b: Hlc): Hlc =>
    !a || b.p > a.p || (b.p === a.p && b.l > a.l) ? b : a;

  const hlcLte = (a: Hlc, b: Hlc): boolean =>
    a.p < b.p || (a.p === b.p && a.l <= b.l);

  const checkAdmission = (
    name: string,
    room: Room,
    env: OpEnvelope,
    ctx: PrincipalCtx,
  ): PolicyViolation | null => {
    const policy = opt.policy;
    if (!policy || (!policy.canBump && !policy.verifyCitations)) return null;
    for (const op of env.ops) {
      if (policy.canBump) {
        const observed = room.registers.maxEpoch(op.path);
        if (
          op.epoch > observed &&
          !policy.canBump(ctx, op.path, op.epoch, name)
        ) {
          return {
            writer: ctx.writer,
            reason: 'epoch-bump',
            path: op.path,
            detail: `epoch ${op.epoch} > observed ${observed}`,
          };
        }
      }
      if (!policy.verifyCitations) continue;
      for (const c of op.cites) {
        if (room.frontier && hlcLte(c.hlc, room.frontier)) continue;
        // a self-citation of this very envelope's dot is ignored at ingest (born-dead guard)
        if (
          c.origin === env.origin &&
          c.hlc.p === env.hlc.p &&
          c.hlc.l === env.hlc.l
        )
          continue;
        if (!room.registers.covers(op.path, c)) {
          return {
            writer: ctx.writer,
            reason: 'unknown-citation',
            path: op.path,
            detail: `cites ${c.origin}@${c.hlc.p}.${c.hlc.l}`,
          };
        }
      }
    }
    return null;
  };

  return {
    room: (name) => {
      const room = rooms.get(name);
      return room
        ? {
            seq: room.seq,
            members: room.members.size,
            journal: room.journal.length,
          }
        : undefined;
    },
    hydrate: (name, snapshot) => {
      const room = roomOf(name);
      if (room.seq !== 0 || room.members.size > 0 || room.journal.length > 0)
        return false;
      room.seq = snapshot.seq;
      room.registers.load(snapshot.registers ?? []);
      for (const [origin, v] of Object.entries(snapshot.wm ?? {})) {
        room.wm.set(origin, Math.max(room.wm.get(origin) ?? 0, v));
      }
      if (snapshot.instance !== undefined) room.instance = snapshot.instance;
      if (snapshot.schemaVersion !== undefined)
        room.schemaVersion = snapshot.schemaVersion;
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
          broadcast(room, {
            t: 'member',
            room: name,
            origin: member.origin,
            gone: true,
          });
          maybeEvictEmpty(name); // last member left a never-seeded room: reclaim it
        }
        joined.clear();
      };

      return {
        disconnect,
        receive: (msg) => {
          const room = roomOf(msg.room);

          if (msg.t === 'hello') {
            if (room.ejected.has(ctx.writer)) {
              socket.send({
                t: 'reject',
                room: msg.room,
                reason: 'unauthorized',
              });
              opt.onReject?.(msg.room, ctx, 'unauthorized');
              return;
            }
            if (msg.proto !== MESH_PROTO_VERSION) {
              socket.send({
                t: 'reject',
                room: msg.room,
                reason: 'proto',
                expected: MESH_PROTO_VERSION,
              });
              opt.onReject?.(msg.room, ctx, 'proto', MESH_PROTO_VERSION);
              maybeEvictEmpty(msg.room);
              return;
            }
            if (msg.policyVersion !== policyVersion) {
              socket.send({
                t: 'reject',
                room: msg.room,
                reason: 'policy-version',
                expected: policyVersion,
              });
              opt.onReject?.(msg.room, ctx, 'policy-version', policyVersion);
              maybeEvictEmpty(msg.room);
              return;
            }
            if (
              msg.schemaVersion !== undefined &&
              msg.schemaVersion < room.schemaVersion
            ) {
              socket.send({
                t: 'reject',
                room: msg.room,
                reason: 'schema',
                expected: room.schemaVersion,
              });
              opt.onReject?.(msg.room, ctx, 'schema', room.schemaVersion);
              maybeEvictEmpty(msg.room);
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
            opt.onJoin?.(msg.room, ctx, msg.origin);
            broadcast(
              room,
              { t: 'member', room: msg.room, origin: msg.origin },
              member,
            );

            const peers = [...room.presence.values()].map((e) => e.peer);
            const base = {
              t: 'welcome',
              room: msg.room,
              seq: room.seq,
              instance: room.instance,
              schemaVersion: room.schemaVersion,
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
              socket.send({
                ...base,
                mode: 'snapshot',
                registers: room.registers.checkpoint(),
                wm: Object.fromEntries(room.wm),
              });
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
          const malformed = validateEnvelope(env);
          const violation: PolicyViolation | null =
            env.policyVersion !== policyVersion ||
            env.proto !== MESH_PROTO_VERSION
              ? { writer: ctx.writer, reason: 'proto' }
              : malformed !== null
                ? { writer: ctx.writer, reason: 'malformed', detail: malformed }
                : env.ops.length > maxOps
                  ? { writer: ctx.writer, reason: 'ops-limit' }
                  : overRate(room, ctx.writer)
                    ? { writer: ctx.writer, reason: 'rate' }
                    : checkEnvelope(opt.policy, env, ctx, msg.room);
          if (violation) {
            eject(msg.room, room, ctx.writer, violation);
            return;
          }

          if (
            env.schemaVersion !== undefined &&
            env.schemaVersion < room.schemaVersion
          ) {
            opt.onDrop?.(msg.room, env, 'schema');
            return;
          }

          // after the stale-schema drop: a silently-dropped envelope never ingests, so its
          // epochs and cites gate nothing (an outdated client stays 'outdated', not ejected)
          const admission = checkAdmission(msg.room, room, env, ctx);
          if (admission) {
            eject(msg.room, room, ctx.writer, admission);
            return;
          }

          const seqEnv: SeqEnvelope = { ...env, seq: ++room.seq };
          room.journal.push(seqEnv);
          if (
            env.schemaVersion !== undefined &&
            env.schemaVersion > room.schemaVersion
          ) {
            room.schemaVersion = env.schemaVersion;
            room.instance = mintInstance();
            room.registers.reset();
            room.frontier = undefined;
            room.journal = [seqEnv];
          }
          room.registers.ingest(env);
          room.wm.set(
            env.origin,
            Math.max(room.wm.get(env.origin) ?? 0, env.version),
          );
          if (room.journal.length > journalLimit) {
            const trimmed = room.journal.shift();
            if (trimmed) {
              room.frontier = laterHlc(room.frontier, trimmed.hlc);
              room.registers.compact(room.frontier);
              // tell connected clients the frontier moved so they reclaim their own register state
              broadcast(room, {
                t: 'frontier',
                room: msg.room,
                frontier: room.frontier,
              });
            }
          }
          broadcast(room, { t: 'env', room: msg.room, env: seqEnv });
          opt.onCommit?.(msg.room, seqEnv, {
            seq: room.seq,
            instance: room.instance,
            registers: room.registers.checkpoint(),
            wm: Object.fromEntries(room.wm),
            schemaVersion: room.schemaVersion,
          });
        },
      };
    },
  };
}
