import {
  checkEnvelope,
  type OpPolicy,
  type PolicyRoomInfo,
  type PolicyViolation,
  type PrincipalCtx,
} from './policy';
import { createRanges, type Ranges } from './ranges';
import { createRegisterStore, type RegisterStore } from './register';
import { validateEnvelope } from './validate';
import {
  MESH_PROTO_VERSION,
  type ClientMsg,
  type DropMsg,
  type Hlc,
  type OpEnvelope,
  type PresenceState,
  type RegisterCheckpoint,
  type RejectMsg,
  type SeqEnvelope,
  type ServerMsg,
  type VersionRange,
  type WelcomeBody,
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
  /** Validation/ACL applied to every envelope; a violation ejects the offender (tripwire). */
  readonly policy?: OpPolicy;
  /**
   * How far a tripwire ejection reaches. `'writer'` (the default) blacklists the writer in that
   * room for the relay's lifetime: every connection it holds is closed and every later hello
   * is refused `'unauthorized'`. `'connection'` closes only the offending connection.
   * Neither scope prevents flooding: adapters must enforce ingress and connection limits,
   * with principal-level budgets that survive reconnects, even when every connection is authenticated.
   */
  readonly ejection?: 'writer' | 'connection';
  readonly policyVersion?: number;
  readonly limits?: RelayLimits;
  /** Seq-envelopes retained per room for delta answers (default 1000). Trimming the tail is also when the room garbage-collects settled register evidence. */
  readonly journalLimit?: number;
  readonly now?: () => number;
  readonly onViolation?: (room: string, violation: PolicyViolation) => void;
  /**
   * The persistence egress: fired synchronously once an envelope is sequenced and retained
   * into the room's register state, and BEFORE anything carrying it leaves the relay. The
   * envelope is the persistence record (append it to a journal); `state` carries the retained
   * register state for throttled checkpoints. Pair with {@link Relay.hydrate}.
   *
   * Return `void` to release the envelope at once — the memory-adapter behaviour, and the
   * relay's default. Return a promise and the relay holds every outbound message that carries
   * the envelope (its echo, the settled notice emitted with it, and any welcome answered
   * while it is in flight) until that promise resolves: a connection is told a write is safe
   * only once the adapter says it is, the way a database returns from `COMMIT` after its log
   * is written. Messages that are not document state — presence, signal, membership,
   * ejection — always pass immediately.
   *
   * A rejected promise STALLS the room: the envelope and everything queued behind it stay
   * unreleased and {@link RelayOptions.onDurabilityFailed} fires once. Nothing is un-ingested
   * and nothing is answered with state that will not survive a restart; recovery is a process
   * restart, after which the writers still holding those envelopes unacked resend them.
   */
  readonly onCommit?: (
    room: string,
    env: SeqEnvelope,
    state: RoomState,
  ) => void | Promise<void>;
  /**
   * The durability promise for `env` rejected: this room is now stalled and answers nothing
   * further. Fires once, for the envelope that failed. Report it and restart the process —
   * there is no in-place recovery, by design.
   */
  readonly onDurabilityFailed?: (
    room: string,
    env: SeqEnvelope,
    cause: unknown,
  ) => void;
  /**
   * Observation of an envelope the relay refused without ejecting anyone; the submitter is
   * told the same thing through a `drop` message. `'duplicate'` is a resend of a version the
   * room already holds (answered as the acknowledgement it is); `'generation'` an envelope
   * written in another room generation; `'schema'` a stale-schema straggler after a
   * migration; `'order'` a version below the origin's admitted maximum that was never
   * admitted. None of the senders is malicious. Pure observation, zero semantic effect;
   * synchronous and never awaited, like {@link RelayOptions.onCommit}.
   */
  readonly onDrop?: (
    room: string,
    env: OpEnvelope,
    reason: DropMsg['reason'],
  ) => void;
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
  /**
   * The room's retained per-path register state, never a folded value. A thunk because
   * walking every register on every commit is the dominant cost of a room under load and
   * most commits do not checkpoint: call it only when you are about to store one.
   *
   * It reads LIVE state, so it must be called synchronously inside the `onCommit` callback —
   * a call made later would describe a later seq than the envelope it is filed under.
   */
  checkpoint(): readonly RegisterCheckpoint[];
  /** Per-origin envelope-version high-water marks (the maximum of {@link RoomState.ranges}). */
  readonly wm: Readonly<Record<string, number>>;
  /**
   * Per-origin admitted-version ranges: the room's admission evidence. Persist them with the
   * checkpoint and hand them back through {@link RoomSnapshot.ranges}; a room that forgets them
   * re-sequences resends and cannot tell a refused version from a lost one.
   */
  readonly ranges: Readonly<Record<string, readonly VersionRange[]>>;
  /**
   * Per-origin stamp of the last contiguously admitted version: what register garbage
   * collection settles against. Persist with the checkpoint; hand back through
   * {@link RoomSnapshot.settled}.
   */
  readonly settled: Readonly<Record<string, Hlc>>;
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
  /** Admitted-version ranges captured with the checkpoint (see {@link RoomState.ranges}). Absent
   *  with `wm` present: every version up to the mark is taken as admitted. */
  readonly ranges?: Readonly<Record<string, readonly VersionRange[]>>;
  /** The settled vector captured with the checkpoint (see {@link RoomState.settled}). */
  readonly settled?: Readonly<Record<string, Hlc>>;
};

