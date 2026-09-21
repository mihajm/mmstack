import type { ClientMsg, SeqEnvelope, ServerMsg } from '@mmstack/mesh-protocol';
import { OP_PROTO_VERSION, type OpEnvelope } from '@mmstack/primitives/core';
import { describe, expect, it } from 'vitest';
import { agentSeat } from './agent-seat';
import type { MeshTransportFactory } from './transport';

// The session's side of the relay's per-envelope answers and of the generation fence, driven
// through the injector-free seat over a scripted wire: what the relay says is pushed by hand,
// what the session sends is captured.

type Doc = { title: string; count: number };
const initial = (): Doc => ({ title: 'init', count: 0 });

function scripted() {
  const sent: ClientMsg[] = [];
  let deliver: ((m: ServerMsg) => void) | undefined;
  const factory: MeshTransportFactory = () => {
    const cbs = new Set<(m: ServerMsg) => void>();
    deliver = (m) => {
      for (const cb of [...cbs]) cb(m);
    };
    return {
      send: (m) => sent.push(m),
      onMessage: (cb) => {
        cbs.add(cb);
        return () => cbs.delete(cb);
      },
      onClose: () => () => undefined,
      close: () => undefined,
    };
  };
  return { sent, factory, push: (m: ServerMsg) => deliver?.(m) };
}

const welcome = (instance: string, seq = 0): ServerMsg => ({
  t: 'welcome',
  room: 'r',
  seq,
  instance,
  schemaVersion: 0,
  peers: [],
  members: [],
  mode: 'up-to-date',
});

const snapshotWelcome = (instance: string, seq: number, title: string): ServerMsg => ({
  t: 'welcome',
  room: 'r',
  seq,
  instance,
  schemaVersion: 0,
  peers: [],
  members: [],
  mode: 'snapshot',
  registers: [
    {
      path: [],
      siblings: [
        { kind: 'set', value: { title, count: 0 }, writer: 'seed', origin: 'seed', hlc: { p: 1, l: 0 }, epoch: 0 },
      ],
      water: {},
    },
  ],
  wm: { seed: 1 },
});

const sentEnvs = (wire: ReturnType<typeof scripted>): OpEnvelope[] =>
  wire.sent.filter((m): m is Extract<ClientMsg, { t: 'env' }> => m.t === 'env').map((m) => m.env);
const hellos = (wire: ReturnType<typeof scripted>) =>
  wire.sent.filter((m): m is Extract<ClientMsg, { t: 'hello' }> => m.t === 'hello');

