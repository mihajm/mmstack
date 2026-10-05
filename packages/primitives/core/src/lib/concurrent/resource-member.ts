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
  { id, displayName, suspends }: ResourceMemberOptions,
): CensusMember {
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
  };
}
