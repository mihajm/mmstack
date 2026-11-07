export type Key = string | number;

/**
 * One structural operation. `set` and `delete` change a value at a path; `clear` retires a
 * per-path register without contributing a value (the observed-remove half of a subtree
 * replace). A `clear` is still a WRITE at its path for policy purposes.
 */
export type StoreOp =
  | { kind: 'set'; path: readonly Key[]; next: unknown; prev?: unknown }
  | { kind: 'delete'; path: readonly Key[]; prev: unknown }
  | { kind: 'clear'; path: readonly Key[] };

/** Hybrid logical clock stamp: physical epoch ms + logical counter. */
export type Hlc = { readonly p: number; readonly l: number };

/** The identity of one write at one path: the emitting replica plus its clock stamp. */
export type Dot = { readonly origin: string; readonly hlc: Hlc };

/**
 * A wire op: a structural {@link StoreOp} plus the causal metadata the per-path register
 * needs. `cites` lists the sibling dot(s) the writer observed at the op's path when it wrote
 * (exactly those get superseded); `epoch` is the op's precedence term, stamped at emission.
 */
export type SyncOp = StoreOp & {
  readonly cites: readonly Dot[];
  readonly epoch: number;
};

/**
 * Wire protocol version, in lockstep with `OP_PROTO_VERSION` in `@mmstack/primitives`: the
 * relay fences on the stamp the emitter puts on the envelope, so the two constants are one
 * fence written in two places and must move together. Version 2 ops carry `cites` + `epoch`
 * (an op without citations cannot be merged soundly — it would supersede nothing and its
 * siblings would accumulate forever); version 3 changes materialization semantics rather than
 * shape, so a v2 and a v3 replica cannot converge on the same op set. Version 4 changes the
 * client FOLD: an array register with no merge policy merges concurrent writes position by
 * position instead of keeping the winner whole, so a v3 and a v4 replica holding the same
 * registers materialize different arrays. Either way the relay rejects envelopes from any other
 * version outright rather than silently mixing incompatible emitters into a room, and a hydrated
 * journal keeps only its current-version suffix (see `Relay.hydrate`). Version 5 introduces the
 * generation cut: snapshot welcomes carry the generation record (a cut's own welcome its seed
 * instead of `registers`), citations and unauthorized bumps are refused with a `drop` that carries
 * the room's sequence, and an empty path segment is malformed.
 */
export const MESH_PROTO_VERSION = 5;

export type OpEnvelope = {
  readonly proto: number;
  /**
   * The room generation this envelope was written in: the instance nonce the writer learned
   * from its welcome. The relay refuses an envelope from another generation (`drop`,
   * `'generation'`). A nonce announced in welcomes alone cannot fence an envelope already in
   * flight or a persisted outbox restored after a cut, so the fence rides on the envelope.
   */
  readonly instance: string;
  readonly origin: string;
  readonly writer: string;
  readonly version: number;
  readonly hlc: Hlc;
  readonly policyVersion: number;
  readonly ops: readonly SyncOp[];
  /**
   * Present only on a MIGRATION envelope: the new `schemaVersion` this envelope
   * establishes. The relay bumps the room's schema + instance when it sequences one; normal
   * writes omit it.
   */
  readonly schemaVersion?: number;
};

/** An envelope the relay has ordered: `seq` is the room-scoped total order. */
export type SeqEnvelope = OpEnvelope & { readonly seq: number };

/**
 * One retained concurrent write at a path. A register keeps at most one sibling per origin
 * (a replica's newer op replaces its own older one), so state stays bounded by the
 * concurrent-writer count, not the op count.
 */
export type SyncSibling = {
  readonly kind: 'set' | 'delete' | 'clear';
  /** The written value for a `set`; absent for `delete`/`clear`. */
  readonly value?: unknown;
  /**
   * On a `set` sibling only: the value the write replaced, the ancestor a value-merging fold
   * merges this sibling against. A `delete` or `clear` sibling never carries it, even though a
   * delete op on the wire does: there `prev` is the emitter's own inversion basis (undo, rebase,
   * replay), which reads the op and never a retained sibling.
   */
  readonly prev?: unknown;
  readonly writer: string;
  readonly origin: string;
  readonly hlc: Hlc;
  readonly epoch: number;
};

