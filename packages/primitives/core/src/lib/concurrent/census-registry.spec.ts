import { signal, type WritableSignal } from '@angular/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CensusError,
  type CensusMember,
  type MemberId,
  memberId,
} from './census';
import { createCensus, type DrainArm } from './census-registry';

interface ConnectorControls {
  readonly member: CensusMember;
  readonly pending: WritableSignal<boolean>;
  readonly inFlight: WritableSignal<boolean>;
  readonly failure: WritableSignal<CensusError | undefined>;
  readonly paused: WritableSignal<boolean>;
  retries: number;
  settle(): void;
}

const err = (id: MemberId, message: string): CensusError => ({
  id,
  displayName: id,
  message,
});

function connectorMember(name: string, capable = true): ConnectorControls {
  const id = memberId(name, 0);
  const pending = signal(false);
  const inFlight = signal(false);
  const failure = signal<CensusError | undefined>(undefined);
  const paused = signal(false);
  const controls: ConnectorControls = {
    member: {
      id,
      displayName: name,
      readiness: true,
      paused,
      pending,
      inFlight,
      failure,
      retry: capable
        ? {
            retry: () => {
              controls.retries += 1;
              inFlight.set(true);
            },
          }
        : undefined,
    },
    pending,
    inFlight,
    failure,
    paused,
    retries: 0,
    settle: () => {
      inFlight.set(false);
      pending.set(false);
    },
  };
  return controls;
}

describe('census registry — folds over live references (real impl)', () => {
  it('joinAbsorbers: any pending readiness member ⇒ foldState is pending, even with an errored member', () => {
    const c = createCensus();
    const a = connectorMember('a');
    const b = connectorMember('b');
    c.register(a.member);
    c.register(b.member);

    a.pending.set(true);
    b.failure.set(err(b.member.id, 'boom'));
    expect(c.foldState()).toEqual({ kind: 'pending' });

    a.pending.set(false);
    expect(c.foldState()).toEqual({
      kind: 'error',
      failures: [err(b.member.id, 'boom')],
    });
  });

  it('paused-filter: a paused member exits BOTH folds', () => {
    const c = createCensus();
    const a = connectorMember('a');
    const b = connectorMember('b');
    c.register(a.member);
    c.register(b.member);

    a.paused.set(true);
    a.pending.set(true);
    b.failure.set(err(b.member.id, 'boom'));
    expect(c.foldState()).toEqual({
      kind: 'error',
      failures: [err(b.member.id, 'boom')],
    });

    b.paused.set(true);
    expect(c.foldState()).toEqual({ kind: 'idle' });
    expect(c.failures()).toEqual([]);
  });

  it('complete-census-at-quiescence: staggered failures present as pending until quiescent, then ALL', () => {
    const c = createCensus();
    const a = connectorMember('a');
    const b = connectorMember('b');
    const d = connectorMember('d');
    [a, b, d].forEach((m) => c.register(m.member));
    [a, b, d].forEach((m) => m.pending.set(true));

    b.pending.set(false);
    b.failure.set(err(b.member.id, 'B'));
    expect(c.foldState()).toEqual({ kind: 'pending' });

    d.pending.set(false);
    d.failure.set(err(d.member.id, 'D'));
    expect(c.foldState()).toEqual({ kind: 'pending' });

    a.pending.set(false);
    expect(c.foldState()).toEqual({
      kind: 'error',
      failures: [err(b.member.id, 'B'), err(d.member.id, 'D')],
    });
  });

  it('references-not-copies: mutating a live member surface is reflected with no re-registration', () => {
    const c = createCensus();
    const a = connectorMember('a');
    c.register(a.member);
    expect(c.foldState()).toEqual({ kind: 'idle' });
    a.failure.set(err(a.member.id, 'late'));
    expect(c.foldState()).toEqual({
      kind: 'error',
      failures: [err(a.member.id, 'late')],
    });
  });

  it('errored pairs each failure with its LIVE member; paused members excluded', () => {
    const c = createCensus();
    const a = connectorMember('a');
    const b = connectorMember('b');
    const healthy = connectorMember('h');
    [a, b, healthy].forEach((m) => c.register(m.member));

    a.failure.set(err(a.member.id, 'A'));
    b.failure.set(err(b.member.id, 'B'));
    const entries = c.errored();
    expect(entries.length).toBe(2);
    expect(entries[0].member).toBe(a.member);
    expect(entries[0].failure).toEqual(err(a.member.id, 'A'));
    expect(entries[1].member).toBe(b.member);
    expect(entries[1].failure).toEqual(err(b.member.id, 'B'));

    a.paused.set(true);
    expect(c.errored().length).toBe(1);
    expect(c.errored()[0].member).toBe(b.member);
  });

  it('registration is the ONLY entry path: deregister removes; an un-registered member never appears', () => {
    const c = createCensus();
    const a = connectorMember('a');
    const b = connectorMember('b');
    const deregister = c.register(a.member);
    a.failure.set(err(a.member.id, 'A'));
    b.failure.set(err(b.member.id, 'B'));
    expect(c.failures()).toEqual([err(a.member.id, 'A')]);
    deregister();
    expect(c.foldState()).toEqual({ kind: 'idle' });
    expect(c.snapshot()).toEqual([]);
  });
});