describe('session: the relay answers every envelope it does not echo', () => {
  it('stamps a write with the generation the welcome named, and takes "duplicate" as the acknowledgement', async () => {
    const wire = scripted();
    const a = agentSeat<Doc>(initial(), { room: 'r', writer: 'w', transport: wire.factory });
    wire.push(snapshotWelcome('g1', 1, 'init'));
    expect(a.status()).toBe('live');
    a.setAtPath('title', 'mine');
    const [env] = sentEnvs(wire);
    expect(env.instance).toBe('g1');
    expect(a.acked()).toBe(false);
    const barrier = a.whenAcked();
    // the echo was lost; the resend after a reconnect is answered "duplicate"
    wire.push({ t: 'drop', room: 'r', origin: env.origin, version: env.version, reason: 'duplicate' });
    await expect(barrier).resolves.toBeUndefined();
    expect(a.acked()).toBe(true);
    expect(a.snapshot().title).toBe('mine');
    a.close();
  });

  it('a "generation" refusal rejects the barrier, hands the envelope out, and asks for a fresh snapshot', async () => {
    const wire = scripted();
    const refused: { env: OpEnvelope; reason: string }[] = [];
    const a = agentSeat<Doc>(initial(), {
      room: 'r',
      writer: 'w',
      transport: wire.factory,
      onRefused: (env, reason) => refused.push({ env, reason }),
    });
    wire.push(snapshotWelcome('g1', 1, 'init'));
    a.setAtPath('title', 'stale');
    const [env] = sentEnvs(wire);
    const barrier = a.whenAcked();
    const hellosBefore = hellos(wire).length;
    wire.push({ t: 'drop', room: 'r', origin: env.origin, version: env.version, reason: 'generation' });
    await expect(barrier).rejects.toThrow('refused: generation');
    expect(refused).toEqual([{ env: expect.objectContaining({ version: env.version }), reason: 'generation' }]);
    expect(refused[0].env.ops[0]).toMatchObject({ kind: 'set', path: ['title'], next: 'stale' });
    // the rehydrate: one more hello, without a sequence, so the relay answers with a snapshot
    const after = hellos(wire);
    expect(after.length).toBe(hellosBefore + 1);
    expect(after[after.length - 1].seq).toBeUndefined();
    expect(a.stableSnapshot()).toBeNull(); // the refused write is still shown until the snapshot lands
    wire.push(snapshotWelcome('g2', 5, 'theirs'));
    expect(a.snapshot().title).toBe('theirs'); // gone locally: the room never had it
    expect(a.status()).toBe('live');
    a.close();
  });

  it('a welcome naming a new generation refuses the whole unacknowledged tail and replaces the applied state', async () => {
    const wire = scripted();
    const refused: string[] = [];
    const a = agentSeat<Doc>(initial(), {
      room: 'r',
      writer: 'w',
      transport: wire.factory,
      onRefused: (_env, reason) => refused.push(reason),
    });
    wire.push(snapshotWelcome('g1', 1, 'init'));
    a.setAtPath('title', 'old-gen');
    a.setAtPath('count', 3);
    const barrier = a.whenAcked();
    expect(sentEnvs(wire).every((e) => e.instance === 'g1')).toBe(true);
    // the cut: the relay re-welcomes under a new nonce with its snapshot
    wire.push(snapshotWelcome('g2', 2, 'fresh'));
    await expect(barrier).rejects.toThrow('refused: generation');
    expect(refused).toEqual(['generation', 'generation']);
    expect(a.snapshot()).toEqual({ title: 'fresh', count: 0 });
    expect(a.acked()).toBe(true); // nothing outstanding: the old tail was classified, not lost silently
    // a write after the cut carries the new generation
    a.setAtPath('title', 'new-gen');
    const envs = sentEnvs(wire);
    expect(envs[envs.length - 1].instance).toBe('g2');
    a.close();
  });

  it('a settled notice is applied to the fold without changing the value', () => {
    const wire = scripted();
    const a = agentSeat<Doc>(initial(), { room: 'r', writer: 'w', transport: wire.factory });
    wire.push(welcome('g1'));
    const remote = (origin: string, version: number, seq: number, title: string, cites: OpEnvelope['ops'][number]['cites']): SeqEnvelope => ({
      proto: OP_PROTO_VERSION,
      instance: 'g1',
      origin,
      writer: origin,
      version,
      hlc: { p: seq * 10, l: 0 },
      policyVersion: 0,
      ops: [{ kind: 'set', path: ['title'], next: title, cites, epoch: 0 }],
      seq,
    });
    wire.push({ t: 'env', room: 'r', env: remote('pa', 1, 1, 'first', []) });
    wire.push({ t: 'env', room: 'r', env: remote('pb', 1, 2, 'second', [{ origin: 'pa', hlc: { p: 10, l: 0 } }]) });
    expect(a.snapshot().title).toBe('second');
    expect(a.sync.liveAt(['title']).map((s) => s.origin)).toEqual(['pb']);
    wire.push({ t: 'settled', room: 'r', settled: { pa: { p: 10, l: 0 }, pb: { p: 20, l: 0 } } });
    expect(a.snapshot().title).toBe('second');
    expect(a.sync.liveAt(['title']).map((s) => s.origin)).toEqual(['pb']);
    a.close();
  });
});
