import {
  afterNextRender,
  computed,
  DestroyRef,
  effect,
  type Injector,
  signal,
  untracked,
} from '@angular/core';
import { deliverContained } from './contain';
import {
  type CensusError,
  type CensusMember,
  type CensusRegistry,
  type EnrolledFacade,
  type ErroredEntry,
  type FacadeState,
  type FoldState,
  type MemberId,
  type RetryRound,
  type SettleOutcome,
  type FacadeDescriptor,
  type Precedence,
  DEFAULT_PRECEDENCE,
} from './census';
import {
  realDeadlineArm,
  withSettlementDeadline,
  type SettlementDeadline,
} from './settlement-deadline';

/**
 * The drained re-check hook: run `check` after the reactive graph has flushed (the production
 * hook is afterNextRender-class). Injectable so the round laws are witnessed with a controlled drain.
 */
export type DrainArm = (check: () => void) => void;

export interface CensusOptions {
  readonly injector?: Injector;
  readonly arm?: DrainArm;
  /**
   * The settlement backstop, when this census carries one. Each READINESS member gets its own
   * budget, counted from ITS OWN enrolment: a window-relative deadline would silently extend a late
   * enrollee's, which is the opposite of what a backstop is for. Absent by default; a census without
   * one has no liveness of its own and relies entirely on its members settling.
   *
   * Non-readiness members (enrolled facades, indicator-only members) are deliberately NOT armed:
   * they never enter the pending fold, so they cannot hold anything, and a deadline that fired for
   * one would invent a failure nobody was waiting on.
   */
  readonly deadline?: SettlementDeadline;
  /** Fold order when members are pending and failing at once. Defaults to pending-first. */
  readonly precedence?: Precedence;
}

const facadeFailure = (s: FacadeState): CensusError | undefined =>
  s.kind === 'error' ? s.error : s.kind === 'running' ? s.prior : undefined;

export function reduceFacade(
  state: FacadeState,
  event:
    | { t: 'start'; generation: number }
    | { t: 'settle'; generation: number; outcome: SettleOutcome },
  highestGeneration: number,
): [FacadeState, number] {
  if (event.t === 'start') {
    if (event.generation <= highestGeneration)
      return [state, highestGeneration];
    return [
      {
        kind: 'running',
        generation: event.generation,
        prior: facadeFailure(state),
      },
      event.generation,
    ];
  }
  if (state.kind !== 'running' || event.generation !== state.generation)
    return [state, highestGeneration];
  switch (event.outcome.kind) {
    case 'ok':
      return [{ kind: 'ok', generation: event.generation }, highestGeneration];
    case 'error':
      return [
        {
          kind: 'error',
          generation: event.generation,
          error: event.outcome.error,
        },
        highestGeneration,
      ];
    case 'skipped':
      return state.prior !== undefined
        ? [
            { kind: 'error', generation: event.generation, error: state.prior },
            highestGeneration,
          ]
        : [
            { kind: 'skipped', generation: event.generation },
            highestGeneration,
          ];
  }
}

const NEVER_PAUSED = signal(false).asReadonly();

/** One member per `source`: the first readiness member registered for it, else the first. */
function oneIncidentPerSource(
  list: readonly CensusMember[],
): readonly CensusMember[] {
  let chosen: Map<object, CensusMember> | undefined;
  for (const m of list) {
    if (m.source === undefined) continue;
    chosen ??= new Map();
    const current = chosen.get(m.source);
    if (!current || (!current.readiness && m.readiness))
      chosen.set(m.source, m);
  }
  if (chosen === undefined) return list;
  const pick = chosen;
  return list.filter((m) => m.source === undefined || pick.get(m.source) === m);
}

function settleRound(
  invoked: ReadonlyMap<CensusMember, number>,
  roundSettled: () => boolean,
  arm: DrainArm,
  injector: Injector | undefined,
): Promise<void> {
  if (injector === undefined) {
    return new Promise<void>((resolve) => {
      const check = () => (roundSettled() ? resolve() : arm(check));
      arm(check);
    });
  }
  return new Promise<void>((resolve) => {
    let confirmPending = false;
    let abandoned = false;
    const releaseDestroy = injector.get(DestroyRef).onDestroy(() => {
      abandoned = true;
    });
    const ref = effect(
      () => {
        for (const [member] of invoked) {
          member.inFlight();
          member.paused();
        }
        if (confirmPending || !roundSettled()) return;
        confirmPending = true;
        arm(() => {
          if (abandoned) return;
          if (!roundSettled()) {
            confirmPending = false;
            return;
          }
          releaseDestroy();
          ref.destroy();
          resolve();
        });
      },
      { injector },
    );
  });
}