/**
 * Serializable per-path register state: the retained siblings plus the per-origin
 * supersession watermarks. This is what a snapshot ships, never a folded value: the fold is
 * client-configured policy, so a joiner seeded with a bare value could neither supersede nor
 * be superseded correctly afterwards.
 */
export type RegisterCheckpoint = {
  readonly path: readonly Key[];
  readonly siblings: readonly SyncSibling[];
  readonly water: Readonly<Record<string, Hlc>>;
  /**
   * The highest epoch ever retained at this path — the epoch-bump admission baseline. Kept
   * apart from the siblings because compaction may collect the sibling that carried it (a
   * citing op need not carry the epoch it supersedes), and the relay's policy answer for a
   * later op must not change with what was collected. Absent means 0.
   */
  readonly epoch?: number;
};

export type PresenceState = {
  readonly origin: string;
  readonly writer: string;
  /** Consumer-defined activity payload (cursor, section, agent activity descriptor…). */
  readonly data: unknown;
};

export type HelloMsg = {
  readonly t: 'hello';
  readonly room: string;
  readonly origin: string;
  readonly proto: number;
  readonly policyVersion: number;
  /** Last room seq this client has applied — enables the delta answer on reconnect. */
  readonly seq?: number;
  /** The data shape this client speaks, older-than-room is rejected `schema`. */
  readonly schemaVersion?: number;
};

export type ClientEnvMsg = {
  readonly t: 'env';
  readonly room: string;
  readonly env: OpEnvelope;
};

export type ClientPresenceMsg = {
  readonly t: 'presence';
  readonly room: string;
  readonly data: unknown;
};

/** Peer-to-peer signaling payload (WebRTC offer/answer/ICE); the relay only routes it. */
export type ClientSignalMsg = {
  readonly t: 'signal';
  readonly room: string;
  readonly to: string;
  readonly data: unknown;
};

/**
 * Version of the `direct` frame, stamped by the sending client. A receiver that does not speak a
 * frame's `v` reads nothing else of it.
 */
export const MESH_DIRECT_VERSION = 1;

/**
 * A directed ephemeral frame: an opaque payload for one other member. The relay routes it to
 * `to` only and never persists it. Use it for application traffic between peers; `signal` stays
 * WebRTC negotiation only.
 */
export type ClientDirectMsg = {
  readonly t: 'direct';
  readonly room: string;
  readonly to: string;
  readonly v: number;
  readonly data: unknown;
};

export type ClientMsg =
  | HelloMsg
  | ClientEnvMsg
  | ClientPresenceMsg
  | ClientSignalMsg
  | ClientDirectMsg
  | ClientCompactMsg;

/** The tri-state join answer, plus the current presence roster. */
/**
 * The state half of a welcome: how the joiner is caught up. `up-to-date` carries nothing,
 * `delta` the journal suffix past the client's watermark, `snapshot` the room's retained
 * register state (never a folded value — the fold is the client's policy).
 */
export type WelcomeBody =
  | { readonly mode: 'up-to-date' }
  | { readonly mode: 'delta'; readonly envs: readonly SeqEnvelope[] }
  | (SnapshotState & {
      /**
       * The cut's own welcome: the generation record's immutable seed, sent once, to the members
       * present at the cut. Never alongside `registers`.
       */
      readonly seed: readonly RegisterCheckpoint[];
      readonly registers?: undefined;
    })
  | (SnapshotState & {
      /** The room's retained register state; the client folds it with its own policy. */
      readonly registers: readonly RegisterCheckpoint[];
      readonly seed?: undefined;
    });

