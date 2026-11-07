import { isDevMode } from '@angular/core';
import {
  checkEnvelope,
  createRegisterStore,
  MESH_DIRECT_VERSION,
  MESH_PROTO_VERSION,
  type ClientSignalMsg,
  type OpPolicy,
  type PolicyViolation,
  type PresenceState,
  type PrincipalCtx,
  type RegisterCheckpoint,
  type RegisterStore,
  type SeqEnvelope,
  type ServerDirectMsg,
  type ServerMsg,
  type WelcomeMsg,
} from '@mmstack/mesh-protocol';
import {
  createConvergingApply,
  type MergePolicyEntry,
  type OpEnvelope,
  type OpSync,
  type StoreOp,
} from '@mmstack/primitives/core';
import {
  admissionOf,
  admissionRecord,
  admitLocal,
  coverContext,
  emptyAdmission,
  intentOf,
  owedAfterInstall,
  owedAfterRefusal,
  readyValue,
  trimByReceipts,
  uncoveredCites,
  welcomeVerdict,
  type ClientAdmission,
  type ClientAdmissionRecord,
  type InstalledGeneration,
  type Intent,
} from './generation';
import type { MeshTransport, MeshTransportFactory } from './transport';

export type { Intent } from './generation';

/**
 * Why a write is a conflict: its replay into a new generation cites something the generation does
 * not hold (`'uncovered'`, never sent), or the relay refused it — a cite it does not cover
 * (`'citation'`) or an epoch raised without the authority to (`'epoch-bump'`).
 */
export type ConflictCause = 'uncovered' | 'citation' | 'epoch-bump';

/**
 * A write that will never be admitted as it stands. Its local effect is retracted (a replay that
 * failed its pre-check is never applied; a refused write is dropped by the snapshot that follows).
 * The two verbs are the whole surface: `discard()` lets it go, `reauthor()` writes its raw ops again
 * as a new write citing the current state. Neither can submit the original envelope.
 */
export type MeshConflict = {
  /** The envelope as it was authored (its values, cites and epoch). */
  readonly env: OpEnvelope;
  readonly intent: Intent;
  readonly cause: ConflictCause;
  discard(): void;
  /** Write the raw ops again as a new write; false when the shell cannot write (no `reauthor`). */
  reauthor(): boolean;
};

/** The room's compaction state, as the relay last announced it. */
export type CompactionState = {
  /** Droppable tombstones counted against the budget. */
  readonly count: number;
  /** The hard budget, 0 when the room arms none. */
  readonly budget: number;
  /** Origins of the members currently declared ready for a consensus cut. */
  readonly ready: readonly string[];
};

/** The room generation the client installed, as its snapshot welcome named it. */
export type GenerationState = Pick<InstalledGeneration, 'instance' | 'index' | 'reason' | 'policy'>;

/**
 * The session's durable half, persisted as one unit with the outbox: the fields of the generation
 * the tail was written in and its admission evidence, the intents of the pending writes, unresolved
 * conflicts and an owed snapshot. It holds NO registers and no sequence knowledge: a restart never
 * trusts stale registers — it installs nothing from disk, asks for a snapshot (hello without seq)
 * and resends its outbox first.
 */
export type SessionRecord = {
  readonly generation?: Omit<InstalledGeneration, 'seq'>;
  readonly admission?: ClientAdmissionRecord;
  readonly intents?: readonly {
    readonly origin: string;
    readonly version: number;
    readonly intent: Intent;
  }[];
  readonly conflicts?: readonly {
    readonly env: OpEnvelope;
    readonly intent: Intent;
    readonly cause: ConflictCause;
  }[];
  /** A refusal's seq: a snapshot at or past it must install before the client trusts its view. */
  readonly rehydrateOwed?: number;
};

export type MeshStatus =
  | 'connecting'
  /** Queued behind another tab that owns this key's durable outbox (`crossTab: 'queue'`). */
  | 'waiting'
  | 'live'
  | 'reconnecting'
  | 'ejected'
  | 'closed';

/** A `direct` frame as a seat or a synced store hands it over: `from` is the sender's origin. */
export type MeshDirect = {
  readonly from: string;
  readonly v: number;
  readonly data: unknown;
};

/**
 * Hands `msg` to every listener; a throwing listener never interrupts the session or the others.
 * @internal
 */
export const deliverDirect = (
  listeners: ReadonlySet<(msg: MeshDirect) => void>,
  msg: ServerDirectMsg,
): void => {
  const out: MeshDirect = { from: msg.from, v: msg.v, data: msg.data };
  for (const cb of [...listeners]) {
    try {
      cb(out);
    } catch {
      // a consumer's failure stays its own
    }
  }
};

