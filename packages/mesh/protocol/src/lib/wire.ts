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
 * Wire protocol version. Version 2 ops carry `cites` + `epoch`: an op without citations
 * cannot be merged soundly (it would supersede nothing and its siblings would accumulate
 * forever), so the relay rejects envelopes from any other protocol version outright rather
 * than silently mixing pre-citation emitters into a room.
 */
export const MESH_PROTO_VERSION = 2;

export type OpEnvelope = {
  readonly proto: number;
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
  /** The emitter's inversion hint, kept for value-merging folds on the client. */
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

export type ClientMsg =
  | HelloMsg
  | ClientEnvMsg
  | ClientPresenceMsg
  | ClientSignalMsg;

/** The tri-state join answer, plus the current presence roster. */
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
} & (
  | { readonly mode: 'up-to-date' }
  | { readonly mode: 'delta'; readonly envs: readonly SeqEnvelope[] }
  | {
      readonly mode: 'snapshot';
      /** The room's retained register state; the client folds it with its own policy. */
      readonly registers: readonly RegisterCheckpoint[];
      /** Per-origin envelope-version high-water marks at the snapshot point. */
      readonly wm: Readonly<Record<string, number>>;
    }
);

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

/** The room's stability frontier advanced (the relay compacted past it). A client may reclaim its
 *  own register state at or below this stamp; a straggler below it is rejected at ingest. */
export type FrontierMsg = {
  readonly t: 'frontier';
  readonly room: string;
  readonly frontier: Hlc;
};

export type ServerMsg =
  | WelcomeMsg
  | ServerEnvMsg
  | ServerPresenceMsg
  | RejectMsg
  | EjectMsg
  | MemberMsg
  | ServerSignalMsg
  | FrontierMsg;
