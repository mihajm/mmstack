import { computed, signal, type Signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { memberId, type CensusError, type CensusMember } from './census';
import {
  deadlineBreachError,
  withSettlementDeadline,
} from './settlement-deadline';

function member(
  name: string,
  options: {
    pending: Signal<boolean>;
    failure?: Signal<CensusError | undefined>;
    retry?: { retry(): void };
  },
): CensusMember {
  return {
    id: memberId(name, 0),
    displayName: name,
    readiness: true,
    paused: signal(false).asReadonly(),
    pending: options.pending,
    inFlight: options.pending,
    failure:
      options.failure ??
      signal<CensusError | undefined>(undefined).asReadonly(),
    retry: options.retry,
  };
}

describe('[PROVEN boundaries] settlement deadline — the breach is an ordinary member failure', () => {
  it('unbreached, the wrapper is transparent', () => {
    const pending = signal(true);
    const wrapped = withSettlementDeadline(
      member('m', { pending }),
      signal(false),
      1000,
    );
    expect(wrapped.pending()).toBe(true);
    expect(wrapped.failure()).toBeUndefined();
    pending.set(false);
    expect(wrapped.pending()).toBe(false);
  });

  it('breached, the member leaves pending AS AN ERROR that names it', () => {
    const breached = signal(false);
    const source = member('patients', { pending: signal(true) });
    const wrapped = withSettlementDeadline(source, breached, 1000);

    breached.set(true);
    expect(wrapped.pending()).toBe(false);
    expect(wrapped.failure()?.displayName).toBe('patients');
    expect(wrapped.failure()?.id).toBe(source.id);
    expect(wrapped.failure()?.message).toBe(
      deadlineBreachError(source, 1000).message,
    );
  });

  it("the member's own failure always outranks the synthesized one", () => {
    const own: CensusError = {
      id: memberId('m', 0),
      displayName: 'm',
      message: 'the truth',
    };
    const wrapped = withSettlementDeadline(
      member('m', {
        pending: signal(true),
        failure: signal<CensusError | undefined>(own).asReadonly(),
      }),
      signal(true),
      1000,
    );
    expect(wrapped.failure()).toBe(own);
  });

  it('the synthesis is not sticky past its subject — a member that stops pending stops failing', () => {
    const pending = signal(true);
    const wrapped = withSettlementDeadline(
      member('m', { pending }),
      signal(true),
      1000,
    );
    expect(wrapped.failure()).toBeDefined();

    pending.set(false);
    expect(wrapped.failure()).toBeUndefined();
    expect(wrapped.pending()).toBe(false);
  });

  it('identity, capabilities and pause pass through untouched', () => {
    const retry = { retry: () => undefined };
    const paused = signal(true).asReadonly();
    const source: CensusMember = {
      ...member('m', { pending: signal(true), retry }),
      paused,
    };
    const wrapped = withSettlementDeadline(source, signal(true), 1000);

    expect(wrapped.id).toBe(source.id);
    expect(wrapped.displayName).toBe(source.displayName);
    expect(wrapped.readiness).toBe(source.readiness);
    expect(wrapped.retry).toBe(retry);
    expect(wrapped.paused).toBe(paused);
    expect(wrapped.inFlight()).toBe(true);
  });

  it('reads reactively — a breach that lands later is picked up without re-wrapping', () => {
    const breached = signal(false);
    const wrapped = withSettlementDeadline(
      member('m', { pending: signal(true) }),
      breached,
      1000,
    );
    const fold = computed(() =>
      wrapped.pending() ? 'pending' : wrapped.failure() ? 'error' : 'idle',
    );

    expect(fold()).toBe('pending');
    breached.set(true);
    expect(fold()).toBe('error');
  });
});
