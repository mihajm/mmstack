import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  memberId,
  ordinalOf,
  type CensusError,
  type CensusMember,
} from './census';
import { createCensus, type DrainArm } from './census-registry';

function controlled(name: string, readiness = true) {
  const inFlight = signal(false);
  const paused = signal(false);
  const c = {
    retries: 0,
    inFlight,
    paused,
    member: {
      id: memberId(name, 0),
      displayName: name,
      readiness,
      paused,
      pending: signal(false),
      inFlight,
      failure: signal<CensusError | undefined>(undefined),
      retry: {
        retry: () => {
          c.retries++;
          inFlight.set(true);
        },
      },
    } as CensusMember,
  };
  return c;
}

function facadeIn() {
  const census = createCensus();
  let retries = 0;
  const id = memberId('facade', 0);
  const f = census.enroll({
    id,
    displayName: 'facade',
    retry: { retry: () => void retries++ },
  });
  const error = (generation: number) => ({
    kind: 'error' as const,
    error: { id, displayName: 'facade', message: 'x', generation },
  });
  return { census, f, id, error, retries: () => retries };
}

describe('an enrolled facade', () => {
  it('a round skips it while it runs and re-runs it after it settled', () => {
    const { census, f, id, error } = facadeIn();
    f.started(1);
    expect(f.member.inFlight()).toBe(true);
    expect(census.retry(id).dispatched).toBe(0);
    f.settled(1, error(1));
    expect(f.member.inFlight()).toBe(false);
    expect(census.retry(id).dispatched).toBe(1);
  });

  it('a late start for an older generation is ignored', () => {
    const { f } = facadeIn();
    f.started(2);
    f.started(1);
    f.settled(2, { kind: 'ok' });
    expect(f.member.inFlight()).toBe(false);
  });

  for (const outcome of [
    { kind: 'ok' as const },
    { kind: 'skipped' as const },
  ]) {
    it(`a replayed start after a settle (${outcome.kind}) does not reopen it`, () => {
      const { census, f, id } = facadeIn();
      f.started(1);
      f.settled(1, outcome);
      f.started(1);
      expect(f.member.inFlight()).toBe(false);
      expect(census.retry(id).dispatched).toBe(1);
    });
  }

  it('a stale error settle is ignored while a newer run is in flight', () => {
    const { census, f, error } = facadeIn();
    f.started(1);
    f.started(2);
    f.settled(1, error(1));
    expect(census.failures()).toEqual([]);
    expect(f.member.inFlight()).toBe(true);
  });
});

describe('census.inFlight: the busy cue over visible readiness members', () => {
  it('follows readiness members only, and skips paused ones', () => {
    const census = createCensus();
    const a = controlled('a');
    const b = controlled('b');
    const side = controlled('side', false);
    census.register(a.member);
    census.register(b.member);
    census.register(side.member);
    expect(census.inFlight()).toBe(false);
    side.inFlight.set(true);
    expect(census.inFlight()).toBe(false);
    a.inFlight.set(true);
    expect(census.inFlight()).toBe(true);
    a.paused.set(true);
    expect(census.inFlight()).toBe(false);
  });
});

describe('retry rounds', () => {
  it('a member whose retry throws is not counted as dispatched', () => {
    const census = createCensus();
    const boom = new Error('retry threw');
    census.register({
      ...controlled('t').member,
      retry: {
        retry: () => {
          throw boom;
        },
      },
    });
    const rethrown: unknown[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((fn) => {
      try {
        fn();
      } catch (e) {
        rethrown.push(e);
      }
    });
    try {
      expect(census.retryAll().dispatched).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(rethrown).toEqual([boom]);
  });

  it('a later round on the same member takes the wait over from the earlier one', async () => {
    const armed: (() => void)[] = [];
    const arm: DrainArm = (check) => void armed.push(check);
    const flush = () => armed.splice(0).forEach((c) => c());
    const census = createCensus({ arm });
    const a = controlled('a');
    census.register(a.member);

    const r1 = census.retry(a.member.id);
    let d1 = false;
    void r1.settled().then(() => (d1 = true));
    a.inFlight.set(false);
    const r2 = census.retry(a.member.id);
    let d2 = false;
    void r2.settled().then(() => (d2 = true));
    expect(a.inFlight()).toBe(true);
    flush();
    await Promise.resolve();
    expect([d1, d2]).toEqual([true, false]);

    a.inFlight.set(false);
    flush();
    await Promise.resolve();
    expect(d2).toBe(true);
  });

  it('a round whose member is paused mid-flight resolves on the injector path', async () => {
    const armed: (() => void)[] = [];
    const arm: DrainArm = (check) => void armed.push(check);
    const census = createCensus({ injector: TestBed.inject(Injector), arm });
    const a = controlled('a');
    census.register(a.member);
    const round = census.retryAll();
    let done = false;
    void round.settled().then(() => (done = true));
    TestBed.tick();
    armed.splice(0).forEach((c) => c());
    expect(done).toBe(false);

    a.paused.set(true);
    TestBed.tick();
    armed.splice(0).forEach((c) => c());
    await Promise.resolve();
    expect(done).toBe(true);
  });
});

describe('registrations are counted', () => {
  it('the same member registered twice: each leave releases only its own registration', () => {
    const census = createCensus();
    const a = controlled('a');
    const leave1 = census.register(a.member);
    const leave2 = census.register(a.member);
    expect(census.snapshot().filter((m) => m === a.member).length).toBe(2);
    leave1();
    leave1();
    expect(census.snapshot().filter((m) => m === a.member).length).toBe(1);
    a.inFlight.set(true);
    expect(census.inFlight()).toBe(true);
    leave2();
    expect(census.snapshot()).toEqual([]);
  });
});

describe('ordinalOf', () => {
  it('is stable per object and distinct across objects', () => {
    const x = {};
    const y = {};
    expect(ordinalOf(x)).toBe(ordinalOf(x));
    expect(ordinalOf(x)).not.toBe(ordinalOf(y));
  });
});
