import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import {
  type CensusError,
  type CensusMember,
  DEFAULT_PRECEDENCE,
  memberId,
  type Precedence,
} from './census';
import { createCensus } from './census-registry';

function member(
  key: string,
  state: { pending?: boolean; failed?: boolean; readiness?: boolean },
) {
  const id = memberId('precedence', key);
  const pending = signal(state.pending ?? false);
  const failure = signal<CensusError | undefined>(
    state.failed ? { id, displayName: key, message: undefined } : undefined,
  );
  const m: CensusMember = {
    id,
    displayName: key,
    readiness: state.readiness ?? true,
    paused: signal(false),
    pending,
    inFlight: pending,
    failure,
    retry: undefined,
  };
  return { m, pending, failure };
}

const fold = (precedence: Precedence | undefined, ...ms: CensusMember[]) => {
  const census = createCensus(precedence ? { precedence } : {});
  for (const m of ms) census.register(m);
  return census.foldState;
};

describe('census fold precedence', () => {
  it('defaults to pending-first', () => {
    expect(DEFAULT_PRECEDENCE).toBe('pending-first');
  });

  for (const order of [undefined, 'pending-first'] as const) {
    it(`pending-first (${order ? 'explicit' : 'default'}): pending wins over a failure, error once drained`, () => {
      const a = member('a', { failed: true });
      const b = member('b', { pending: true });
      const state = fold(order, a.m, b.m);
      expect(state().kind).toBe('pending');
      b.pending.set(false);
      expect(state().kind).toBe('error');
      a.failure.set(undefined);
      expect(state().kind).toBe('idle');
    });
  }

  it('error-first: a failure wins while a readiness member is still pending', () => {
    const a = member('a', { failed: true });
    const b = member('b', { pending: true });
    const state = fold('error-first', a.m, b.m);
    expect(state().kind).toBe('error');
    a.failure.set(undefined);
    expect(state().kind).toBe('pending');
    b.pending.set(false);
    expect(state().kind).toBe('idle');
  });

  it('both orders agree when only one absorber is present', () => {
    for (const order of ['pending-first', 'error-first'] as const) {
      expect(fold(order, member('p', { pending: true }).m)().kind).toBe(
        'pending',
      );
      expect(fold(order, member('e', { failed: true }).m)().kind).toBe('error');
      expect(
        fold(order, member('n', { pending: true, readiness: false }).m)().kind,
      ).toBe('idle');
    }
  });
});
