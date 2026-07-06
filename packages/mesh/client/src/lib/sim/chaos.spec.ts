import { afterEach, beforeEach, vi } from 'vitest';
import type { ClientMsg, ServerMsg } from '@mmstack/mesh-protocol';
import type { MeshTransportFactory } from '../transport';
import { chaosLink } from './chaos';
import { prng } from './prng';

/** A controllable inner transport: records outbound sends, lets a test push inbound/close. */
function mockInner() {
  let msgCb: ((m: ServerMsg) => void) | null = null;
  let closeCb: (() => void) | null = null;
  const sent: ClientMsg[] = [];
  let closed = false;
  const factory: MeshTransportFactory = () => ({
    send: (m) => sent.push(m),
    onMessage: (cb) => ((msgCb = cb), () => (msgCb = null)),
    onClose: (cb) => ((closeCb = cb), () => (closeCb = null)),
    close: () => {
      closed = true;
      closeCb?.();
    },
  });
  return {
    factory,
    sent,
    deliverFromRelay: (m: ServerMsg) => msgCb?.(m),
    innerClose: () => closeCb?.(),
    get closed() {
      return closed;
    },
  };
}

const env = (v: number): ClientMsg => ({
  t: 'env',
  room: 'r',
  env: { proto: 1, origin: 'o', writer: 'w', version: v, hlc: { p: 0, l: v }, policyVersion: 0, ops: [] },
});

describe('chaosLink — the fault injector must actually inject faults', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('delays outbound delivery by the configured latency', () => {
    const inner = mockInner();
    const link = chaosLink(inner.factory, prng(1), { minLatencyMs: 50, maxLatencyMs: 50 });
    const t = link.transport();

    t.send(env(1));
    expect(inner.sent).toHaveLength(0); // not delivered yet
    vi.advanceTimersByTime(49);
    expect(inner.sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(inner.sent).toHaveLength(1); // delivered at t=50
  });

  it('delays inbound delivery too', () => {
    const inner = mockInner();
    const link = chaosLink(inner.factory, prng(1), { minLatencyMs: 30, maxLatencyMs: 30 });
    const t = link.transport();
    const received: ServerMsg[] = [];
    t.onMessage((m) => received.push(m));

    inner.deliverFromRelay({ t: 'member', room: 'r', origin: 'x' });
    expect(received).toHaveLength(0);
    vi.advanceTimersByTime(30);
    expect(received).toHaveLength(1);
  });

  it('reorders under latency variance, and is deterministic per seed', () => {
    const run = (seed: number): number[] => {
      const inner = mockInner();
      const link = chaosLink(inner.factory, prng(seed), { minLatencyMs: 1, maxLatencyMs: 100 });
      const t = link.transport();
      for (let v = 1; v <= 12; v++) t.send(env(v));
      vi.advanceTimersByTime(200);
      return inner.sent.map((m) => (m as { env: { version: number } }).env.version);
    };
    const a = run(7);
    const b = run(7);
    expect(a).toEqual(b); // deterministic
    expect(a).toHaveLength(12); // nothing lost
    expect([...a].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // permutation
    expect(a).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // actually reordered
  });

  it('drops everything at dropRate = 1', () => {
    const inner = mockInner();
    const link = chaosLink(inner.factory, prng(1), { dropRate: 1 });
    const t = link.transport();
    for (let v = 1; v <= 10; v++) t.send(env(v));
    vi.advanceTimersByTime(1000);
    expect(inner.sent).toHaveLength(0);
  });

  it('drops roughly dropRate of traffic', () => {
    const inner = mockInner();
    const link = chaosLink(inner.factory, prng(3), { dropRate: 0.5 });
    const t = link.transport();
    for (let v = 1; v <= 1000; v++) t.send(env(v));
    vi.advanceTimersByTime(10);
    expect(inner.sent.length).toBeGreaterThan(400);
    expect(inner.sent.length).toBeLessThan(600);
  });

  it('partition cuts both directions and closes the live socket', () => {
    const inner = mockInner();
    const link = chaosLink(inner.factory, prng(1), { minLatencyMs: 5, maxLatencyMs: 5 });
    const t = link.transport();
    const received: ServerMsg[] = [];
    let closed = false;
    t.onMessage((m) => received.push(m));
    t.onClose(() => (closed = true));

    link.partition();
    expect(closed).toBe(true); // socket dropped → meshSync would reconnect
    expect(inner.closed).toBe(true);

    t.send(env(1)); // sends while cut are dropped
    inner.deliverFromRelay({ t: 'member', room: 'r', origin: 'x' });
    vi.advanceTimersByTime(1000);
    expect(inner.sent).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it('silence drops both directions WITHOUT closing the socket (the zombie fault)', () => {
    const inner = mockInner();
    const link = chaosLink(inner.factory, prng(1), { minLatencyMs: 5, maxLatencyMs: 5 });
    const t = link.transport();
    const received: ServerMsg[] = [];
    let closed = false;
    t.onMessage((m) => received.push(m));
    t.onClose(() => (closed = true));

    link.silence();
    expect(link.isSilenced()).toBe(true);
    t.send(env(1));
    inner.deliverFromRelay({ t: 'member', room: 'r', origin: 'x' });
    vi.advanceTimersByTime(100);
    expect(inner.sent).toHaveLength(0); // dropped both ways
    expect(received).toHaveLength(0);
    expect(closed).toBe(false); // but the socket is NOT closed (unlike partition)
    expect(inner.closed).toBe(false);

    link.unsilence();
    t.send(env(2));
    vi.advanceTimersByTime(5);
    expect(inner.sent).toHaveLength(1); // flows again
  });

  it('a reconnect attempt during a partition fails; after heal it establishes', () => {
    const inner = mockInner();
    const link = chaosLink(inner.factory, prng(1), { minLatencyMs: 5, maxLatencyMs: 5 });
    link.partition();

    const cut = link.transport(); // reconnect attempt while cut
    let cutClosed = false;
    cut.onClose(() => (cutClosed = true));
    vi.advanceTimersByTime(1);
    expect(cutClosed).toBe(true); // could not establish

    link.heal();
    const healed = link.transport();
    healed.send(env(1));
    vi.advanceTimersByTime(5);
    expect(inner.sent).toHaveLength(1); // flows again
  });
});
