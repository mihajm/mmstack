import {
  admits,
  createRanges,
  recordAdmission,
  type CoverContext,
  type Dot,
  type GenerationReason,
  type Hlc,
  type Key,
  type OpEnvelope,
  type Ranges,
  type Receipts,
  type RegisterStore,
  type StoreOp,
  type TailPolicy,
  type VersionRange,
} from '@mmstack/mesh-protocol';

/**
 * The client half of a room generation: the record fields a snapshot welcome carries, the admission
 * evidence the client keeps for its pre-check, and the pure decisions the session takes on them
 * (which welcome to install, what a new generation does with the pending tail, whether a replayed
 * envelope may be sent, when a member is ready for a consensus cut). Nothing here touches a socket,
 * a store or a timer, so a harness can drive the same decisions the session does.
 */

/** The immutable fields of the installed generation, as the client keeps them in its record. */
export type InstalledGeneration = {
  readonly instance: string;
  readonly index: number;
  readonly reason: GenerationReason;
  readonly policy: TailPolicy;
  readonly extent: Readonly<Record<string, Readonly<Record<string, Hlc>>>>;
  readonly preCutMax: Readonly<Record<string, Hlc>>;
  /** The seq of the snapshot welcome that installed it (or a later one of the same generation). */
  readonly seq: number;
};

/**
 * The admission evidence of the installed generation as this client knows it: the welcome's ranges,
 * settled vector and first stamps, then every envelope the client ingests (its own included).
 * A lead or lag against the relay's view only ever yields a refusal the client lands as a conflict.
 */
export type ClientAdmission = {
  readonly ranges: Map<string, Ranges>;
  readonly settled: Map<string, Hlc>;
  readonly firstStamps: Map<string, Hlc>;
};

/** The serializable form of {@link ClientAdmission}. */
export type ClientAdmissionRecord = {
  readonly ranges: Readonly<Record<string, readonly VersionRange[]>>;
  readonly settled: Readonly<Record<string, Hlc>>;
  readonly firstStamps: Readonly<Record<string, Hlc>>;
};

export const emptyAdmission = (): ClientAdmission => ({
  ranges: new Map(),
  settled: new Map(),
  firstStamps: new Map(),
});

/** The admission evidence a snapshot welcome carries, as of its seq. */
export const admissionOf = (src: ClientAdmissionRecord): ClientAdmission => ({
  ranges: new Map(Object.entries(src.ranges).map(([o, r]) => [o, createRanges(r)])),
  settled: new Map(Object.entries(src.settled)),
  firstStamps: new Map(Object.entries(src.firstStamps)),
});

export const admissionRecord = (a: ClientAdmission): ClientAdmissionRecord => ({
  ranges: Object.fromEntries([...a.ranges].map(([o, r]) => [o, r.toJSON()])),
  settled: Object.fromEntries(a.settled),
  firstStamps: Object.fromEntries(a.firstStamps),
});

/**
 * One envelope reaches this client's view (its own emission, a relay delivery, a replayed or
 * re-applied own write). A version it already holds is a duplicate, and one below its origin's
 * maximum was skipped by the relay: both are refused (`false`), nothing is recorded. Otherwise the
 * version joins the evidence exactly as the relay records it.
 */
export function admitLocal(
  a: ClientAdmission,
  env: { readonly origin: string; readonly version: number; readonly hlc: Hlc },
): boolean {
  const held = a.ranges.get(env.origin);
  if (held && (held.has(env.version) || env.version < held.max())) return false;
  recordAdmission(a, env);
  return true;
}

/** The context `admits` reads: the installed record's extent and preCutMax, the client's evidence. */
export const coverContext = (
  gen: Pick<InstalledGeneration, 'extent' | 'preCutMax'>,
  a: ClientAdmission,
): CoverContext => ({
  extent: gen.extent,
  preCutMax: gen.preCutMax,
  firstStamp: (origin) => a.firstStamps.get(origin),
  settled: (origin) => a.settled.get(origin),
});

/**
 * The replay pre-check: every cite of `env` (its own dot excepted) the installed state does not
 * cover, by the same `admits` the relay runs, over the client's register store. An envelope with
 * an uncovered cite is never sent; it is a conflict.
 */
export function uncoveredCites(
  store: RegisterStore,
  ctx: CoverContext,
  env: OpEnvelope,
): { readonly path: readonly Key[]; readonly dot: Dot }[] {
  const out: { path: readonly Key[]; dot: Dot }[] = [];
  for (const op of env.ops) {
    for (const dot of op.cites ?? []) {
      if (dot.origin === env.origin && dot.hlc.p === env.hlc.p && dot.hlc.l === env.hlc.l) continue;
      if (!admits(store, ctx, op.path, dot)) out.push({ path: op.path, dot });
    }
  }
  return out;
}

