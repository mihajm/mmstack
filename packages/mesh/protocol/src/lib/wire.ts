/**
 * Canonical wire types of the mmstack op protocol (op-protocol RFC §3/§6). Structurally
 * identical to the L0 types in `@mmstack/primitives` — deliberately NOT imported from there,
 * so this package stays zero-dependency and never drags Angular peers onto a server. The
 * client package asserts mutual assignability at compile time.
 */

export type Key = string | number;

export type StoreOp =
  | { kind: 'set'; path: readonly Key[]; next: unknown; prev?: unknown }
  | { kind: 'delete'; path: readonly Key[]; prev: unknown };

/** Hybrid logical clock stamp: physical epoch ms + logical counter. */
export type Hlc = { readonly p: number; readonly l: number };

export const MESH_PROTO_VERSION = 1;

export type OpEnvelope = {
  readonly proto: number;
  readonly origin: string;
  readonly writer: string;
  readonly version: number;
  readonly hlc: Hlc;
  readonly policyVersion: number;
  readonly ops: readonly StoreOp[];
};

/** An envelope the relay has ordered: `seq` is the room-scoped total order. */
export type SeqEnvelope = OpEnvelope & { readonly seq: number };

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
};

export type ClientEnvMsg = { readonly t: 'env'; readonly room: string; readonly env: OpEnvelope };

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

export type ClientMsg = HelloMsg | ClientEnvMsg | ClientPresenceMsg | ClientSignalMsg;

/** The tri-state join answer (RFC §6), plus the current presence roster. */
export type WelcomeMsg = {
  readonly t: 'welcome';
  readonly room: string;
  readonly seq: number;
  /** Room-instance nonce: changes when a room is recreated (relay restart, DO eviction),
   *  so clients know their seq watermark belongs to a dead seq space. */
  readonly epoch: string;
  readonly peers: readonly PresenceState[];
  /** Origins currently in the room (membership ≠ presence) — the P2P bootstrap roster. */
  readonly members: readonly string[];
} & (
  | { readonly mode: 'up-to-date' }
  | { readonly mode: 'delta'; readonly envs: readonly SeqEnvelope[] }
  | { readonly mode: 'snapshot'; readonly root: unknown }
);

export type ServerEnvMsg = { readonly t: 'env'; readonly room: string; readonly env: SeqEnvelope };

export type ServerPresenceMsg = {
  readonly t: 'presence';
  readonly room: string;
  readonly peer: PresenceState;
  readonly gone?: boolean;
};

export type RejectMsg = {
  readonly t: 'reject';
  readonly room: string;
  readonly reason: 'proto' | 'policy-version' | 'unauthorized';
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

export type ServerMsg =
  | WelcomeMsg
  | ServerEnvMsg
  | ServerPresenceMsg
  | RejectMsg
  | EjectMsg
  | MemberMsg
  | ServerSignalMsg;

/**
 * Minimal pure op application for the relay's snapshot compaction — the same fold the L0
 * `applyOps` performs, owned here so the protocol package stays dependency-free.
 */
export function applyWireOps<T>(root: T, ops: readonly StoreOp[]): T {
  let next: unknown = root;
  for (const op of ops) {
    if (op.path.length === 0) {
      if (op.kind === 'set') next = op.next;
      continue;
    }
    next = applyAt(next, op.path, 0, op);
  }
  return next as T;
}

function applyAt(
  container: unknown,
  path: readonly Key[],
  idx: number,
  op: StoreOp,
): unknown {
  const seg = path[idx];
  const base: Record<Key, unknown> | unknown[] = Array.isArray(container)
    ? container.slice()
    : container !== null && typeof container === 'object'
      ? { ...container }
      : typeof seg === 'number'
        ? []
        : {};

  if (idx === path.length - 1) {
    if (op.kind === 'delete') delete (base as Record<Key, unknown>)[seg];
    else (base as Record<Key, unknown>)[seg] = op.next;
    return base;
  }

  (base as Record<Key, unknown>)[seg] = applyAt(
    (base as Record<Key, unknown>)[seg],
    path,
    idx + 1,
    op,
  );
  return base;
}