/** What every snapshot welcome carries besides its registers (or the seed). */
export type SnapshotState = GenerationFields & {
  readonly mode: 'snapshot';
  /** Per-origin envelope-version high-water marks at the snapshot point. */
  readonly wm: Readonly<Record<string, number>>;
  /** The first stamp admitted from each origin in this generation, as of the welcome's seq. */
  readonly firstStamps: Readonly<Record<string, Hlc>>;
  /** Admitted versions per origin per generation, carried across cuts (see {@link Receipts}). */
  readonly receipts: Receipts;
  /** This generation's admitted-version ranges per origin, as of the welcome's seq. */
  readonly ranges: Readonly<Record<string, readonly VersionRange[]>>;
  /** This generation's settled vector, as of the welcome's seq. */
  readonly settled: Readonly<Record<string, Hlc>>;
};

/** One ICE server as a browser takes it; the relay may issue these in a welcome. */
export type IceServer = {
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
};

export type WelcomeMsg = {
  readonly t: 'welcome';
  readonly room: string;
  readonly seq: number;
  /** Room-instance nonce: changes when a room is recreated (relay restart, DO eviction),
   *  so clients know their seq watermark belongs to a dead seq space. */
  readonly instance: string;
  /** The room's current data shape. */
  readonly schemaVersion: number;
  readonly peers: readonly PresenceState[];
  /** Origins currently in the room (membership ≠ presence) — the P2P bootstrap roster. */
  readonly members: readonly string[];
  /** ICE servers the operator wants peer links to use; replaces any static list. */
  readonly ice?: readonly IceServer[];
} & WelcomeBody;

export type ServerEnvMsg = {
  readonly t: 'env';
  readonly room: string;
  readonly env: SeqEnvelope;
};

export type ServerPresenceMsg = {
  readonly t: 'presence';
  readonly room: string;
  readonly peer: PresenceState;
  readonly gone?: boolean;
};

export type RejectMsg = {
  readonly t: 'reject';
  readonly room: string;
  readonly reason: 'proto' | 'policy-version' | 'unauthorized' | 'schema';
  readonly expected?: number;
};

export type EjectMsg = {
  readonly t: 'eject';
  readonly room: string;
  readonly writer: string;
  readonly reason: string;
};

/** Membership change broadcast (join/leave), independent of presence announcements. */
export type MemberMsg = {
  readonly t: 'member';
  readonly room: string;
  readonly origin: string;
  readonly gone?: boolean;
};

export type ServerSignalMsg = {
  readonly t: 'signal';
  readonly room: string;
  readonly from: string;
  readonly data: unknown;
};

/** A `direct` frame as delivered: the relay stamps `from` with the sender's origin. */
export type ServerDirectMsg = {
  readonly t: 'direct';
  readonly room: string;
  readonly from: string;
  readonly v: number;
  readonly data: unknown;
};

/**
 * The room's settled vector moved: per origin, the stamp of the last version in that origin's
 * contiguously admitted prefix. Nothing new from an origin can arrive at or below its entry
 * (per-connection FIFO, per-origin monotone stamps, in-order resend), and anything that does
 * is a duplicate the relay answers as such. Clients garbage-collect superseded siblings and
 * citation watermarks at or below it — the same rule the relay runs — and nothing else. It
 * rides behind the envelope that moved it, so a client never collects a watermark before the
 * write it protected has passed.
 */
export type SettledMsg = {
  readonly t: 'settled';
  readonly room: string;
  readonly settled: Readonly<Record<string, Hlc>>;
};

/**
 * The relay's answer for an envelope it neither echoed nor ejected: sent to the submitting
 * connection only, never broadcast, never held behind durability (it carries no committed
 * state). `'duplicate'` is an acknowledgement — the room already holds that (origin, version).
 * The others refuse an honest writer: `'generation'` (written in another room generation),
 * `'schema'` (a data shape older than the room's), `'order'` (a version below the origin's
 * admitted maximum that was never admitted — impossible on one FIFO connection with in-order
 * resend, so a configuration that violates that assumption), `'epoch-bump'` (an epoch above the
 * room's baseline from a writer the policy does not let raise it) and `'citation'` (a cite the
 * room's state does not cover). The last two are journaled with the room and repeated on every
 * resend. `'compacting'` is a HOST refusal the relay itself never emits: a host may answer a write
 * from a connection that declared itself ready for the current generation (`compact`) with it,
 * without forwarding the write. A refused write is not in the room; the writer drops it and
 * rehydrates.
 */
