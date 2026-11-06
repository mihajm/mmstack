import {
  checkEnvelope,
  type OpPolicy,
  type PolicyRoomInfo,
  type PolicyViolation,
  type PrincipalCtx,
} from './policy';
import { createRanges, recordAdmission, type Ranges } from './ranges';
import { createRegisterStore, extentOf, pathKey, type RegisterStore } from './register';
import { validateDirect, validateEnvelope } from './validate';
import {
  MESH_PROTO_VERSION,
  type ClientMsg,
  type Dot,
  type DropMsg,
  type GenerationReason,
  type GenerationRecord,
  type Hlc,
  type IceServer,
  type Key,
  type OpEnvelope,
  type PresenceState,
  type RegisterCheckpoint,
  type Receipts,
  type RejectMsg,
  type SeqEnvelope,
  type ServerMsg,
  type TailPolicy,
  type VersionRange,
  type WelcomeBody,
} from './wire';

/** A refusal the room journals: repeated, unchanged, on every resend of the same envelope. */
export type JournaledRefusal = 'citation' | 'epoch-bump';

/** A cut's row in the room's logical sequence: the whole generation record. */
export type CutRow = {
  readonly kind: 'cut';
  readonly seq: number;
  readonly record: GenerationRecord;
};

/** A journaled refusal's row: the envelope it refused, by identity, and why. */
export type RefuseRow = {
  readonly kind: 'refuse';
  readonly seq: number;
  readonly instance: string;
  readonly origin: string;
  readonly version: number;
  readonly reason: JournaledRefusal;
};

/** A row of the room's logical sequence that is not an envelope. */
export type RelayRow = CutRow | RefuseRow;

/**
 * What a citation is judged against: the generation's frozen seed extent and `preCutMax`, and the
 * generation's first stamps and settled vector.
 */
export type CoverContext = {
  readonly extent: Readonly<Record<string, Readonly<Record<string, Hlc>>>>;
  readonly preCutMax: Readonly<Record<string, Hlc>>;
  firstStamp(origin: string): Hlc | undefined;
  settled(origin: string): Hlc | undefined;
};

const stampLte = (a: Hlc, b: Hlc): boolean => a.p < b.p || (a.p === b.p && a.l <= b.l);

/**
 * Is the cited `dot` at `path` covered? Two regimes, the cut as boundary. A dot at or below its
 * origin's `preCutMax` was written before the cut: only the frozen seed extent answers for it. A
 * later dot is covered by the extent, by the store's retained state, or by the settled exemption
 * floored at the cited origin's first stamp of this generation (no floor, no exemption). Run on
 * every envelope, fresh or replayed, and by a client against its own installed state.
 */