export type RelayConnection = {
  receive(msg: ClientMsg): void;
  disconnect(): void;
};

export type RoomInfo = {
  readonly seq: number;
  /** The room's current generation: what every envelope written into it must carry. */
  readonly instance: string;
  readonly members: number;
  readonly journal: number;
  /**
   * A durability promise for this room rejected, so its release queue has stopped: nothing queued
   * behind the failed head will ever be released, and every new answer queues behind it. The
   * adapter reads this to decide between refusing the room and dropping it (`unload` with
   * `discard`).
   */
  readonly stalled: boolean;
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
  /**
   * Drop a quiescent room from memory, so a relay holding thousands of them keeps only the ones
   * somebody is in. The ADAPTER promises everything the room holds is already on its substrate —
   * the relay cannot know what a journal has written — and promises to hydrate it from that
   * substrate before serving the name again: a fresh room under a persisted name seeds a new
   * sequence space into an old history, and the two then read as one.
   *
   * Refused (`false`) for a room with members, or with messages its release queue has not let go
   * of yet, so no client is dropped mid-answer; and for a name this relay is not holding.
   *
   * `discard` is the one exception, for a room whose release queue has STALLED on a rejected
   * durability promise: the adapter knows its substrate refused the write (a lost head, a row
   * that already existed) and that the substrate, not this memory, holds the truth. Nothing queued
   * behind the failed head was ever acknowledged, so dropping it loses nothing a client is not
   * already holding to resend. Still refused with members present, and for a queue that is merely
   * pending rather than stalled — a promise that may yet resolve is not the adapter's to throw
   * away.
   */
  unload(name: string, options?: { readonly discard?: boolean }): boolean;
};

/**
 * An ordered hold on the room's outbound document traffic. Each queued item releases only
 * after its own durability promise settles and after every item queued ahead of it, so what
 * a connection reads is always a prefix of what the adapter has confirmed. An item with no
 * promise releases as soon as it reaches the head — and, when nothing is owed, at once, which
 * is the whole behaviour of a relay whose adapter stores synchronously.
 */
type Release = {
  submit(run: () => void, done?: Promise<void>, env?: SeqEnvelope): void;
  /** Something is queued or in flight: a fresh answer must queue behind it. */
  busy(): boolean;
  /** A durability promise rejected; the queue will never drain on its own again. */
  stalled(): boolean;
  /** Drops everything queued without releasing it. Only meaningful once stalled. Answers how many. */
  discard(): number;
};

const createRelease = (
  onFail: (env: SeqEnvelope | undefined, cause: unknown) => void,
): Release => {
  type Item = {
    readonly run: () => void;
    readonly done?: Promise<void>;
    readonly env?: SeqEnvelope;
  };
  const queue: Item[] = [];
  let stalled = false;
  let draining = false;

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (!stalled && queue.length > 0) {
        const head = queue[0];
        if (head.done) {
          try {
            await head.done;
          } catch (cause) {
            stalled = true;
            onFail(head.env, cause);
            break;
          }
        }
        queue.shift();
        // an adapter that throws on send is its own bug; it must not stall every later release
        try {
          head.run();
        } catch {
          // deliberately swallowed: the item was released, its delivery is the adapter's
        }
      }
    } finally {
      draining = false;
    }
  };

  return {
    submit: (run, done, env) => {
      if (!stalled && !draining && queue.length === 0 && done === undefined) {
        run();
        return;
      }
      queue.push({ run, done, env });
      if (!stalled) void drain();
    },
    busy: () => draining || queue.length > 0,
    stalled: () => stalled,
    discard: () => {
      const dropped = queue.length;
      queue.length = 0;
      return dropped;
    },
  };
};