/** One sequenced remote envelope's ops, attributed to the writer that made them. */
export type RemoteBatch = {
  /** The relay's total-order stamp for this batch. */
  readonly seq: number;
  readonly writer: string;
  readonly ops: readonly StoreOp[];
};

/**
 * Environment callbacks a session shell provides. All are optional except `onStatus`; the
 * session never touches signals, timers beyond `schedule`, storage, or the DOM itself.
 */
export type MeshSessionHooks = {
  onStatus(status: MeshStatus, reason?: string): void;
  /** The current op engine's origin, published immediately before each hello. */
  onOrigin?(origin: string): void;
  /** Relay membership, independent of presence; undefined while disconnected or before welcome. */
  onMembers?(members: readonly string[] | undefined): void;
  /**
   * A room message after the session has processed it, for consumers sharing its connection.
   * `direct` frames never pass here; they go to {@link MeshSessionHooks.onDirect} only.
   */
  onMessage?(msg: ServerMsg): void;
  /**
   * A `direct` frame addressed to this session, in the frame version this side speaks; any other
   * version is refused unread. One that arrives before the current connection's welcome is held
   * (up to 256) and handed over right after it, unless its sender leaves first.
   */
  onDirect?(msg: ServerDirectMsg): void;
  /** A welcome or envelope arrived — the shell's "last synced" moment. */
  onSynced?(): void;
  /** The presence roster changed (welcome replace, join/leave, teardown clear). */
  onPeers?(peers: ReadonlyMap<string, PresenceState>): void;
  /** A remote (non-own) envelope was ingested, in seq order. */
  onRemote?(batch: RemoteBatch): void;
  /**
   * Seq continuity broke: a snapshot welcome (or a relay instance change) established state
   * without delivering the individual envelopes in between. Any consumer deriving from the
   * `onRemote` stream must rebuild from current state at this seq; appending across a resync
   * would silently skip history.
   */
  onResync?(seq: number): void;
  /** The unacknowledged local tail changed (emit or ack) — the durable-outbox trigger. */
  onOutboxChange?(): void;
  /**
   * A local write violated the room policy. The session ejects itself immediately after —
   * the outcome the relay's own independent check would have produced one hop later. The
   * emit-side check spares the room the round trip; it is never the enforcement.
   */
  onLocalReject?(violation: PolicyViolation): void;
  /** The transport closed and a reconnect is scheduled; `code` is the close code (1009 = message too big). */
  onDisconnect?(code: number, reason: string): void;
  /**
   * Teardown is starting; fired before the unacked tail is dropped, so a shell can persist
   * it (and release any single-writer locks) while it is still intact.
   */
  onTerminal?(state: 'ejected' | 'closed', reason?: string): void;
  /**
   * The relay refused one of this session's writes: it is not in the room and never will be.
   * `'generation'` — written in a room generation that a cut with the `discard` policy closed (a
   * migration or a rollback: the reset is the intent), or in a room recreated without its
   * generation record; `'schema'` — a data shape older than the room's; `'order'` — a version
   * below this origin's admitted maximum that was never admitted (a second tab on one origin);
   * `'compacting'` — a host refused a write from a connection declared ready for the current
   * generation (the relay itself never sends it). The session drops the write locally and hydrates from a fresh snapshot; the envelope carries the
   * values, so the application can offer to write them again. Any `whenAcked` waiter rejects.
   * A write a compaction cut replays is never refused here: it is resent, or it is a conflict.
   */
  onRefused?(env: OpEnvelope, reason: 'generation' | 'schema' | 'order' | 'compacting'): void;
  /** The unresolved conflicts changed (a write classified, discarded or re-authored). */
  onConflicts?(conflicts: readonly MeshConflict[]): void;
  /** The relay announced the room's compaction state (count, budget, ready members). */
  onCompaction?(state: CompactionState): void;
  /**
   * A snapshot welcome of a NEW generation installed (a cut's welcome, or the first snapshot of
   * the session); `undefined` when the room was recreated without its record. A welcome of the
   * installed generation never fires it.
   */
  onGeneration?(generation: GenerationState | undefined): void;
};