export function admits(
  store: RegisterStore,
  ctx: CoverContext,
  path: readonly Key[],
  dot: Dot,
): boolean {
  const ext = ctx.extent[pathKey(path)]?.[dot.origin];
  const byExtent = !!ext && stampLte(dot.hlc, ext);
  const pre = ctx.preCutMax[dot.origin];
  if (pre && stampLte(dot.hlc, pre)) return byExtent;
  if (byExtent || store.covers(path, dot)) return true;
  const done = ctx.settled(dot.origin);
  if (!done || !stampLte(dot.hlc, done)) return false;
  const floor = ctx.firstStamp(dot.origin);
  return !!floor && stampLte(floor, dot.hlc);
}

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
  /** Seq-envelopes retained per room for delta answers (default 1000; 0 keeps none, every behind client gets a snapshot). Trimming the tail is also when the room garbage-collects settled register evidence. */
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
   * is written. Messages that are not document state — presence, signal, direct, membership,
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
  /**
   * The persistence egress for the rows of the room's logical sequence that are not envelopes: a
   * cut (the whole generation record) and a journaled refusal. Same contract as
   * {@link RelayOptions.onCommit}: synchronous, before anything the row decides leaves the relay,
   * and a returned promise holds every later answer of the room until it resolves (a rejection
   * stalls the room, see {@link RoomInfo.stalled}). A migration's cut is its envelope's commit:
   * `onCommit` reports it, with {@link RoomState.generation} already the new record.
   */
  readonly onRow?: (room: string, row: RelayRow, state: RoomState) => void | Promise<void>;
  /**
   * Generation cuts the relay takes on its own. Arming either needs `policy.verifyCitations`: a cut
   * without the citation gate lets a dropped dot replay, so {@link createRelay} refuses to start.
   */
  readonly compaction?: {
    /**
     * The tombstone budget, held against {@link RegisterStore.droppableTombstones}. Hard budget =
     * max(`floor`, `factor` × the registers a cut keeps), evaluated on every commit: over it, the
     * room cuts at once. Soft budget = half of it: over it, the room cuts after the next QUIET
     * commit — one arriving at least `quietMs` (default 2000) after the room's previous admitted
     * commit, measured with `now`. No timers: a room that never goes quiet waits for the hard
     * budget.
     */
    readonly budget?: {
      readonly floor: number;
      readonly factor: number;
      readonly quietMs?: number;
    };
    /** Cut when every connected member has declared itself ready (`compact` messages). */
    readonly consensus?: boolean;
  };
  /**
   * The durability promise an `onRow` returned for `row` rejected: the room is stalled, exactly as
   * for {@link RelayOptions.onDurabilityFailed}. Fires once, for the row that failed.
   */
  readonly onRowDurabilityFailed?: (room: string, row: RelayRow, cause: unknown) => void;
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
  /**
   * ICE servers issued to peer links in every welcome. The function form is called per welcome
   * with the room and the welcomed origin, for minting short-lived TURN credentials. Credentials
   * are only refreshed by a later welcome, so choose a lifetime longer than a session.
   */
  readonly iceServers?:
    | readonly IceServer[]
    | ((room: string, origin: string) => readonly IceServer[]);
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
  /**
   * The current generation record, its `firstStamps` and `receipts` as of this commit. Persist it
   * with the checkpoint; hand it back through {@link RoomSnapshot.generation}.
   */
  readonly generation: GenerationRecord;
  /** Per origin, the highest stamp the room ever held: the next cut's `preCutMax`. */
  readonly everMax: Readonly<Record<string, Hlc>>;
  /** This generation's journaled refusals, by `origin#version`. */
  readonly refused: Readonly<Record<string, JournaledRefusal>>;
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
  /**
   * The generation record captured with the checkpoint (see {@link RoomState.generation}). Its
   * `instance` wins over {@link RoomSnapshot.instance}; journal entries before its `seq` belong to
   * an earlier generation and are not served, and an entry after it from another generation is an
   * inconsistent checkpoint: hydrate throws.
   */
  readonly generation?: GenerationRecord;
  /** See {@link RoomState.everMax}. */
  readonly everMax?: Readonly<Record<string, Hlc>>;
  /** See {@link RoomState.refused}. */
  readonly refused?: Readonly<Record<string, JournaledRefusal>>;
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
   * it. Load asynchronously at the adapter layer, then hydrate synchronously. Journal entries
   * before the first one stamped {@link MESH_PROTO_VERSION} are dropped (written before an
   * upgrade, they fold differently), then the newest `journalLimit` are kept. A client BEHIND the
   * room (`msg.seq < room.seq`) is answered with deltas exactly when the kept journal is non-empty
   * and `msg.seq >= firstKept.seq - 1` (the last dropped seq itself still gets the kept suffix as
   * deltas), otherwise with a snapshot; a client at `room.seq` is up to date. PRECONDITION, not
   * validated: protocol versions only rise along a journal (an upgrade is monotone), so old-proto
   * entries form a prefix; an old entry after a current one would be kept and served.
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
  /**
   * Cut the room's generation: a new instance, register state reset to the seed, admission
   * evidence and journaled refusals cleared, receipts kept, every member re-welcomed with the
   * seed once the cut row is durable. `compaction` and `consensus` seed from the retained state
   * ({@link RegisterStore.compactionSeed}) and replay tails; `migration` and `rollback` take the
   * supplied seed and discard them. False for a room this relay does not hold, a stalled room, a
   * room (or a supplied seed) whose root register holds no live `set`, or a missing seed. Throws
   * for `compaction` or `consensus` without `policy.verifyCitations`.
   */
  cut(
    name: string,
    options: {
      readonly reason: Exclude<GenerationReason, 'genesis'>;
      readonly seed?: readonly RegisterCheckpoint[];
    },
  ): boolean;
};

/**
 * An ordered hold on the room's outbound document traffic. Each queued item releases only
 * after its own durability promise settles and after every item queued ahead of it, so what
 * a connection reads is always a prefix of what the adapter has confirmed. An item with no
 * promise releases as soon as it reaches the head — and, when nothing is owed, at once, which
 * is the whole behaviour of a relay whose adapter stores synchronously.
 */