type Member = {
  readonly socket: RelaySocket;
  readonly ctx: PrincipalCtx;
  origin: string;
  /** Set by a `'connection'`-scoped ejection: this connection is done in this room. */
  ejected: boolean;
};

type Bucket = { tokens: number; last: number };

type Room = {
  seq: number;
  instance: string;
  schemaVersion: number;
  registers: RegisterStore;
  /** Admitted versions per origin: the admission evidence. */
  ranges: Map<string, Ranges>;
  /** Stamps of admitted versions above an origin's contiguous prefix, until the prefix reaches them. */
  above: Map<string, Map<number, Hlc>>;
  /** Per origin, the stamp of the last contiguously admitted version. */
  settled: Map<string, Hlc>;
  journal: SeqEnvelope[];
  members: Set<Member>;
  presence: Map<string, { peer: PresenceState; by: Member }>;
  ejected: Set<string>;
  buckets: Map<string, Bucket>;
  /** Holds outbound document traffic behind the adapter's durability confirmations. */
  release: Release;
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
  const ejection = opt.ejection ?? 'writer';

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
        ranges: new Map(),
        above: new Map(),
        settled: new Map(),
        journal: [],
        members: new Set(),
        presence: new Map(),
        ejected: new Set(),
        buckets: new Map(),
        release: createRelease((env, cause) => {
          if (env) opt.onDurabilityFailed?.(name, env, cause);
        }),
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

  const drop = (name: string, room: Room, member: Member): void => {
    room.members.delete(member);
    dropPresence(name, room, member);
    broadcast(room, {
      t: 'member',
      room: name,
      origin: member.origin,
      gone: true,
    });
    member.socket.close?.();
  };

  const eject = (
    name: string,
    room: Room,
    member: Member,
    violation: PolicyViolation,
  ): void => {
    const writer = member.ctx.writer;
    const notice = {
      t: 'eject',
      room: name,
      writer,
      reason: violation.reason,
    } as const;
    opt.onViolation?.(name, violation);
    if (ejection === 'writer') {
      room.ejected.add(writer);
      broadcast(room, notice);
      for (const held of [...room.members]) {
        if (held.ctx.writer === writer) drop(name, room, held);
      }
      return;
    }
    // Only the offender learns of the ejection: the same writer's other connections would read
    // a broadcast `eject` naming their writer as their own and go terminal with it.
    member.ejected = true;
    member.socket.send(notice);
    drop(name, room, member);
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

  const hlcLte = (a: Hlc, b: Hlc): boolean =>
    a.p < b.p || (a.p === b.p && a.l <= b.l);
  const rangesOf = (room: Room, origin: string): Ranges => {
    let r = room.ranges.get(origin);
    if (!r) room.ranges.set(origin, (r = createRanges()));
    return r;
  };
  const wmOf = (room: Room): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [origin, r] of room.ranges) out[origin] = r.max();
    return out;
  };
  const rangesRecord = (room: Room): Record<string, readonly VersionRange[]> => {
    const out: Record<string, readonly VersionRange[]> = {};
    for (const [origin, r] of room.ranges) out[origin] = r.toJSON();
    return out;
  };
  /** Record an admitted version and advance the origin's settled stamp when its prefix grows. */
  const admitVersion = (room: Room, env: OpEnvelope): void => {
    const ranges = rangesOf(room, env.origin);
    const before = ranges.prefix();
    ranges.add(env.version);
    const after = ranges.prefix();
    const above = room.above.get(env.origin);
    if (after > before) {
      // the prefix grew: its last version's stamp is this envelope's, or one recorded earlier
      // above the old prefix
      let stamp = env.hlc;
      if (above) {
        const recorded = above.get(after);
        if (recorded) stamp = recorded;
        for (const v of [...above.keys()]) if (v <= after) above.delete(v);
      }
      room.settled.set(env.origin, stamp);
      return;
    }
    // admitted above a hole: keep its stamp until the prefix reaches it
    if (above) above.set(env.version, env.hlc);
    else room.above.set(env.origin, new Map([[env.version, env.hlc]]));
  };
  const settledRecord = (room: Room): Record<string, Hlc> =>
    Object.fromEntries(room.settled);

  const checkAdmission = (
    name: string,
    room: Room,
    env: OpEnvelope,
    ctx: PrincipalCtx,
    info: PolicyRoomInfo,
  ): PolicyViolation | null => {
    const policy = opt.policy;
    if (!policy || (!policy.canBump && !policy.verifyCitations)) return null;
    for (const op of env.ops) {
      if (policy.canBump) {
        const observed = room.registers.maxEpoch(op.path);
        if (
          op.epoch > observed &&
          !policy.canBump(ctx, op.path, op.epoch, name, info)
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
        // a cite at or below the origin's settled stamp names a write the room received and may
        // have collected: honest by construction, and exempt from coverage
        const done = room.settled.get(c.origin);
        if (done && hlcLte(c.hlc, done)) continue;
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
            instance: room.instance,
            members: room.members.size,
            journal: room.journal.length,
            stalled: room.release.stalled(),
          }
        : undefined;
    },
    unload: (name, options) => {
      const room = rooms.get(name);
      if (!room || room.members.size > 0) return false;
      if (room.release.busy()) {
        if (options?.discard !== true || !room.release.stalled()) return false;
        room.release.discard();
      }
      rooms.delete(name);
      return true;
    },
    hydrate: (name, snapshot) => {
      const room = roomOf(name);
      if (room.seq !== 0 || room.members.size > 0 || room.journal.length > 0)
        return false;
      room.seq = snapshot.seq;
      room.registers.load(snapshot.registers ?? []);
      if (snapshot.ranges) {
        for (const [origin, r] of Object.entries(snapshot.ranges)) {
          room.ranges.set(origin, createRanges(r));
        }
      } else {
        for (const [origin, v] of Object.entries(snapshot.wm ?? {})) {
          if (v > 0) room.ranges.set(origin, createRanges([[1, v]]));
        }
      }
      for (const [origin, h] of Object.entries(snapshot.settled ?? {})) {
        room.settled.set(origin, h);
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
            if (room.ejected.has(ctx.writer) || joined.get(msg.room)?.ejected) {
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

            const member: Member = {
              socket,
              ctx,
              origin: msg.origin,
              ejected: false,
            };
            joined.set(msg.room, member);
            room.members.add(member);
            opt.onJoin?.(msg.room, ctx, msg.origin);
            broadcast(
              room,
              { t: 'member', room: msg.room, origin: msg.origin },
              member,
            );

            // The document half of the answer is read NOW: room state is exactly what the
            // adapter has been handed so far, so holding this payload behind the release
            // queue makes it durable by the time it is sent. Reading it at release time
            // instead would fold in envelopes ingested since, which are not.
            const doc = {
              seq: room.seq,
              instance: room.instance,
              schemaVersion: room.schemaVersion,
            } as const;
            const body: WelcomeBody =
              room.seq === 0 || msg.seq === room.seq
                ? { mode: 'up-to-date' }
                : msg.seq !== undefined &&
                    room.journal.length > 0 &&
                    msg.seq >= room.journal[0].seq - 1
                  ? {
                      mode: 'delta',
                      envs: room.journal.filter(
                        (e) => e.seq > (msg.seq as number),
                      ),
                    }
                  : {
                      mode: 'snapshot',
                      registers: room.registers.checkpoint(),
                      wm: wmOf(room),
                    };

            // the roster is NOT document state: read it when the welcome actually goes out,
            // so a join or presence update that passed in the meantime is not undone by it
            room.release.submit(() => {
              if (!room.members.has(member) || member.ejected) return;
              socket.send({
                t: 'welcome',
                room: msg.room,
                ...doc,
                ...body,
                peers: [...room.presence.values()].map((e) => e.peer),
                members: [...room.members]
                  .filter((m) => m !== member)
                  .map((m) => m.origin),
              });
            });
            return;
          }

          const member = joined.get(msg.room);
          if (!member || member.ejected || room.ejected.has(ctx.writer)) return;

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
                    : checkEnvelope(opt.policy, env, ctx, msg.room, {
                        seq: room.seq, // before this envelope is sequenced: 0 on an empty room
                      });
          if (violation) {
            eject(msg.room, room, member, violation);
            return;
          }
          // Refusals that eject nobody. The submitter alone hears them, at once: a `drop`
          // carries no committed state, so it never waits behind durability.
          const refuse = (reason: DropMsg['reason']): void => {
            opt.onDrop?.(msg.room, env, reason);
            member.socket.send({
              t: 'drop',
              room: msg.room,
              origin: env.origin,
              version: env.version,
              reason,
            });
          };
          // the generation fence first: nothing written in another generation is answered by
          // this generation's evidence, not even as a duplicate
          if (env.instance !== room.instance) return refuse('generation');
          if (
            env.schemaVersion !== undefined &&
            env.schemaVersion < room.schemaVersion
          ) {
            return refuse('schema');
          }
          const ranges = rangesOf(room, env.origin);
          // admission evidence: a version the room holds is a resend, and the answer is its
          // acknowledgement — never a second sequence number
          if (ranges.has(env.version)) return refuse('duplicate');
          // below the maximum yet never admitted: not a loss in transit on one FIFO connection
          // with in-order resend, so a configuration that violates that assumption
          if (env.version < ranges.max()) return refuse('order');
          // after the refusals: a refused envelope never ingests, so its epochs and cites gate
          // nothing (an outdated client stays outdated, not ejected)
          const admission = checkAdmission(msg.room, room, env, ctx, {
            seq: room.seq,
          });
          if (admission) {
            eject(msg.room, room, member, admission);
            return;
          }
          const seqEnv: SeqEnvelope = { ...env, seq: ++room.seq };
          room.journal.push(seqEnv);
          let bumped = false;
          if (
            env.schemaVersion !== undefined &&
            env.schemaVersion > room.schemaVersion
          ) {
            // a migration is a generation cut: a new nonce, every piece of evidence dropped,
            // every member re-welcomed under it. The migration envelope belongs to the
            // generation it closed and is not recorded in the new one's ranges.
            room.schemaVersion = env.schemaVersion;
            room.instance = mintInstance();
            room.registers.reset();
            room.ranges.clear();
            room.above.clear();
            room.settled.clear();
            room.journal = [seqEnv];
            bumped = true;
          }
          room.registers.ingest(env);
          if (!bumped) admitVersion(room, env);
          // garbage collection runs when the delta tail trims, on the settled vector: it removes
          // only what no future write can observe, so the notice is parity for clients, not a gate
          let moved: Readonly<Record<string, Hlc>> | undefined;
          if (room.journal.length > journalLimit) {
            room.journal.shift();
            if (room.settled.size > 0) {
              moved = settledRecord(room);
              room.registers.settle(moved);
            }
          }
          // who gets the echo: the members present at ingest, read BEFORE the commit hook
          // runs. A member that joins later — while the envelope waits for durability, or
          // synchronously inside the hook itself — has it in its welcome already (the
          // welcome's document half is captured at hello, after this ingest), and sending it
          // again would hand that member one change twice.
          const audience = [...room.members];
          // the re-welcome after a cut reads its document half now, like a hello would
          const rewelcome = bumped
            ? ({
                seq: room.seq,
                instance: room.instance,
                schemaVersion: room.schemaVersion,
                mode: 'snapshot',
                registers: room.registers.checkpoint(),
                wm: wmOf(room),
              } as const)
            : undefined;
          const done = opt.onCommit?.(msg.room, seqEnv, {
            seq: room.seq,
            instance: room.instance,
            checkpoint: () => room.registers.checkpoint(),
            wm: wmOf(room),
            ranges: rangesRecord(room),
            settled: settledRecord(room),
            schemaVersion: room.schemaVersion,
          });
          room.release.submit(
            () => {
              const echo: ServerMsg = { t: 'env', room: msg.room, env: seqEnv };
              for (const member of audience) {
                if (room.members.has(member)) member.socket.send(echo);
              }
              // the settled notice rides BEHIND the envelope that moved it, so no client collects
              // a watermark before the write it protected has passed
              if (moved) {
                broadcast(room, { t: 'settled', room: msg.room, settled: moved });
              }
              if (rewelcome) {
                for (const member of audience) {
                  if (!room.members.has(member) || member.ejected) continue;
                  member.socket.send({
                    t: 'welcome',
                    room: msg.room,
                    ...rewelcome,
                    peers: [...room.presence.values()].map((e) => e.peer),
                    members: [...room.members]
                      .filter((m) => m !== member)
                      .map((m) => m.origin),
                  });
                }
              }
            },
            done ?? undefined,
            seqEnv,
          );
        },
      };
    },
  };
}