export type MeshSessionOptions<T extends object> = {
  readonly room: string;
  readonly writer: string;
  readonly transport: MeshTransportFactory;
  /** The op engine this session feeds. The shell creates (and destroys) it. */
  readonly sync: OpSync<T>;
  readonly policies?: readonly MergePolicyEntry[];
  readonly policy?: OpPolicy;
  readonly ctx?: Omit<PrincipalCtx, 'writer'>;
  readonly policyVersion: number;
  readonly schemaVersion?: number;
  /** The room generation a restored outbox was written in; the first welcome decides whether it still holds. */
  readonly instance?: string;
  /**
   * The restored durable record (see {@link SessionRecord}), applied at `connect()` on top of the
   * restored outbox: the registers are hydrated with the pending writes re-applied over them.
   */
  readonly record?: SessionRecord;
  /**
   * Write a conflict's raw ops again (a new write citing the current state), on the shell's store;
   * with `bump`, as an authority override. Without it a conflict can only be discarded.
   */
  readonly reauthor?: (intent: Intent) => void;
  readonly reconnect?: { readonly maxDelayMs?: number };
  /** Timer seam (tests, deterministic harnesses). Defaults to global timers. */
  readonly schedule?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
  readonly hooks: MeshSessionHooks;
};

/**
 * The relay-room session protocol, shell-agnostic: hello/welcome handshakes (snapshot
 * hydrate, delta replay, fresh-room seed), own-echo acknowledgement, unacked resend,
 * the relay's per-envelope answers (`drop`), reconnect backoff, presence, eject/reject, the
 * generation fence and settled-vector garbage collection. `meshSync` wraps it for
 * Angular; `agentSeat` wraps it for injector-free environments. One implementation of the
 * wire contract — shells differ only in environment concerns.
 */
export type MeshSession = {
  /** Open the first connection. Call once, after any outbox restore has replayed. */
  connect(): void;
  status(): MeshStatus;
  /** Highest relay seq observed. With no unacked writes, local state is the pure fold of the room at this seq. */
  lastSeq(): number;
  hasUnacked(): boolean;
  /**
   * Resolves once the unacknowledged local tail is empty — the acknowledgement barrier a
   * caller awaits before treating its writes as the room's. Resolves immediately when
   * nothing is outstanding. Rejects with the terminal reason if the session ends (eject or
   * close) while entries remain: those writes never reached the room, and every later call
   * rejects the same way.
   *
   * With a relay whose adapter confirms durability before echoing, acknowledged means
   * stored; against a relay that echoes eagerly it means only "the relay has it".
   */
  whenAcked(): Promise<void>;
  /** The unacknowledged local tail (the durable-outbox payload). */
  unackedEnvs(): readonly OpEnvelope[];
  /** The room generation this session is in, once a welcome (or a restored outbox) named one. */
  instance(): string | undefined;
  peers(): ReadonlyMap<string, PresenceState>;
  setPresence(data: unknown): void;
  /** Send peer signaling over the current connection without a second hello. */
  sendSignal(msg: ClientSignalMsg): void;
  /** Send a `direct` frame to one member over the current connection; lost when there is none. */
  sendDirect(to: string, data: unknown): void;
  /** Writes that will never be admitted as they stand, each with its two verbs. */
  conflicts(): readonly MeshConflict[];
  /**
   * The member pressed (or released) Compact. While pressed, the session declares itself ready for
   * a consensus cut whenever nothing it wrote is outstanding, and re-declares on every change; a
   * reconnect and a new generation release the press. Safety never depends on it.
   */
  declareReady(pressed: boolean): void;
  /** The durable record to persist with the outbox (see {@link SessionRecord}). */
  record(): SessionRecord;
  close(): void;
};

const RECONNECT_BASE_MS = 500;
/** `direct` frames held before a welcome, per connection: the bound peer links keep for signals. */
const HELD_DIRECTS = 256;