type Release = {
  submit(run: () => void, done?: Promise<void>, held?: SeqEnvelope | RelayRow): void;
  /** Something is queued or in flight: a fresh answer must queue behind it. */
  busy(): boolean;
  /** A durability promise rejected; the queue will never drain on its own again. */
  stalled(): boolean;
  /** Drops everything queued without releasing it. Only meaningful once stalled. Answers how many. */
  discard(): number;
};

const createRelease = (
  onFail: (held: SeqEnvelope | RelayRow | undefined, cause: unknown) => void,
): Release => {
  type Item = {
    readonly run: () => void;
    readonly done?: Promise<void>;
    readonly held?: SeqEnvelope | RelayRow;
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
            onFail(head.held, cause);
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
    submit: (run, done, held) => {
      if (!stalled && !draining && queue.length === 0 && done === undefined) {
        run();
        return;
      }
      queue.push({ run, done, held });
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
  /** Declared ready for a consensus cut in the current generation; never persisted. */
  ready: boolean;
};

/** The immutable part of the current generation (first stamps and receipts live on the room). */
type Head = {
  readonly seq: number;
  readonly index: number;
  readonly reason: GenerationReason;
  readonly policy: TailPolicy;
  readonly seed: readonly RegisterCheckpoint[];
  readonly extent: Readonly<Record<string, Readonly<Record<string, Hlc>>>>;
  readonly preCutMax: Readonly<Record<string, Hlc>>;
};
const GENESIS: Head = {
  seq: 0,
  index: 0,
  reason: 'genesis',
  policy: 'discard',
  seed: [],
  extent: {},
  preCutMax: {},
};

type Bucket = { tokens: number; last: number };

type Room = {
  seq: number;
  instance: string;
  schemaVersion: number;
  registers: RegisterStore;
  /** Admitted versions per origin: the admission evidence. */
  ranges: Map<string, Ranges>;
  /** Per origin, the stamp of the last contiguously admitted version. */
  settled: Map<string, Hlc>;
  head: Head;
  firstStamps: Map<string, Hlc>;
  everMax: Map<string, Hlc>;
  receipts: Map<string, Map<string, Ranges>>;
  refused: Map<string, JournaledRefusal>;
  /** Over the soft budget: cut at the next commit that finds nothing in flight. */
  softDue: boolean;
  /** The percent of the hard budget the last notice carried: a commit that keeps it sends none. */
  noticed?: number;
  /** When the room's previous admitted commit arrived (`opt.now`): what makes a commit quiet. */
  lastCommit?: number;
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
  const armed = !!opt.compaction?.budget || !!opt.compaction?.consensus;
  if (armed && !opt.policy?.verifyCitations) {
    throw new Error(
      'mesh relay: compaction cuts need policy.verifyCitations — without the citation gate a cut lets a dropped write replay',
    );
  }
  const rooms = new Map<string, Room>();
  const policyVersion = opt.policyVersion ?? 0;
  const journalLimit = opt.journalLimit ?? 1000;
  /** The newest `journalLimit` entries (`slice(-0)` would keep everything: a limit of 0 keeps none). */
  const keepTail = <E>(journal: E[]): E[] =>
    journalLimit > 0 ? journal.slice(-journalLimit) : [];
  const maxOps = opt.limits?.maxOpsPerEnvelope ?? 1024;
  const rate = opt.limits?.maxEnvelopesPerSecond;
  const iceFor = (room: string, origin: string) => {
    const ice = opt.iceServers;
    const servers = typeof ice === 'function' ? ice(room, origin) : ice;
    return servers ? { ice: servers } : {};
  };
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
        settled: new Map(),
        head: GENESIS,
        firstStamps: new Map(),
        everMax: new Map(),
        receipts: new Map(),
        refused: new Map(),
        softDue: false,
        journal: [],
        members: new Set(),
        presence: new Map(),
        ejected: new Set(),
        buckets: new Map(),
        release: createRelease((held, cause) => {
          if (!held) return;
          if ('kind' in held) opt.onRowDurabilityFailed?.(name, held, cause);
          else opt.onDurabilityFailed?.(name, held, cause);
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
    left(name, room);
  };
  /** A member left: the census may now be unanimous. */
  const left = (name: string, room: Room): void => {
    notice(name, room);
    census(name, room);
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
  const settledRecord = (room: Room): Record<string, Hlc> =>
    Object.fromEntries(room.settled);

  const recordOf = (m: ReadonlyMap<string, Hlc>): Record<string, Hlc> => Object.fromEntries(m);
  const receiptsRecord = (room: Room): Receipts => {
    const out: Record<string, Record<string, readonly VersionRange[]>> = {};
    for (const [origin, byInstance] of room.receipts) {
      out[origin] = {};
      for (const [instance, r] of byInstance) out[origin][instance] = r.toJSON();
    }
    return out;
  };
  const coverCtx = (room: Room): CoverContext => ({
    extent: room.head.extent,
    preCutMax: room.head.preCutMax,
    firstStamp: (origin) => room.firstStamps.get(origin),
    settled: (origin) => room.settled.get(origin),
  });
  const generationOf = (room: Room): GenerationRecord => ({
    instance: room.instance,
    seq: room.head.seq,
    index: room.head.index,
    reason: room.head.reason,
    policy: room.head.policy,
    seed: room.head.seed,
    extent: room.head.extent,
    preCutMax: room.head.preCutMax,
    firstStamps: recordOf(room.firstStamps),
    receipts: receiptsRecord(room),
  });
  const stateOf = (room: Room): RoomState => ({
    seq: room.seq,
    instance: room.instance,
    checkpoint: () => room.registers.checkpoint(),
    wm: wmOf(room),
    ranges: rangesRecord(room),
    settled: settledRecord(room),
    schemaVersion: room.schemaVersion,
    generation: generationOf(room),
    everMax: recordOf(room.everMax),
    refused: Object.fromEntries(room.refused),
  });
  /** What every snapshot welcome carries besides its registers or seed, read now. */
  const snapshotOf = (room: Room) =>
    ({
      mode: 'snapshot',
      wm: wmOf(room),
      index: room.head.index,
      reason: room.head.reason,
      policy: room.head.policy,
      extent: room.head.extent,
      preCutMax: room.head.preCutMax,
      firstStamps: recordOf(room.firstStamps),
      receipts: receiptsRecord(room),
      ranges: rangesRecord(room),
      settled: settledRecord(room),
    }) as const;
  /** The rootedness precondition of a cut that keeps dots: the root register holds a live `set`. */
  const rooted = (registers: RegisterStore): boolean =>
    registers.siblings([]).some((s) => s.kind === 'set');
  /** The count as whole percent of the hard budget: the notice cadence after a commit. */
  const percentOf = (room: Room, count: number): number => {
    const hard = hardBudget(room);
    return hard > 0 ? Math.floor((100 * count) / hard) : count;
  };
  const hardBudget = (room: Room): number => {
    const b = opt.compaction?.budget;
    return b ? Math.max(b.floor, b.factor * room.registers.keptRegisters()) : 0;
  };

  /** Broadcast the room's compaction state, ordered behind the document traffic it describes. */
  const notice = (name: string, room: Room): void => {
    if (!armed) return;
    const count = room.registers.droppableTombstones();
    room.noticed = percentOf(room, count);
    const msg: ServerMsg = {
      t: 'compaction',
      room: name,
      count,
      budget: hardBudget(room),
      ready: [...room.members].filter((m) => m.ready).map((m) => m.origin),
    };
    room.release.submit(() => broadcast(room, msg));
  };

  /**
   * The cut itself, synchronous so no admission falls between capture and boundary: capture the
   * seed, mint the instance, freeze extent and preCutMax, reset registers to the seed (its
   * baselines ride along), clear admission evidence, refusals and readiness; receipts and the
   * logical sequence carry on. `row` is the migration envelope that is itself the cut row.
   * Answers the members present at the cut and the cut welcome's document half.
   */
  const cutRoom = (
    room: Room,
    reason: Exclude<GenerationReason, 'genesis'>,
    supplied: readonly RegisterCheckpoint[] | undefined,
    row?: SeqEnvelope,
  ) => {
    const replay = reason === 'compaction' || reason === 'consensus';
    const seed = replay ? room.registers.compactionSeed() : (supplied ?? []);
    const preCutMax = new Map(room.everMax);
    for (const r of seed) {
      for (const x of r.siblings) {
        const cur = preCutMax.get(x.origin);
        if (!cur || !stampLte(x.hlc, cur)) preCutMax.set(x.origin, x.hlc);
      }
    }
    room.instance = mintInstance();
    room.registers.reset();
    room.registers.load(seed);
    room.ranges.clear();
    room.settled.clear();
    room.firstStamps.clear();
    room.refused.clear();
    for (const [origin, h] of preCutMax) room.everMax.set(origin, h);
    for (const m of room.members) m.ready = false;
    room.softDue = false;
    room.head = {
      seq: row ? row.seq : ++room.seq,
      index: room.head.index + 1,
      reason,
      policy: replay ? 'replay' : 'discard',
      seed,
      extent: extentOf(seed),
      preCutMax: recordOf(preCutMax),
    };
    room.journal = row ? [row] : [];
    const doc = {
      seq: room.seq,
      instance: room.instance,
      schemaVersion: room.schemaVersion,
      ...snapshotOf(room),
      seed,
    } as const;
    return { audience: [...room.members], doc };
  };
  /** The re-welcome after a cut: the seed and the record to every member present at the cut. */
  const rewelcome =
    (name: string, room: Room, cut: ReturnType<typeof cutRoom>) => (): void => {
      for (const member of cut.audience) {
        if (!room.members.has(member) || member.ejected) continue;
        member.socket.send({
          t: 'welcome',
          room: name,
          ...cut.doc,
          peers: [...room.presence.values()].map((e) => e.peer),
          members: [...room.members].filter((m) => m !== member).map((m) => m.origin),
          ...iceFor(name, member.origin),
        });
      }
    };
  /** A cut with no envelope behind it: its own row, persisted before the re-welcome. */
  const cutNow = (
    name: string,
    room: Room,
    reason: Exclude<GenerationReason, 'genesis'>,
    seed?: readonly RegisterCheckpoint[],
  ): void => {
    const cut = cutRoom(room, reason, seed);
    const row: CutRow = { kind: 'cut', seq: room.head.seq, record: generationOf(room) };
    const done = opt.onRow?.(name, row, stateOf(room));
    room.release.submit(rewelcome(name, room, cut), done ?? undefined, row);
    notice(name, room);
  };

  /** Census: every connected member declared ready in this generation ⇒ a consensus cut. */
  const census = (name: string, room: Room): void => {
    if (!opt.compaction?.consensus || room.release.stalled()) return;
    const members = [...room.members].filter((m) => !m.ejected && !room.ejected.has(m.ctx.writer));
    if (!members.length || !members.every((m) => m.ready) || !rooted(room.registers)) return;
    cutNow(name, room, 'consensus');
  };
  /** The tombstone budget after a commit: hard ⇒ cut now; soft ⇒ cut after a quiet commit. */
  const budget = (name: string, room: Room, quiet: boolean): void => {
    if (!opt.compaction?.budget || room.release.stalled() || !rooted(room.registers)) return;
    const count = room.registers.droppableTombstones();
    const hard = hardBudget(room);
    if (count > hard / 2) room.softDue = true;
    if (count > hard || (room.softDue && quiet)) cutNow(name, room, 'compaction');
    else if (room.noticed !== percentOf(room, count)) notice(name, room);
  };

  /**
   * The admission gate after the refusals that eject nobody: an epoch raised past the room's
   * baseline by a writer the policy does not allow, then a cite the generation does not cover.
   * Refused, never ejected: an honest writer lands the refusal as a conflict.
   */
  const gate = (
    name: string,
    room: Room,
    env: OpEnvelope,
    ctx: PrincipalCtx,
    info: PolicyRoomInfo,
  ): JournaledRefusal | null => {
    const policy = opt.policy;
    if (policy?.canBump) {
      for (const op of env.ops) {
        if (
          op.epoch > room.registers.maxEpoch(op.path) &&
          !policy.canBump(ctx, op.path, op.epoch, name, info)
        ) {
          return 'epoch-bump';
        }
      }
    }
    if (policy?.verifyCitations) {
      const cover = coverCtx(room);
      for (const op of env.ops) {
        for (const c of op.cites) {
          // a self-citation of this very envelope's dot is ignored at ingest (born-dead guard)
          if (c.origin === env.origin && c.hlc.p === env.hlc.p && c.hlc.l === env.hlc.l) continue;
          if (!admits(room.registers, cover, op.path, c)) return 'citation';
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
    cut: (name, options) => {
      const room = rooms.get(name);
      if (!room || room.release.stalled()) return false;
      const replay = options.reason === 'compaction' || options.reason === 'consensus';
      if (replay && !opt.policy?.verifyCitations) {
        throw new Error(
          `mesh relay: a ${options.reason} cut needs policy.verifyCitations — without the citation gate a cut lets a dropped write replay`,
        );
      }
      if (replay ? !rooted(room.registers) : !options.seed) return false;
      if (!replay) {
        const check = createRegisterStore();
        check.load(options.seed ?? []);
        if (!rooted(check)) return false;
      }
      cutNow(name, room, options.reason, options.seed);
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
      const g = snapshot.generation;
      if (g) {
        room.instance = g.instance;
        room.head = {
          seq: g.seq,
          index: g.index,
          reason: g.reason,
          policy: g.policy,
          seed: g.seed,
          extent: g.extent,
          preCutMax: g.preCutMax,
        };
        for (const [origin, h] of Object.entries(g.firstStamps)) room.firstStamps.set(origin, h);
        for (const [origin, byInstance] of Object.entries(g.receipts)) {
          const held = new Map<string, Ranges>();
          for (const [instance, r] of Object.entries(byInstance)) {
            held.set(instance, createRanges(r));
          }
          room.receipts.set(origin, held);
        }
      } else {
        // a snapshot from before generation records: the room never cut, so it has no pre-cut dots
        // and floor 0 leaves the settled exemption exactly the within-generation rule
        for (const origin of Object.keys(snapshot.settled ?? {})) {
          room.firstStamps.set(origin, { p: 0, l: 0 });
        }
      }
      for (const [origin, h] of Object.entries(snapshot.everMax ?? {})) room.everMax.set(origin, h);
      for (const [key, why] of Object.entries(snapshot.refused ?? {})) room.refused.set(key, why);
      if (snapshot.schemaVersion !== undefined)
        room.schemaVersion = snapshot.schemaVersion;
      // a room whose cuts keep dots must be rooted: its root register holds a live `set`
      if (armed && room.seq > 0 && !rooted(room.registers)) {
        rooms.delete(name);
        throw new Error(
          `mesh relay: room ${name} refused — its root register holds no live set, so a compaction cut cannot preserve it`,
        );
      }
      if (snapshot.journal) {
        const head = room.head.seq;
        const journal = snapshot.journal
          .filter((e) => e.seq <= snapshot.seq && e.seq >= head)
          .sort((a, b) => a.seq - b.seq);
        // the first entry may be the migration envelope that cut the generation; every later one
        // belongs to it, or the checkpoint mixes generations and the room must not boot
        const stray = g && journal.find((e) => e.seq > head && e.instance !== room.instance);
        if (stray) {
          rooms.delete(name);
          throw new Error(
            `mesh relay: room ${name} refused — inconsistent checkpoint, seq ${stray.seq} belongs to generation ${stray.instance}, not ${room.instance}`,
          );
        }
        // entries written under an older protocol form a prefix (the version changes only at an
        // upgrade); a delta answer must never serve them, so the journal starts at the first
        // current-version entry and a client behind it is answered with a snapshot instead
        const first = journal.findIndex((e) => e.proto === MESH_PROTO_VERSION);
        room.journal = keepTail(first === -1 ? [] : journal.slice(first));
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
          left(name, room);
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
              ready: false,
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
                      ...snapshotOf(room),
                      registers: room.registers.checkpoint(),
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
                ...iceFor(msg.room, member.origin),
              });
            });
            notice(msg.room, room); // a joiner is not ready: the census changed
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

          // routed like `signal` and never persisted; a malformed frame or one for an origin
          // that is not a member reaches no one
          if (msg.t === 'direct') {
            if (validateDirect(msg) !== null) return;
            for (const target of room.members) {
              if (target.origin === msg.to) {
                target.socket.send({
                  t: 'direct',
                  room: msg.room,
                  from: member.origin,
                  v: msg.v,
                  data: msg.data,
                });
                break;
              }
            }
            return;
          }

          // readiness for a consensus cut, bound to the generation it names
          if (msg.t === 'compact') {
            if (!opt.compaction?.consensus || msg.instance !== room.instance) return;
            if (member.ready === (msg.ready === true)) return;
            member.ready = msg.ready === true;
            notice(msg.room, room);
            census(msg.room, room);
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
                    : env.writer !== ctx.writer
                      ? { writer: ctx.writer, reason: 'writer-mismatch' }
                      : null;
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
              seq: room.seq,
            });
          };
          // a journaled refusal is answered behind the durability of its row, and again on every
          // resend, with the room's sequence as of the reply
          const answer = (
            reason: JournaledRefusal,
            done?: Promise<void>,
            row?: RefuseRow,
          ): void => {
            opt.onDrop?.(msg.room, env, reason);
            const reply: ServerMsg = {
              t: 'drop',
              room: msg.room,
              origin: env.origin,
              version: env.version,
              reason,
              seq: room.seq,
            };
            room.release.submit(
              () => {
                if (room.members.has(member)) member.socket.send(reply);
              },
              done,
              row,
            );
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
          // read, never opened here: an origin gets an entry when a version of its is admitted,
          // so a refused or ejected writer leaves nothing for a checkpoint to carry
          const ranges = room.ranges.get(env.origin);
          // admission evidence: a version the room holds is a resend, and the answer is its
          // acknowledgement — never a second sequence number
          if (ranges?.has(env.version)) return refuse('duplicate');
          // refused stays refused for the generation, and the writer hears it again
          const key = `${env.origin}#${env.version}`;
          const was = room.refused.get(key);
          if (was) return answer(was);
          // below the maximum yet never admitted: not a loss in transit on one FIFO connection
          // with in-order resend, so a configuration that violates that assumption
          if (ranges && env.version < ranges.max()) return refuse('order');
          // after the refusals: a refused envelope never ingests, so neither its epochs and cites
          // nor the room state a rule reads gate anything. The policy runs here too, not with the
          // shape checks above: a resend of an admitted write is acknowledged as a duplicate, never
          // judged again against a room that has moved on since (an outdated client stays
          // outdated, not ejected)
          const info: PolicyRoomInfo = {
            seq: room.seq, // before this envelope is sequenced: 0 on an empty room
            siblings: (path) => room.registers.siblings(path),
          };
          const judged = checkEnvelope(opt.policy, env, ctx, msg.room, info);
          if (judged) {
            eject(msg.room, room, member, judged);
            return;
          }
          const refused = gate(msg.room, room, env, ctx, info);
          if (refused) {
            room.refused.set(key, refused);
            const row: RefuseRow = {
              kind: 'refuse',
              seq: ++room.seq,
              instance: room.instance,
              origin: env.origin,
              version: env.version,
              reason: refused,
            };
            return answer(refused, opt.onRow?.(msg.room, row, stateOf(room)) ?? undefined, row);
          }
          // quiet: this commit arrives at least `quietMs` after the room's previous admitted commit
          const at = now();
          const quiet =
            room.lastCommit !== undefined &&
            at - room.lastCommit >= (opt.compaction?.budget?.quietMs ?? 2000);
          room.lastCommit = at;
          const seqEnv: SeqEnvelope = { ...env, seq: ++room.seq };
          room.journal.push(seqEnv);
          // a migration is a generation cut whose row is its own envelope: admitted (and
          // receipted) in the generation it closes, its root write is the new generation's seed
          const migrates =
            env.schemaVersion !== undefined && env.schemaVersion > room.schemaVersion;
          recordAdmission(room, env);
          let cut: ReturnType<typeof cutRoom> | undefined;
          if (migrates) {
            const minted = createRegisterStore();
            minted.ingest(env);
            const seed = minted
              .checkpoint()
              .filter((r) => r.siblings.length > 0)
              .map((r) => ({ ...r, water: {} }));
            room.schemaVersion = env.schemaVersion as number;
            cut = cutRoom(room, 'migration', seed, seqEnv);
          } else {
            room.registers.ingest(env);
          }
          // garbage collection runs when the delta tail trims, on the settled vector: it removes
          // only what no future write can observe, so the notice is parity for clients, not a gate
          let moved: Readonly<Record<string, Hlc>> | undefined;
          if (room.journal.length > journalLimit) {
            room.journal = keepTail(room.journal);
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
          const done = opt.onCommit?.(msg.room, seqEnv, stateOf(room));
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
              if (cut) rewelcome(msg.room, room, cut)();
            },
            done ?? undefined,
            seqEnv,
          );
          if (cut) notice(msg.room, room);
          else budget(msg.room, room, quiet);
        },
      };
    },
  };
}
