import { Injector, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { type CensusError, type CensusMember, memberId } from './census';
import { createCensus, type DrainArm } from './census-registry';
import { censusSettled } from './settlement';

interface Controls {
  readonly member: CensusMember;
  readonly pending: WritableSignal<boolean>;
  readonly failure: WritableSignal<CensusError | undefined>;
  settle(): void;
  fail(message: string): void;
}

function memberDouble(name: string): Controls {
  const id = memberId(name, 0);
  const pending = signal(false);
  const failure = signal<CensusError | undefined>(undefined);
  return {
    member: {
      id,
      displayName: name,
      readiness: true,
      paused: signal(false),
      pending,
      inFlight: signal(false),
      failure,
      retry: undefined,
    },
    pending,
    failure,
    settle: () => pending.set(false),
    fail: (message) => {
      pending.set(false);
      failure.set({ id, displayName: name, message });
    },
  };
}

describe('census settlement — arm-loop (injector-less)', () => {
  let armed: Array<() => void>;
  let arm: DrainArm;
  const flushArms = () => armed.splice(0).forEach((c) => c());

  beforeEach(() => {
    armed = [];
    arm = (check) => armed.push(check);
  });

  it('[WITNESS] idle: a pending census whose members settle valid resolves idle', async () => {
    const c = createCensus({ arm });
    const a = memberDouble('a');
    c.register(a.member);
    a.pending.set(true);
    let outcome: 'idle' | 'error' | undefined;
    void censusSettled(c, { arm }).then((k) => (outcome = k));

    flushArms();
    await Promise.resolve();
    expect(outcome).toBeUndefined();

    a.settle();
    flushArms();
    await Promise.resolve();
    expect(outcome).toBe('idle');
  });

  it('[WITNESS] error: a pending census with a failed member resolves error', async () => {
    const c = createCensus({ arm });
    const a = memberDouble('a');
    const b = memberDouble('b');
    c.register(a.member);
    c.register(b.member);
    a.pending.set(true);
    b.pending.set(true);
    let outcome: 'idle' | 'error' | undefined;
    void censusSettled(c, { arm }).then((k) => (outcome = k));

    a.settle();
    b.fail('boom');
    flushArms();
    await Promise.resolve();
    expect(outcome).toBe('error');
  });

  it('[WITNESS] drained-only: an already-idle fold resolves idle after one drain, never synchronously', async () => {
    const c = createCensus({ arm });
    const a = memberDouble('a');
    c.register(a.member);
    let outcome: 'idle' | 'error' | undefined;
    void censusSettled(c, { arm }).then((k) => (outcome = k));

    await Promise.resolve();
    expect(outcome).toBeUndefined();

    expect(armed.length).toBe(1);
    flushArms();
    await Promise.resolve();
    expect(outcome).toBe('idle');
  });
});

describe('census settlement — event-driven (injector path)', () => {
  let armed: Array<() => void>;
  let armCount: number;
  let arm: DrainArm;
  const flushArms = () => armed.splice(0).forEach((c) => c());

  beforeEach(() => {
    TestBed.resetTestingModule();
    armed = [];
    armCount = 0;
    arm = (check) => {
      armCount += 1;
      armed.push(check);
    };
  });

  it('[WITNESS] event-driven: on an idle reactive graph a fold flip alone drives resolution', async () => {
    const injector = TestBed.inject(Injector);
    const c = createCensus({ injector, arm });
    const a = memberDouble('a');
    c.register(a.member);
    a.pending.set(true);
    let outcome: 'idle' | 'error' | undefined;
    void censusSettled(c, { injector, arm }).then((k) => (outcome = k));

    TestBed.tick();
    expect(armCount).toBe(0);
    for (let i = 0; i < 5; i++) {
      TestBed.tick();
      flushArms();
    }
    expect(armCount).toBe(0);

    a.settle();
    TestBed.tick();
    expect(armCount).toBe(1);
    flushArms();
    await Promise.resolve();
    expect(outcome).toBe('idle');
    expect(armCount).toBe(1);
  });

  it('[WITNESS] premature-quiescence: a non-pending instant that re-enters pending before the confirm never resolves', async () => {
    const injector = TestBed.inject(Injector);
    const c = createCensus({ injector, arm });
    const a = memberDouble('a');
    c.register(a.member);
    a.pending.set(true);
    let outcome: 'idle' | 'error' | undefined;
    void censusSettled(c, { injector, arm }).then((k) => (outcome = k));

    TestBed.tick();
    a.settle();
    TestBed.tick();

    a.pending.set(true);
    TestBed.tick();
    flushArms();
    await Promise.resolve();
    expect(outcome).toBeUndefined();

    a.settle();
    TestBed.tick();
    flushArms();
    await Promise.resolve();
    expect(outcome).toBe('idle');
  });

  it('[WITNESS] abandoned: a destroyed injector never resolves off a confirm already queued on a custom arm', async () => {
    const injector = Injector.create({
      parent: TestBed.inject(Injector),
      providers: [],
      name: 'census-settlement-abandoned',
    });
    const c = createCensus({ injector, arm });
    const a = memberDouble('a');
    c.register(a.member);
    a.pending.set(true);
    let settled = false;
    void censusSettled(c, { injector, arm }).then(() => (settled = true));

    TestBed.tick();
    a.settle();
    TestBed.tick();
    expect(armCount).toBe(1);

    (injector as unknown as { destroy(): void }).destroy();
    flushArms();
    await Promise.resolve();
    expect(settled).toBe(false);

    flushArms();
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('[WITNESS] drained-only: an already-idle fold with an injector still resolves only through a drained confirm', async () => {
    const injector = TestBed.inject(Injector);
    const c = createCensus({ injector, arm });
    const a = memberDouble('a');
    c.register(a.member);
    let outcome: 'idle' | 'error' | undefined;
    void censusSettled(c, { injector, arm }).then((k) => (outcome = k));

    TestBed.tick();
    await Promise.resolve();
    expect(outcome).toBeUndefined();

    flushArms();
    await Promise.resolve();
    expect(outcome).toBe('idle');
  });
});