export type DropMsg = {
  readonly t: 'drop';
  readonly room: string;
  readonly origin: string;
  readonly version: number;
  readonly reason:
    | 'duplicate'
    | 'generation'
    | 'schema'
    | 'order'
    | 'citation'
    | 'epoch-bump'
    | 'compacting';
  /**
   * The room's sequence as of this reply. A refusal journaled by the room (`'citation'`,
   * `'epoch-bump'`) is answered again, unchanged but for this field, on every resend of the same
   * envelope; a writer owes itself a snapshot at or past this sequence before trusting its view.
   */
  readonly seq: number;
};

/** An inclusive range of admitted envelope versions for one origin. */
export type VersionRange = readonly [from: number, to: number];

/** Why a generation began. `genesis` is a room's first generation; every other reason is a cut. */
export type GenerationReason =
  'genesis' | 'migration' | 'compaction' | 'rollback' | 'consensus';

/**
 * What the new generation does with a tail written in the previous one: `discard` (migration,
 * rollback: the reset is the intent) or `replay` (compaction, consensus: verbatim resend, each
 * envelope gated on its cites).
 */
export type TailPolicy = 'discard' | 'replay';

/**
 * Admitted versions per envelope origin, per generation instance. The one admission evidence a
 * cut never clears: a writer trims its persisted tail by exact membership here.
 */
export type Receipts = Readonly<
  Record<string, Readonly<Record<string, readonly VersionRange[]>>>
>;

/** The immutable fields of a generation, carried by every snapshot welcome of it. */
export type GenerationFields = {
  /** The generation's ordinal in the room: 0 for genesis, one more at every cut. */
  readonly index: number;
  readonly reason: GenerationReason;
  readonly policy: TailPolicy;
  /**
   * The frozen seed extent: per register path key, per origin, the highest stamp the seed
   * retains. The only witness to a dot written before the cut.
   */
  readonly extent: Readonly<Record<string, Readonly<Record<string, Hlc>>>>;
  /**
   * Per origin, the highest stamp the room held before the cut (seed dots included): a cited dot
   * at or below it is pre-cut and answered by `extent` alone.
   */
  readonly preCutMax: Readonly<Record<string, Hlc>>;
};

/**
 * The generation record, minted at a cut and persisted whole before anything is answered under
 * the new instance. `seq` is the cut's own row in the room's logical sequence, which never
 * restarts. `firstStamps` is empty at the cut and grows during the generation; `receipts` are
 * the ones carried across the cut.
 */
export type GenerationRecord = GenerationFields & {
  readonly instance: string;
  readonly seq: number;
  /** The live siblings the generation starts from, original dots, no watermarks. */
  readonly seed: readonly RegisterCheckpoint[];
  readonly firstStamps: Readonly<Record<string, Hlc>>;
  readonly receipts: Receipts;
};

/**
 * A member's declared readiness for a consensus cut, re-sent on every change. Bound to the
 * generation: a declaration naming another `instance` is ignored. Safety never depends on it.
 */
export type ClientCompactMsg = {
  readonly t: 'compact';
  readonly room: string;
  readonly instance: string;
  readonly ready: boolean;
};

/**
 * The room's compaction state: the counted droppable tombstones, the hard budget (0 when the
 * room arms none) and the origins of the members currently declared ready.
 */
export type CompactionMsg = {
  readonly t: 'compaction';
  readonly room: string;
  readonly count: number;
  readonly budget: number;
  readonly ready: readonly string[];
};

export type ServerMsg =
  | WelcomeMsg
  | ServerEnvMsg
  | ServerPresenceMsg
  | RejectMsg
  | EjectMsg
  | MemberMsg
  | ServerSignalMsg
  | ServerDirectMsg
  | SettledMsg
  | DropMsg
  | CompactionMsg;
