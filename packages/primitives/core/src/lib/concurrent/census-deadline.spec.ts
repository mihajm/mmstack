import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memberId, type CensusError, type CensusMember } from './census';
import { createCensus } from './census-registry';
import { type DeadlineArm } from './settlement-deadline';

function member(name: string, pending = signal(true)) {
  const m: CensusMember = {
    id: memberId(name, 0),
    displayName: name,
    readiness: true,
    paused: signal(false).asReadonly(),
    pending,
    inFlight: pending,
    failure: signal<CensusError | undefined>(undefined).asReadonly(),
    retry: undefined,
  };
  return { m, pending };
}

function controlledArm() {
  const armed: { fire: () => void; ms: number; cancelled: boolean }[] = [];
  const arm: DeadlineArm = (fire, ms) => {
    const entry = { fire, ms, cancelled: false };
    armed.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return { arm, armed };
}

describe('settlement deadline in a census', () => {
  afterEach(() => vi.useRealTimers());

  it('a member still pending when its time runs out is declared failed', () => {
    const { arm, armed } = controlledArm();
    const census = createCensus({ deadline: { ms: 100, arm } });
    census.register(member('orders').m);
    expect(armed.map((a) => a.ms)).toEqual([100]);
    expect(census.foldState().kind).toBe('pending');

    armed[0].fire();
    expect(census.foldState().kind).toBe('error');
    expect(census.failures().map((f) => f.displayName)).toEqual(['orders']);
  });

  it('a member that settled before its time ran out is not failed when it goes pending later', () => {
    const { arm, armed } = controlledArm();
    const census = createCensus({ deadline: { ms: 100, arm } });
    const { m, pending } = member('orders');
    census.register(m);

    pending.set(false);
    armed[0].fire();
    expect(census.foldState().kind).toBe('idle');

    pending.set(true);
    expect(census.foldState().kind).toBe('pending');
    expect(census.failures()).toEqual([]);
  });

  it('a breach goes away when the member settles', () => {
    const { arm, armed } = controlledArm();
    const census = createCensus({ deadline: { ms: 100, arm } });
    const { m, pending } = member('orders');
    census.register(m);
    armed[0].fire();
    expect(census.foldState().kind).toBe('error');

    pending.set(false);
    expect(census.foldState().kind).toBe('idle');
    expect(census.failures()).toEqual([]);
  });

  it('each pending stretch gets its own time: settling clears a breach, going pending again restarts the clock', () => {
    const { arm, armed } = controlledArm();
    const census = createCensus({ deadline: { ms: 100, arm } });
    const { m, pending } = member('orders');
    census.register(m);
    armed[0].fire();
    expect(census.foldState().kind).toBe('error');

    pending.set(false);
    expect(census.foldState().kind).toBe('idle');
    expect(armed[0].cancelled).toBe(true);

    pending.set(true);
    expect(census.foldState().kind).toBe('pending');
    expect(census.failures()).toEqual([]);
    expect(armed.length).toBe(2);
    expect(armed[1].cancelled).toBe(false);

    armed[1].fire();
    expect(census.failures().map((f) => f.displayName)).toEqual(['orders']);
  });

  it('a stale clock from an earlier stretch does not breach a later one', () => {
    const { arm, armed } = controlledArm();
    const census = createCensus({ deadline: { ms: 100, arm } });
    const { m, pending } = member('orders');
    census.register(m);
    pending.set(false);
    expect(census.foldState().kind).toBe('idle');
    pending.set(true);
    expect(census.foldState().kind).toBe('pending');
    armed[0].fire();
    expect(census.foldState().kind).toBe('pending');
    armed[1].fire();
    expect(census.foldState().kind).toBe('error');
  });

  it('leaving cancels the clock of that member', () => {
    const { arm, armed } = controlledArm();
    const census = createCensus({ deadline: { ms: 100, arm } });
    const leave = census.register(member('a').m);
    census.register(member('b').m);
    leave();
    expect(armed.map((a) => a.cancelled)).toEqual([true, false]);
  });

  it('the default clock is a real timer: it fires after ms and leaving clears it', () => {
    vi.useFakeTimers();
    const census = createCensus({ deadline: { ms: 50 } });
    census.register(member('hung').m);
    const leave = census.register(member('gone').m);
    expect(vi.getTimerCount()).toBe(2);

    expect(() => leave()).not.toThrow();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(49);
    expect(census.foldState().kind).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(census.failures().map((f) => f.displayName)).toEqual(['hung']);
  });

  it('a census without a deadline arms nothing', () => {
    vi.useFakeTimers();
    const census = createCensus();
    census.register(member('m').m);
    expect(vi.getTimerCount()).toBe(0);
  });
});