describe('census registry — story enrollment reducer (real impl)', () => {
  it('skip-precedence: error → retry → skip stays censused as the original failure', () => {
    const c = createCensus();
    const id = memberId('story', 0);
    const s = c.enroll({
      id,
      displayName: 'story',
      retry: { retry: () => undefined },
    });
    s.started(1);
    s.settled(1, { kind: 'error', error: err(id, 'boom') });
    expect(c.failures()).toEqual([err(id, 'boom')]);

    s.started(2);
    expect(s.member.failure()).toEqual(err(id, 'boom'));
    expect(c.foldState()).toEqual({
      kind: 'error',
      failures: [err(id, 'boom')],
    });

    s.settled(2, { kind: 'skipped' });
    expect(c.failures()).toEqual([err(id, 'boom')]);
  });

  it('a successful retry clears the census entry by derivation (no imperative clear)', () => {
    const c = createCensus();
    const id = memberId('story', 0);
    const s = c.enroll({
      id,
      displayName: 'story',
      retry: { retry: () => undefined },
    });
    s.started(1);
    s.settled(1, { kind: 'error', error: err(id, 'boom') });
    s.started(2);
    s.settled(2, { kind: 'ok' });
    expect(c.failures()).toEqual([]);
    expect(c.foldState()).toEqual({ kind: 'idle' });
  });

  it('generation: a stale completion for a superseded invocation never settles the facade', () => {
    const c = createCensus();
    const id = memberId('story', 0);
    const s = c.enroll({
      id,
      displayName: 'story',
      retry: { retry: () => undefined },
    });
    s.started(1);
    s.started(2);
    s.settled(1, { kind: 'ok' });
    expect(s.member.failure()).toBeUndefined();
    expect(c.foldState()).toEqual({ kind: 'idle' });
  });

  it('deregister removes the enrolled story from the census', () => {
    const c = createCensus();
    const id = memberId('story', 0);
    const s = c.enroll({
      id,
      displayName: 'story',
      retry: { retry: () => undefined },
    });
    s.started(1);
    s.settled(1, { kind: 'error', error: err(id, 'boom') });
    expect(c.failures().length).toBe(1);
    s.deregister();
    expect(c.snapshot()).toEqual([]);
    expect(c.foldState()).toEqual({ kind: 'idle' });
  });

  it('a paused story exits the error fold and rejoins on resume', () => {
    const c = createCensus();
    const id = memberId('story', 0);
    const paused = signal(false);
    const s = c.enroll({
      id,
      displayName: 'story',
      retry: { retry: () => undefined },
      paused,
    });
    s.started(1);
    s.settled(1, { kind: 'error', error: err(id, 'boom') });
    expect(c.foldState().kind).toBe('error');

    paused.set(true);
    expect(c.foldState()).toEqual({ kind: 'idle' });
    expect(c.failures()).toEqual([]);

    paused.set(false);
    expect(c.foldState().kind).toBe('error');
  });
});

