import { computed, type Signal } from '@angular/core';
import { type CensusError, type CensusMember } from './census';

/**
 * The clock seam for a settlement deadline: arm a callback, get its cancel back. Real timers in
 * production, a controlled clock in the laws, so every module that proves a law stays clock-free.
 */
export type DeadlineArm = (fire: () => void, afterMs: number) => () => void;

export const realDeadlineArm: DeadlineArm = (fire, afterMs) => {
  const handle = setTimeout(fire, afterMs);
  return () => clearTimeout(handle);
};

/** The one knob's shape where the census consumes it: a budget plus the clock that counts it down. */
export interface SettlementDeadline {
  readonly ms: number;
  readonly arm?: DeadlineArm;
}

/**
 * The failure a breached settlement deadline synthesizes. It names the member, because the whole
 * point of the backstop is that whoever reads the diagnostic learns WHICH resource hung.
 */
export function deadlineBreachError(
  member: CensusMember,
  deadlineMs: number,
): CensusError {
  return {
    id: member.id,
    displayName: member.displayName,
    message:
      `${member.displayName} did not settle within ${deadlineMs}ms — the settlement backstop ` +
      `declared it failed so the view could proceed. Something upstream of it never answers.`,
  };
}

/**
 * Projects a member so a breached deadline leaves the pending fold through the front door: while
 * breached, `pending` reads false and `failure` synthesizes {@link deadlineBreachError}. Not sticky
 * past its subject, and a member's own failure always outranks it.
 */
export function withSettlementDeadline(
  member: CensusMember,
  breached: Signal<boolean>,
  deadlineMs: number,
): CensusMember {
  return {
    id: member.id,
    displayName: member.displayName,
    readiness: member.readiness,
    paused: member.paused,
    pending: computed(() => (breached() ? false : member.pending())),
    inFlight: member.inFlight,
    failure: computed(() => {
      const own = member.failure();
      if (own !== undefined) return own;
      return breached() && member.pending()
        ? deadlineBreachError(member, deadlineMs)
        : undefined;
    }),
    retry: member.retry,
    ...(member.source === undefined ? {} : { source: member.source }),
    ...(member.content === undefined ? {} : { content: member.content }),
  };
}
