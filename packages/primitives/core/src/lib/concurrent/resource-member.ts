import { computed, signal, type Signal } from '@angular/core';
import { type CensusError, type CensusMember, type MemberId } from './census';
import type { ResourceLike } from './transition-scope';

export type ResourceMemberOptions = {
  /** The member's identity in the census. */
  readonly id: MemberId;
  /** What a boundary calls this member when it presents. */
  readonly displayName: string;
  /** Whether the resource blocks its boundary's first paint (a readiness member). */
  readonly suspends: boolean;
  /**
   * `'mutation'` projects a write: never a readiness member (whatever `suspends` says), no retry,
   * and a failure that stays presented after the request clears. Defaults to `'resource'`.
   */
  readonly kind?: 'resource' | 'mutation';
};

/**
 * What a mutation offers its member: the last failed settlement, a fresh object per failure, until
 * the next mutation starts. `@mmstack/resource`'s `mutationResource` carries it.
 */
/** A mutation-shaped ref: its last settled failure, stamped with a per-failure generation. */
type LatchedFailureSource = {
  readonly lastFailure?: Signal<
    { readonly error: unknown; readonly generation: number } | undefined
  >;
};

const NEVER_PAUSED: Signal<boolean> = signal(false).asReadonly();

/** The resource's content reading: a held value counts, so a failed reload keeps its content. */
export function resourceHasContent(ref: ResourceLike): boolean {
  return ref.hasContent?.() ?? ref.hasValue();
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string'
  )
    return (error as { message: string }).message;
  return undefined;
}

/**
 * Projects a resource onto the census member shape.
 *
 * - `pending` is the first-load reading: a suspending resource with no content that has not
 *   failed. A failed first load leaves the pending fold and presents as a failure instead of
 *   holding its boundary on the placeholder.
 * - `inFlight` is the activity reading, `isLoading()`, so a background reload is in flight while
 *   its held content keeps `pending` false.
 * - `failure` follows `status() === 'error'`; the message is the error's own when it is
 *   Error-like.
 * - `retry` is the resource's `reload`, when it has one.
 * - `paused` is constantly false: pausing a resource suppresses its requests, it does not take it
 *   out of the fold, so a paused resource with no content keeps suspending.
 */
export function resourceMember(
  ref: ResourceLike,
  { id, displayName, suspends, kind }: ResourceMemberOptions,
): CensusMember {
  if (kind === 'mutation') return mutationMember(ref, id, displayName);
  return {
    id,
    displayName,
    readiness: suspends,
    paused: NEVER_PAUSED,
    pending: computed(() => {
      if (!suspends) return false;
      // Status first and always: a content reading may be partly untracked (a facade gating on
      // untracked state), and the status edge is what re-runs it when that state moves.
      const status = ref.status();
      return status !== 'error' && !resourceHasContent(ref);
    }),
    inFlight: computed(() => ref.isLoading()),
    failure: computed<CensusError | undefined>(() =>
      ref.status() === 'error'
        ? { id, displayName, message: errorMessage(ref.error?.()) }
        : undefined,
    ),
    retry: ref.reload ? { retry: () => void ref.reload?.() } : undefined,
    source: ref,
  };
}

/**
 * A mutation as a member. It never holds first paint (`readiness` and `pending` are false),
 * `inFlight` is `isLoading()`, and it has no `retry` (a write is not assumed idempotent).
 *
 * The failure is latched when the ref carries `lastFailure`: it stays presented after the
 * mutation clears its request, until it is dismissed through the scope or the next mutation
 * starts. Each failure carries its own `generation`, so a dismissal hides only that one. A ref
 * without `lastFailure` reports `status() === 'error'` as it happens.
 */
function mutationMember(
  ref: ResourceLike,
  id: MemberId,
  displayName: string,
): CensusMember {
  const latched = (ref as LatchedFailureSource).lastFailure;
  return {
    id,
    displayName,
    readiness: false,
    paused: NEVER_PAUSED,
    pending: NEVER_PAUSED,
    inFlight: computed(() => ref.isLoading()),
    failure: computed<CensusError | undefined>(() => {
      if (latched) {
        const last = latched();
        return last === undefined
          ? undefined
          : {
              id,
              displayName,
              message: errorMessage(last.error),
              generation: last.generation,
            };
      }
      return ref.status() === 'error'
        ? { id, displayName, message: errorMessage(ref.error?.()) }
        : undefined;
    }),
    retry: undefined,
    source: ref,
  };
}