describe('census registry — retry rounds over a controlled drain (real impl)', () => {
  const withDrain = () => {
    const drains: Array<() => void> = [];
    const arm: DrainArm = (check) => drains.push(check);
    const flush = () => drains.splice(0).forEach((c) => c());
    return { arm, flush };
  };

  it('atomic no-op claim: a member already in flight is never re-fired', () => {
    const { arm } = withDrain();
    const c = createCensus({ arm });
    const a = connectorMember('a');
    a.inFlight.set(true);
    const b = connectorMember('b');
    c.register(a.member);
    c.register(b.member);
    c.retryAll();
    expect(a.retries).toBe(0);
    expect(b.retries).toBe(1);
  });

  it('retryAll-parallel: every capable, non-in-flight member claimed in ONE frame; message-only excluded', () => {
    const { arm } = withDrain();
    const c = createCensus({ arm });
    const a = connectorMember('a');
    const b = connectorMember('b');
    const m = connectorMember('m', false);
    [a, b, m].forEach((x) => c.register(x.member));
    c.retryAll();
    expect([a.retries, b.retries, m.retries]).toEqual([1, 1, 0]);
    expect([a.inFlight(), b.inFlight()]).toEqual([true, true]);
  });

  it('round settles only at drained quiescence — never at a premature partial', async () => {
    const { arm, flush } = withDrain();
    const c = createCensus({ arm });
    const a = connectorMember('a');
    const b = connectorMember('b');
    [a, b].forEach((x) => c.register(x.member));
    const round = c.retryAll();
    let done = false;
    void round.settled().then(() => (done = true));

    flush();
    await Promise.resolve();
    expect(done).toBe(false);
    a.settle();
    flush();
    await Promise.resolve();
    expect(done).toBe(false);
    b.settle();
    flush();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('paused round-boundary: a paused in-flight member is excluded; the round settles on the rest', async () => {
    const { arm, flush } = withDrain();
    const c = createCensus({ arm });
    const a = connectorMember('a');
    const b = connectorMember('b');
    [a, b].forEach((x) => c.register(x.member));
    const round = c.retryAll();
    let done = false;
    void round.settled().then(() => (done = true));
    a.paused.set(true);
    b.settle();
    flush();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('retry(id) targets a single member', () => {
    const { arm } = withDrain();
    const c = createCensus({ arm });
    const a = connectorMember('a');
    const b = connectorMember('b');
    [a, b].forEach((x) => c.register(x.member));
    c.retry(a.member.id);
    expect([a.retries, b.retries]).toEqual([1, 0]);
  });
});

describe('census registry — membership static + atomic facade (real impl)', () => {
  const id = memberId('story', 0);
  const boom = err(id, 'boom');

  it('membership-static: invocations change VALUES, never the registry set', () => {
    const c = createCensus();
    const conn = connectorMember('conn');
    c.register(conn.member);
    const s = c.enroll({
      id,
      displayName: 'story',
      retry: { retry: () => undefined },
    });
    expect(c.snapshot().length).toBe(2);

    s.started(1);
    s.settled(1, { kind: 'error', error: boom });
    s.started(2);
    s.settled(2, { kind: 'ok' });
    conn.failure.set(err(conn.member.id, 'later'));
    conn.settle();
    expect(c.snapshot().length).toBe(2);
  });

  it('atomic-facade: over ANY event sequence the facade projects one consistent state (no torn intermediate)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 20 }),
        (steps) => {
          const c = createCensus();
          const s = c.enroll({
            id,
            displayName: 'story',
            retry: { retry: () => undefined },
          });
          let gen = 0;
          for (const step of steps) {
            if (step === 0) s.started(++gen);
            else if (step === 1) s.settled(gen, { kind: 'ok' });
            else if (step === 2) s.settled(gen, { kind: 'error', error: boom });
            else s.settled(gen, { kind: 'skipped' });
            const f = s.member.failure();
            if (f !== undefined && f.id !== id) return false;
            const fold = c.foldState();
            const foldHasError = fold.kind === 'error';
            if ((f !== undefined) !== foldHasError) return false;
          }
          return true;
        },
      ),
    );
  });
});
