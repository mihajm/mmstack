import { Injector, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { type CensusError, type CensusMember, memberId } from './census';
import { createCensus, type DrainArm } from './census-registry';

interface Controlled {
  readonly member: CensusMember;
  readonly inFlight: WritableSignal<boolean>;
  readonly paused: WritableSignal<boolean>;
  retries: number;
  settle(): void;
}

function controlledMember(name: string): Controlled {
  const id = memberId(name, 0);
  const inFlight = signal(false);
  const paused = signal(false);
  const controls: Controlled = {
    member: {
      id,
      displayName: name,
      readiness: true,
      paused,
      pending: signal(false),
      inFlight,
      failure: signal<CensusError | undefined>(undefined),
      retry: {
        retry: () => {
          controls.retries += 1;
          inFlight.set(true);
        },
      },
    },
    inFlight,
    paused,
    retries: 0,
    settle: () => inFlight.set(false),
  };
  return controls;
}

describe('census retry — event-driven settlement over the injector effect path', () => {
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

  const makeCensus = () =>
    createCensus({ injector: TestBed.inject(Injector), arm });

  it('[WITNESS] event-driven: the confirm is armed a bounded number of times, not once per idle cycle', async () => {
    const c = makeCensus();
    const a = controlledMember('a');
    c.register(a.member);
    const round = c.retryAll();
    let done = false;
    void round.settled().then(() => (done = true));

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
    expect(done).toBe(true);
    expect(armCount).toBe(1);
  });

  it('[WITNESS] strand: an inFlight flip with no other reactive consumer drives settlement via the effect', async () => {
    const c = makeCensus();
    const a = controlledMember('a');
    c.register(a.member);
    const round = c.retryAll();
    let done = false;
    void round.settled().then(() => (done = true));

    TestBed.tick();
    expect(armCount).toBe(0);

    a.settle();
    const armsBefore = armCount;
    TestBed.tick();
    expect(armCount).toBe(armsBefore + 1);

    flushArms();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('[WITNESS] abandoned: a destroyed census never resolves a round off a confirm already queued on a custom arm', async () => {
    const injector = Injector.create({
      parent: TestBed.inject(Injector),
      providers: [],
      name: 'census-abandoned-round',
    });
    const c = createCensus({ injector, arm });
    const a = controlledMember('a');
    c.register(a.member);
    const round = c.retryAll();
    let done = false;
    void round.settled().then(() => (done = true));

    TestBed.tick();
    a.settle();
    TestBed.tick();
    expect(armCount).toBe(1);

    (injector as unknown as { destroy(): void }).destroy();
    flushArms();
    await Promise.resolve();
    expect(done).toBe(false);
  });

  it('[WITNESS] premature-quiescence: a settled instant that re-enters pending before the confirm never resolves', async () => {
    const c = makeCensus();
    const a = controlledMember('a');
    c.register(a.member);
    const round = c.retryAll();
    let done = false;
    void round.settled().then(() => (done = true));

    TestBed.tick();
    a.settle();
    TestBed.tick();

    a.inFlight.set(true);
    TestBed.tick();
    flushArms();
    await Promise.resolve();
    expect(done).toBe(false);

    a.settle();
    TestBed.tick();
    flushArms();
    await Promise.resolve();
    expect(done).toBe(true);
  });
});
