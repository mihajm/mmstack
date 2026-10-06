import { type Signal } from '@angular/core';

export type MemberId = string & { readonly __memberId: unique symbol };

export function memberId(site: string, itemKey: string | number): MemberId {
  return JSON.stringify([site, itemKey]) as MemberId;
}

const ordinals = new WeakMap<object, number>();
let ordinalCounter = 0;

export function ordinalOf(target: object): number {
  let ordinal = ordinals.get(target);
  if (ordinal === undefined) {
    ordinal = ordinalCounter += 1;
    ordinals.set(target, ordinal);
  }
  return ordinal;
}

export interface CensusError {
  readonly id: MemberId;
  readonly displayName: string;
  readonly message: string | undefined;
  readonly generation?: number;
}

export interface RetryCapability {
  retry(): void;
}

export type FacadeState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly generation: number;
      readonly prior?: CensusError;
    }
  | {
      readonly kind: 'error';
      readonly generation: number;
      readonly error: CensusError;
    }
  | { readonly kind: 'ok'; readonly generation: number }
  | { readonly kind: 'skipped'; readonly generation: number };

export type SettleOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'error'; readonly error: CensusError }
  | { readonly kind: 'skipped' };

export interface CensusMember {
  readonly id: MemberId;
  readonly displayName: string;
  readonly readiness: boolean;
  readonly paused: Signal<boolean>;
  readonly pending: Signal<boolean>;
  readonly inFlight: Signal<boolean>;
  readonly failure: Signal<CensusError | undefined>;
  readonly retry: RetryCapability | undefined;
  /**
   * The resource this member reads, when it reads one. Members of one census that share a
   * `source` are one incident: the fold, `errored()` and `retryAll()` see a single member for them
   * (the first readiness member registered, else the first).
   */
  readonly source?: object;
  /**
   * Whether the member has something on screen. A failing readiness member registered directly
   * in the census counts as blank unless this says it holds content.
   */
  readonly content?: Signal<boolean>;
}

/**
 * Which state the fold reports when a readiness member is still pending and some member has
 * failed at the same time.
 * - `'pending-first'` (the default): the fold stays `pending` until every readiness member has
 *   settled, then reports `error`. Nothing with a member still loading counts as settled, so a
 *   failure is shown only once the loading drains.
 * - `'error-first'`: the fold reports `error` as soon as any member fails, even while others
 *   still load.
 */
export type Precedence = 'pending-first' | 'error-first';

export const DEFAULT_PRECEDENCE: Precedence = 'pending-first';

export type FoldState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'error'; readonly failures: readonly CensusError[] };

export interface ErroredEntry {
  readonly member: CensusMember;
  readonly failure: CensusError;
}

export interface RetryRound {
  readonly generation: number;
  /** How many members this round actually invoked, at its own snapshot of the census. */
  readonly dispatched: number;
  settled(): Promise<void>;
}

export interface FacadeDescriptor {
  readonly id: MemberId;
  readonly displayName: string;
  readonly retry: RetryCapability | undefined;
  readonly paused?: Signal<boolean>;
}

export interface EnrolledFacade {
  readonly member: CensusMember;
  started(generation: number): void;
  settled(generation: number, outcome: SettleOutcome): void;
  deregister(): void;
}

export interface CensusRegistry {
  register(member: CensusMember): () => void;
  enroll(descriptor: FacadeDescriptor): EnrolledFacade;
  snapshot(): readonly CensusMember[];
  readonly foldState: Signal<FoldState>;
  /** Whether any visible readiness member has a request in flight — the busy cue behind held content. */
  readonly inFlight: Signal<boolean>;
  readonly failures: Signal<readonly CensusError[]>;
  readonly errored: Signal<readonly ErroredEntry[]>;
  retry(id: MemberId): RetryRound;
  retryAll(): RetryRound;
}