export function meshSession<T extends object>(
  opt: MeshSessionOptions<T>,
): MeshSession {
  const { sync, hooks } = opt;
  const schedule = opt.schedule ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  let status: MeshStatus = 'connecting';
  const ownOrigins = new Set<string>([sync.origin]);
  const unacked = new Map<string, OpEnvelope>();
  const unackedKey = (env: { origin: string; version: number }): string =>
    `${env.origin} ${env.version}`;
  let lastSeq = 0;
  let instance: string | undefined = opt.instance;
  if (instance) sync.adopt(instance);
  // a snapshot was asked for (hello without seq); one hello per burst, cleared by the welcome it earns
  let rehydrating = false;

  // ─── the durable record: installed generation, its registers and evidence, intents, conflicts ───
  let gen: InstalledGeneration | undefined;
  let admission: ClientAdmission = emptyAdmission();
  // the client's register store: what `admits` reads for a replay's pre-check, fed every envelope
  // the session ingests (welcome, relay delta, own write) and collected with the relay's vector
  let cover: RegisterStore = createRegisterStore();
  // relay-sequenced ingress of the installed generation, deduplicated or not: the welcome fence
  let maxSeq = 0;
  let owed: number | undefined;
  const intents = new Map<string, Intent>();
  type Held = { env: OpEnvelope; intent: Intent; cause: ConflictCause };
  let held: Held[] = [];
  // census: the press is per connection, never persisted; `declared` mirrors what the relay holds
  let pressed = false;
  let declared: { ready: boolean; instance: string } | undefined;

  let peers: ReadonlyMap<string, PresenceState> = new Map();
  let members: readonly string[] | undefined;
  let presenceData: unknown;
  let hasPresence = false;
  let transport: MeshTransport | null = null;
  let attempts = 0;
  let reconnectTimer: unknown;
  let unsubs: (() => void)[] = [];
  let closed = false;
  let connected = false;
  // a `direct` frame waits for the welcome of its connection, as peer links hold signals
  let welcomedHere = false;
  let heldDirects: ServerDirectMsg[] = [];
  let versionWarned = false;
  let heldWarned = false;
  let ackFailure: Error | undefined;
  const ackWaiters: {
    resolve: () => void;
    reject: (cause: Error) => void;
  }[] = [];

  const releaseAckWaiters = (failure?: Error): void => {
    for (const waiter of ackWaiters.splice(0)) {
      if (failure) waiter.reject(failure);
      else waiter.resolve();
    }
  };

  const setStatus = (next: MeshStatus, reason?: string): void => {
    status = next;
    hooks.onStatus(next, reason);
  };

  const terminal = (state: 'ejected' | 'closed', reason?: string): void => {
    if (closed) return;
    closed = true;
    if (reconnectTimer !== undefined) {
      schedule.clear(reconnectTimer);
      reconnectTimer = undefined;
    }
    for (const unsub of unsubs.splice(0)) unsub();
    unsubLocal();
    hooks.onTerminal?.(state, reason); // unacked is still intact here — the persist window
    if (unacked.size > 0) {
      // these writes are not in the room and never will be on this session
      ackFailure = new Error(reason ?? state);
      releaseAckWaiters(ackFailure);
    } else {
      releaseAckWaiters();
    }
    unacked.clear();
    heldDirects = [];
    transport?.close();
    transport = null;
    peers = new Map();
    hooks.onPeers?.(peers);
    members = undefined;
    hooks.onMembers?.(members);
    setStatus(state, reason);
  };

  /** An envelope of the installed generation (or minted before any generation was known). */
  const current = (env: OpEnvelope): boolean =>
    env.instance === '' || env.instance === instance;

  const sendEnv = (env: OpEnvelope): void => {
    // an envelope minted before any generation was known adopts the one this session is in
    let out = env;
    if (env.instance === '' && instance) {
      out = { ...env, instance };
      unacked.set(unackedKey(env), out);
    }
    transport?.send({ t: 'env', room: opt.room, env: out });
  };
  const sendHello = (): void => {
    if (!transport) return;
    hooks.onOrigin?.(sync.origin);
    // an owed or requested snapshot is asked for by a hello without seq
    const want = rehydrating || owed !== undefined;
    transport?.send({
      t: 'hello',
      room: opt.room,
      origin: sync.origin,
      proto: MESH_PROTO_VERSION,
      policyVersion: opt.policyVersion,
      seq: !want && lastSeq > 0 ? lastSeq : undefined,
      schemaVersion: opt.schemaVersion,
    });
  };
  const requestSnapshot = (): void => {
    if (rehydrating || closed) return;
    rehydrating = true;
    sendHello();
  };

  /** Send the census flag when the member's readiness (or its generation) changed. */
  const declare = (): void => {
    if (!instance || !transport || !welcomedHere || closed) return;
    const ready = readyValue({
      pressed,
      connected,
      replaying: false, // a replay runs whole inside one welcome
      outstanding: unacked.size,
    });
    if (declared && declared.ready === ready && declared.instance === instance) return;
    declared = { ready, instance };
    transport.send({ t: 'compact', room: opt.room, instance, ready });
  };

  const conflicts = (): readonly MeshConflict[] =>
    held.map((h) => ({
      env: h.env,
      intent: h.intent,
      cause: h.cause,
      discard: () => settleConflict(h),
      reauthor: () => {
        if (!opt.reauthor || !held.includes(h)) return false;
        settleConflict(h);
        opt.reauthor(h.intent);
        return true;
      },
    }));
  const conflictsChanged = (): void => {
    hooks.onConflicts?.(conflicts());
    hooks.onOutboxChange?.();
  };
  const settleConflict = (h: Held): void => {
    if (!held.includes(h)) return;
    held = held.filter((x) => x !== h);
    conflictsChanged();
  };
  /** A pending write will never be admitted as it stands: out of the outbox, into the conflicts. */
  const classify = (env: OpEnvelope, cause: ConflictCause): void => {
    const key = unackedKey(env);
    const intent = intents.get(key) ?? intentOf(env, () => Number.POSITIVE_INFINITY);
    unacked.delete(key);
    intents.delete(key);
    held = [...held, { env, intent, cause }];
    releaseAckWaiters(new Error(`conflict: ${cause}`));
  };

  const ackOwn = (origin: string, version: number): void => {
    const key = unackedKey({ origin, version });
    if (!unacked.delete(key)) return;
    intents.delete(key);
    hooks.onOutboxChange?.();
    if (unacked.size === 0) releaseAckWaiters();
    declare();
  };
  const refuse = (
    env: OpEnvelope,
    reason: 'generation' | 'schema' | 'order' | 'compacting',
  ): void => {
    unacked.delete(unackedKey(env));
    intents.delete(unackedKey(env));
    hooks.onRefused?.(env, reason);
    hooks.onOutboxChange?.();
    // "every write was classified" is not "every write was stored": a waiter rejects
    releaseAckWaiters(new Error(`refused: ${reason}`));
  };

  const flushUnacked = (): void => {
    // a write of an earlier generation waits for the welcome that names the new one
    for (const env of unacked.values()) if (current(env)) sendEnv(env);
  };

  const applyRemote = (env: SeqEnvelope): void => {
    if (closed) return; // a delta welcome keeps iterating after an eject — nothing lands past it
    // a newer data shape is the room's, whatever generation carried it (a migration row belongs to
    // the generation it closes)
    if (
      opt.schemaVersion !== undefined &&
      env.schemaVersion !== undefined &&
      env.schemaVersion > opt.schemaVersion
    ) {
      terminal('ejected', 'schema');
      return;
    }
    // the generation fence: an envelope of another generation is never ingested, and teaches nothing
    if (instance !== undefined && env.instance !== instance) return;
    // sequence knowledge advances on every relay-delivered envelope, before any deduplication
    lastSeq = Math.max(lastSeq, env.seq);
    maxSeq = Math.max(maxSeq, env.seq);
    hooks.onSynced?.();
    if (ownOrigins.has(env.origin)) {
      ackOwn(env.origin, env.version);
      return;
    }
    if (!admitLocal(admission, env)) return; // a duplicate delivery applies nothing
    cover.ingest(env);
    sync.receive(env);
    hooks.onRemote?.({ seq: env.seq, writer: env.writer, ops: env.ops });
  };

  /** Hydrate the op engine from `registers` with `pending` own writes re-applied over them. */
  const hydrateWith = (
    registers: readonly RegisterCheckpoint[],
    wm: Readonly<Record<string, number>>,
    pending: readonly OpEnvelope[],
  ): void => {
    const conv = createConvergingApply({ policies: opt.policies });
    conv.load(registers);
    // own origins are left out of the watermark: exactly `pending` is re-applied, nothing else
    const theirs: Record<string, number> = {};
    for (const [o, v] of Object.entries(wm)) if (!ownOrigins.has(o)) theirs[o] = v;
    sync.hydrate(
      { root: conv.materialize() as T, registers: [...registers], wm: theirs },
      pending,
    );
  };

  /** A room recreated without its generation record (a relay restart): today's discard. */
  const forgetGeneration = (): void => {
    lastSeq = 0;
    for (const env of [...unacked.values()]) refuse(env, 'generation');
    gen = undefined;
    admission = emptyAdmission();
    cover = createRegisterStore();
    maxSeq = 0;
    owed = undefined; // its threshold belongs to the dead room's sequence
    hooks.onGeneration?.(undefined);
  };

  /**
   * Install a snapshot welcome ATOMICALLY: the registers (a cut's seed or the current registers),
   * the generation record, its admission evidence and sequence knowledge, and the pending tail.
   * A newer generation trims the tail by its receipts, then applies its policy: `discard` drops the
   * rest, `replay` resends each envelope verbatim (same dots, stamps, versions; instance swapped) in
   * version order when every cite passes the pre-check, and classifies it a conflict otherwise. Own
   * writes of the installed generation the welcome has not admitted stay applied over it.
   */
  const install = (
    msg: Extract<WelcomeMsg, { mode: 'snapshot' }>,
    newer: boolean,
  ): void => {
    const registers = msg.seed ?? msg.registers;
    const admitted = admissionOf(msg);
    const notAdmitted = (env: OpEnvelope): boolean =>
      !admitted.ranges.get(env.origin)?.has(env.version);
    const own = [...unacked.values()]
      .filter((env) => (env.instance === '' || env.instance === msg.instance) && notAdmitted(env))
      .map((env) => (env.instance === msg.instance ? env : { ...env, instance: msg.instance }));
    let keep: OpEnvelope[] = [];
    if (newer) {
      const pending = [...unacked.values()]
        .filter((env) => env.instance !== '' && env.instance !== msg.instance)
        .map((env) => ({ env }));
      const tail = trimByReceipts(pending, msg.receipts);
      for (const { env } of tail.trimmed) {
        // the receipts say it was admitted: acknowledged, never resent
        unacked.delete(unackedKey(env));
        intents.delete(unackedKey(env));
      }
      if (unacked.size === 0) releaseAckWaiters();
      if (msg.policy === 'discard') for (const { env } of tail.keep) refuse(env, 'generation');
      else keep = tail.keep.map((t) => t.env);
      pressed = false; // a new generation starts with nobody pressed
    }
    instance = msg.instance;
    sync.adopt(msg.instance); // a new generation drops the emission floors before the load
    gen = {
      instance: msg.instance,
      index: msg.index,
      reason: msg.reason,
      policy: msg.policy,
      extent: msg.extent,
      preCutMax: msg.preCutMax,
      seq: msg.seq,
    };
    admission = admitted;
    cover = createRegisterStore();
    cover.load(registers);
    for (const env of own) {
      admitLocal(admission, env);
      cover.ingest(env);
      if (env !== unacked.get(unackedKey(env))) unacked.set(unackedKey(env), env);
    }
    const replayed: OpEnvelope[] = [];
    const ctx = coverContext(gen, admission);
    for (const old of keep) {
      const env: OpEnvelope = { ...old, instance: msg.instance };
      if (uncoveredCites(cover, ctx, env).length) {
        classify(old, 'uncovered'); // never sent, never applied
        continue;
      }
      unacked.set(unackedKey(env), env);
      admitLocal(admission, env);
      cover.ingest(env);
      replayed.push(env);
    }
    hydrateWith(registers, msg.wm, [...own, ...replayed]);
    if (newer) maxSeq = 0;
    lastSeq = Math.max(msg.seq, maxSeq);
    owed = owedAfterInstall(owed, msg.seq);
    if (keep.length > replayed.length) hooks.onConflicts?.(conflicts());
    hooks.onOutboxChange?.();
    if (newer)
      hooks.onGeneration?.({
        instance: gen.instance,
        index: gen.index,
        reason: gen.reason,
        policy: gen.policy,
      });
  };

  const handle = (msg: ServerMsg): void => {
    if (msg.room !== opt.room) return;
    switch (msg.t) {
      case 'welcome': {
        const prevSeq = lastSeq;
        rehydrating = false;
        let resync = false;
        peers = new Map(msg.peers.map((p) => [p.origin, p]));
        hooks.onPeers?.(peers);
        members = [
          ...new Set(msg.members.filter((origin) => origin !== sync.origin)),
        ];
        hooks.onMembers?.(members);
        if (msg.mode === 'snapshot') {
          const fence = {
            index: gen?.index ?? -1,
            instance,
            seq: gen?.seq ?? 0,
            maxSeq,
          };
          let verdict = welcomeVerdict(fence, msg);
          // the answer to this connection's hello is the relay's current state: another instance at
          // an index not above the installed one is a room recreated without its record
          if (verdict === 'stale' && !welcomedHere && msg.instance !== instance) {
            forgetGeneration();
            verdict = 'newer';
          }
          if (verdict === 'newer' || verdict === 'same') {
            install(msg, verdict === 'newer');
            resync = true;
          } else if (owed !== undefined) {
            // a rejected snapshot while one is owed is asked for again
            requestSnapshot();
          }
        } else {
          if (instance !== undefined && msg.instance !== instance) {
            // a room recreated without its generation record: the tail written in the old one is
            // refused loudly and the new room's state replaces it
            forgetGeneration();
            resync = true;
          }
          instance = msg.instance;
          sync.adopt(msg.instance);
          if (msg.mode === 'delta') {
            for (const env of msg.envs) applyRemote(env);
          } else if (msg.seq === 0 && lastSeq === 0) {
            sync.seed();
          }
        }
        // every branch can end terminal (schema eject in a delta env, a seed or rebase
        // emission tripping the emit-side policy) — never revive to live
        if (closed) {
          if (resync && lastSeq === 0) lastSeq = prevSeq;
          return;
        }
        if (msg.mode !== 'snapshot') lastSeq = Math.max(lastSeq, msg.seq);
        attempts = 0;
        hooks.onSynced?.();
        if (resync) hooks.onResync?.(lastSeq);
        setStatus('live');
        flushUnacked();
        if (hasPresence)
          transport?.send({
            t: 'presence',
            room: opt.room,
            data: presenceData,
          });
        welcomedHere = true;
        // the relay resets every declaration at a join and at a cut
        declared = instance ? { ready: false, instance } : undefined;
        declare();
        if (owed !== undefined) requestSnapshot(); // keep asking until one at or past it installs
        const replay = heldDirects;
        heldDirects = [];
        for (const held of replay) {
          if (closed) return;
          hooks.onDirect?.(held);
        }
        return;
      }
      case 'env':
        applyRemote(msg.env);
        return;
      case 'presence': {
        const next = new Map(peers);
        if (msg.gone) next.delete(msg.peer.origin);
        else next.set(msg.peer.origin, msg.peer);
        peers = next;
        hooks.onPeers?.(peers);
        return;
      }
      case 'member': {
        // a leave discards what that origin sent before the welcome
        if (msg.gone)
          heldDirects = heldDirects.filter((h) => h.from !== msg.origin);
        if (members === undefined || msg.origin === sync.origin) return;
        members = msg.gone
          ? members.filter((origin) => origin !== msg.origin)
          : members.includes(msg.origin)
            ? members
            : [...members, msg.origin];
        hooks.onMembers?.(members);
        return;
      }
      case 'eject':
        if (msg.writer === opt.writer) terminal('ejected', msg.reason);
        return;
      case 'reject':
        terminal('ejected', msg.reason);
        return;
      case 'settled':
        sync.settle(msg.settled);
        cover.settle(msg.settled);
        return;
      case 'compaction':
        hooks.onCompaction?.({ count: msg.count, budget: msg.budget, ready: msg.ready });
        return;
      case 'drop': {
        const env = unacked.get(unackedKey(msg));
        if (!env) return; // already classified (a duplicate reply after the echo, or an old generation's)
        if (msg.reason === 'duplicate') {
          ackOwn(msg.origin, msg.version); // the room holds it: this is the acknowledgement
          return;
        }
        if (msg.reason === 'generation') {
          // the room moved to a newer generation: the write waits for its welcome and its policy
          requestSnapshot();
          return;
        }
        if (msg.reason === 'citation' || msg.reason === 'epoch-bump') {
          // a refusal is a conflict; the snapshot that drops its local effect is owed until one
          // at or past the refusal's seq installs (repeated replies find nothing left to classify)
          classify(env, msg.reason);
          owed = owedAfterRefusal(owed, msg.seq);
          conflictsChanged();
          declare();
          requestSnapshot();
          return;
        }
        refuse(env, msg.reason);
        // the refused write is still applied locally: drop and rehydrate from a fresh snapshot
        requestSnapshot();
        return;
      }
    }
  };

  const receiveDirect = (msg: ServerDirectMsg): void => {
    // a frame version this side does not speak is refused whole: nothing else of it is read
    if (msg.v !== MESH_DIRECT_VERSION) {
      if (isDevMode() && !versionWarned) {
        versionWarned = true;
        console.warn(
          `[@mmstack/mesh] dropped a direct frame of version ${String(msg.v)}; this side speaks ${MESH_DIRECT_VERSION}`,
        );
      }
      return;
    }
    if (welcomedHere) hooks.onDirect?.(msg);
    else if (heldDirects.length < HELD_DIRECTS) heldDirects.push(msg);
    else if (isDevMode() && !heldWarned) {
      heldWarned = true;
      console.warn(
        `[@mmstack/mesh] more than ${HELD_DIRECTS} direct frames arrived before the welcome; the rest are dropped`,
      );
    }
  };

  /** The restored record, applied once on top of the restored outbox: nothing of it is installed. */
  let restoreRecord = (): void => {
    restoreRecord = () => undefined;
    const rec = opt.record;
    if (!rec) return;
    owed = rec.rehydrateOwed;
    held = (rec.conflicts ?? []).map((c) => ({ ...c }));
    for (const x of rec.intents ?? []) {
      const key = unackedKey(x);
      if (unacked.has(key)) intents.set(key, x.intent);
    }
    if (held.length) hooks.onConflicts?.(conflicts());
    // the generation the tail was written in classifies it at the next welcome; no seq is known, so
    // any snapshot of that generation (or a newer one) installs
    if (!rec.generation || rec.generation.instance !== instance) return;
    gen = { ...rec.generation, seq: 0 };
    admission = admissionOf(rec.admission ?? { ranges: {}, settled: {}, firstStamps: {} });
  };

  const connect = (): void => {
    if (closed) return;
    restoreRecord();
    for (const unsub of unsubs.splice(0)) unsub();
    const t = opt.transport();
    transport = t;
    connected = true;
    welcomedHere = false;
    heldDirects = [];
    unsubs = [
      t.onMessage((msg) => {
        if (closed || transport !== t || msg.room !== opt.room) return;
        if (msg.t === 'direct') {
          receiveDirect(msg);
          return;
        }
        handle(msg);
        if (!closed || msg.t === 'reject' || msg.t === 'eject')
          hooks.onMessage?.(msg);
      }),
      t.onClose((code, reason) => {
        if (closed || transport !== t) return;
        transport = null;
        connected = false;
        welcomedHere = false;
        pressed = false; // a reconnect is a leave and a join: the press does not carry over
        declared = undefined;
        rehydrating = false; // the next hello asks again
        heldDirects = [];
        members = undefined;
        hooks.onMembers?.(members);
        setStatus('reconnecting');
        hooks.onDisconnect?.(code, reason);
        const delay = Math.min(
          opt.reconnect?.maxDelayMs ?? 15_000,
          RECONNECT_BASE_MS * 2 ** attempts++,
        );
        reconnectTimer = schedule.set(
          () => {
            reconnectTimer = undefined;
            connect();
          },
          delay + Math.random() * 100,
        );
      }),
    ];
    sendHello();
    // a restart resends its outbox before relying on any installed state: a refusal whose conflict
    // did not persist before a crash is answered again at once
    if (instance) flushUnacked();
  };

  const unsubLocal = sync.subscribe((env, ctx) => {
    const violation = checkEnvelope(
      opt.policy,
      env,
      { ...opt.ctx, writer: opt.writer },
      opt.room,
      // the last sequence this client observed; it can only lag the relay's, so a rule that
      // keys off an empty room is at worst more permissive here than it is at the relay
      { seq: lastSeq },
    );
    if (violation) {
      // same outcome the relay's own check would produce one hop later — the emit-side
      // check is an optimization, never the enforcement
      hooks.onLocalReject?.(violation);
      terminal('ejected', violation.reason);
      return;
    }
    ownOrigins.add(env.origin); // the fresh mint, or a restored-tail origin resending verbatim
    const key = unackedKey(env);
    // the intent the engine stamped this envelope from (a restored envelope carries none: its
    // record supplies it, or it is read back from the envelope against the registers held now)
    if (!intents.has(key))
      intents.set(
        key,
        ctx?.raws
          ? { raws: ctx.raws, bump: !!ctx.bump }
          : intentOf(env, (path) => cover.maxEpoch(path)),
      );
    admitLocal(admission, env);
    cover.ingest(env);
    unacked.set(key, env);
    hooks.onOutboxChange?.();
    declare(); // the outbox filled: not ready
    if (status === 'live') sendEnv(env);
  });

  return {
    connect,
    status: () => status,
    lastSeq: () => lastSeq,
    hasUnacked: () => unacked.size > 0,
    whenAcked: () =>
      ackFailure
        ? Promise.reject(ackFailure)
        : unacked.size === 0
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
              ackWaiters.push({ resolve, reject });
            }),
    unackedEnvs: () => [...unacked.values()],
    instance: () => instance,
    peers: () => peers,
    sendSignal: (msg) => {
      if (!closed && msg.room === opt.room) transport?.send(msg);
    },
    sendDirect: (to, data) => {
      if (closed) return;
      transport?.send({
        t: 'direct',
        room: opt.room,
        to,
        v: MESH_DIRECT_VERSION,
        data,
      });
    },
    setPresence: (data) => {
      presenceData = data;
      hasPresence = true;
      if (status === 'live') {
        transport?.send({ t: 'presence', room: opt.room, data });
      }
    },
    conflicts,
    declareReady: (next) => {
      pressed = next;
      declare();
    },
    record: () => ({
      ...(gen
        ? {
            generation: {
              instance: gen.instance,
              index: gen.index,
              reason: gen.reason,
              policy: gen.policy,
              extent: gen.extent,
              preCutMax: gen.preCutMax,
            },
            admission: admissionRecord(admission),
          }
        : {}),
      intents: [...unacked.values()].map((env) => ({
        origin: env.origin,
        version: env.version,
        intent: intents.get(unackedKey(env)) ?? intentOf(env, () => Number.POSITIVE_INFINITY),
      })),
      conflicts: held.map((h) => ({ env: h.env, intent: h.intent, cause: h.cause })),
      ...(owed !== undefined ? { rehydrateOwed: owed } : {}),
    }),
    close: () => terminal('closed'),
  };
}