export function createCensus(options: CensusOptions = {}): CensusRegistry {
  const members = signal<readonly CensusMember[]>([]);
  const invocationGeneration = new WeakMap<CensusMember, number>();
  const arm: DrainArm =
    options.arm ??
    ((check) =>
      afterNextRender(
        check,
        options.injector ? { injector: options.injector } : undefined,
      ));

  const admit = (
    member: CensusMember,
  ): { readonly member: CensusMember; readonly cancel: () => void } => {
    const deadline = options.deadline;
    if (deadline === undefined || !member.readiness)
      return { member, cancel: () => undefined };
    const breached = signal(false);
    const cancel = (deadline.arm ?? realDeadlineArm)(
      () => breached.set(true),
      deadline.ms,
    );
    return {
      member: withSettlementDeadline(
        member,
        breached.asReadonly(),
        deadline.ms,
      ),
      cancel,
    };
  };

  const attach = (member: CensusMember, cancel: () => void): (() => void) => {
    members.update((list) => [...list, member]);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      cancel();
      members.update((list) => list.filter((m) => m !== member));
    };
  };

  const register = (member: CensusMember): (() => void) => {
    const admitted = admit(member);
    return attach(admitted.member, admitted.cancel);
  };

  const enroll = (descriptor: FacadeDescriptor): EnrolledFacade => {
    const state = signal<FacadeState>({ kind: 'idle' });
    let highest = 0;
    const member: CensusMember = {
      id: descriptor.id,
      displayName: descriptor.displayName,
      readiness: false,
      paused: descriptor.paused ?? NEVER_PAUSED,
      pending: computed(() => false),
      inFlight: computed(() => state().kind === 'running'),
      failure: computed(() => facadeFailure(state())),
      retry: descriptor.retry,
    };
    const admitted = admit(member);
    const deregister = attach(admitted.member, admitted.cancel);
    const apply = (
      event:
        | { t: 'start'; generation: number }
        | { t: 'settle'; generation: number; outcome: SettleOutcome },
    ) => {
      const [next, hi] = reduceFacade(state(), event, highest);
      highest = hi;
      state.set(next);
    };
    return {
      member: admitted.member,
      started: (generation) => apply({ t: 'start', generation }),
      settled: (generation, outcome) =>
        apply({ t: 'settle', generation, outcome }),
      deregister,
    };
  };

  const visible = computed(() =>
    oneIncidentPerSource(members().filter((m) => !m.paused())),
  );

  const errorFirst =
    (options.precedence ?? DEFAULT_PRECEDENCE) === 'error-first';

  const foldState = computed<FoldState>(() => {
    const live = visible();
    const anyPending = () => live.some((m) => m.readiness && m.pending());
    if (!errorFirst && anyPending()) return { kind: 'pending' };
    const failed = live
      .map((m) => m.failure())
      .filter((f): f is CensusError => f !== undefined);
    if (failed.length) return { kind: 'error', failures: failed };
    return errorFirst && anyPending() ? { kind: 'pending' } : { kind: 'idle' };
  });

  const inFlight = computed(() =>
    visible().some((m) => m.readiness && m.inFlight()),
  );

  const failures = computed<readonly CensusError[]>(() =>
    visible()
      .map((m) => m.failure())
      .filter((f): f is CensusError => f !== undefined),
  );

  const errored = computed<readonly ErroredEntry[]>(() => {
    const entries: ErroredEntry[] = [];
    for (const member of visible()) {
      const failure = member.failure();
      if (failure !== undefined) entries.push({ member, failure });
    }
    return entries;
  });

  const claim = (m: CensusMember): number | undefined => {
    const capability = m.retry;
    if (!capability || untracked(m.inFlight)) return undefined;
    let dispatched = false;
    deliverContained(() => {
      capability.retry();
      dispatched = true;
    }, m);
    if (!dispatched) return undefined;
    const generation = (invocationGeneration.get(m) ?? 0) + 1;
    invocationGeneration.set(m, generation);
    return generation;
  };

  let roundCounter = 0;
  const runRound = (targets: readonly CensusMember[]): RetryRound => {
    const invoked = new Map<CensusMember, number>();
    for (const m of targets) {
      const claimed = claim(m);
      if (claimed !== undefined) invoked.set(m, claimed);
    }
    const generation = ++roundCounter;
    const roundSettled = (): boolean => {
      for (const [m, at] of invoked) {
        if (untracked(m.paused)) continue; // paused excluded from the round's quiescence
        if ((invocationGeneration.get(m) ?? 0) > at) continue; // superseded by a newer round
        if (untracked(m.inFlight)) return false; // still in flight at this round's invocation
      }
      return true;
    };
    return {
      generation,
      dispatched: invoked.size,
      settled: () => settleRound(invoked, roundSettled, arm, options.injector),
    };
  };

  return {
    register,
    enroll,
    snapshot: () => untracked(members),
    foldState,
    inFlight,
    failures,
    errored,
    retry: (id: MemberId) =>
      runRound(untracked(members).filter((m) => m.id === id)),
    retryAll: () => runRound(oneIncidentPerSource(untracked(members))),
  };
}