/** What the client knows of its installed generation when a snapshot welcome arrives. */
export type WelcomeFence = {
  readonly index: number;
  readonly instance: string | undefined;
  /** The seq of the installed snapshot. */
  readonly seq: number;
  /** The highest seq of a relay-delivered envelope of this generation, deduplicated or not. */
  readonly maxSeq: number;
};

/**
 * Which snapshot welcome installs. A newer generation (higher index) always does. One of the
 * installed generation does when it is not older than the installed snapshot (`stale` otherwise)
 * and not older than relay traffic already delivered (`older-than-traffic`): installing it would
 * replace that traffic with an earlier state. Anything else is stale.
 */
export function welcomeVerdict(
  installed: WelcomeFence,
  msg: { readonly index: number; readonly instance: string; readonly seq: number },
): 'newer' | 'same' | 'stale' | 'older-than-traffic' {
  if (msg.index > installed.index) return 'newer';
  if (msg.instance !== installed.instance || msg.seq < installed.seq) return 'stale';
  if (msg.seq < installed.maxSeq) return 'older-than-traffic';
  return 'same';
}

/** A pending envelope of an earlier generation, as the tail policy reads it. */
type Pending = { readonly env: Pick<OpEnvelope, 'origin' | 'instance' | 'version'> };

/**
 * A new generation's first step with the pending tail: in version order, an envelope whose version
 * the receipts of its origin hold — in ANY generation — was admitted and is never resent; the rest
 * is kept for the tail policy. Membership is instance-agnostic: a replayed envelope carries the
 * current instance, so the relay receipts it there while the tail entry still names the generation
 * it was authored in, and a crash between the wire and the record would otherwise replay it again
 * after the next cut. An origin's versions never repeat (the counter runs through replay; a restart
 * that loses it mints a new origin), so the version alone identifies the write.
 */
export function trimByReceipts<T extends Pending>(
  pending: readonly T[],
  receipts: Receipts,
): { readonly trimmed: T[]; readonly keep: T[] } {
  const sorted = [...pending].sort(
    (a, b) => a.env.version - b.env.version || (a.env.origin < b.env.origin ? -1 : 1),
  );
  // the union over every generation's ranges of the origin
  const held = (origin: string, version: number): boolean =>
    Object.values(receipts[origin] ?? {}).some((ranges) =>
      ranges.some(([from, to]) => from <= version && version <= to),
    );
  const trimmed: T[] = [];
  const keep: T[] = [];
  for (const t of sorted) {
    if (held(t.env.origin, t.env.version)) trimmed.push(t);
    else keep.push(t);
  }
  return { trimmed, keep };
}

/** A refusal was classified: a snapshot at or past its seq is owed. */
export const owedAfterRefusal = (owed: number | undefined, seq: number): number =>
  Math.max(owed ?? 0, seq);

/** A snapshot installed at `seq`: the owed rehydration completes when it reaches the refusal. */
export const owedAfterInstall = (owed: number | undefined, seq: number): number | undefined =>
  owed !== undefined && seq >= owed ? undefined : owed;

/**
 * A member's readiness for a consensus cut: it pressed Compact, it is connected, and nothing it
 * wrote is outstanding (its outbox empty, no replay running). A conflict is never outstanding: it
 * is out of the outbox the moment it is classified.
 */
export const readyValue = (s: {
  readonly pressed: boolean;
  readonly connected: boolean;
  readonly replaying: boolean;
  readonly outstanding: number;
}): boolean => s.pressed && s.connected && !s.replaying && s.outstanding === 0;

/**
 * The authored intent of an envelope: its raw op list and one bump flag, what a re-author rebuilds
 * from. The raws are the stamped ops without their expansion clears (a diffed write never emits a
 * `clear` of its own, so every `clear` is one) and without cites and epoch. The envelope bumped when
 * an op's epoch rises above the register baseline at its path as the client held it before the
 * envelope (the relay's own test for a bump).
 */
export type Intent = { readonly raws: readonly StoreOp[]; readonly bump: boolean };

export function intentOf(env: OpEnvelope, baseline: (path: readonly Key[]) => number): Intent {
  const raws: StoreOp[] = [];
  let bump = false;
  for (const op of env.ops) {
    if ((op.epoch ?? 0) > baseline(op.path)) bump = true;
    if (op.kind === 'clear') continue;
    const raw: Record<string, unknown> = { ...op };
    delete raw['cites'];
    delete raw['epoch'];
    raws.push(raw as StoreOp);
  }
  return { raws, bump };
}
