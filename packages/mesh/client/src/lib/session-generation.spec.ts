import { createWatch } from '@angular/core/primitives/signals';
import {
  extentOf,
  pathKey,
  type ClientMsg,
  type Hlc,
  type RegisterCheckpoint,
  type SeqEnvelope,
  type ServerMsg,
} from '@mmstack/mesh-protocol';
import {
  createStoreContext,
  OP_PROTO_VERSION,
  opSync,
  store,
  type OpEnvelope,
  type OpLogDriver,
} from '@mmstack/primitives/core';
import { describe, expect, it } from 'vitest';
import { agentSeat } from './agent-seat';
import { intentOf, trimByReceipts, welcomeVerdict } from './generation';
import { meshSession, type MeshSession, type SessionRecord } from './session';
import type { MeshTransportFactory } from './transport';

// The client half of the generation cut, over a scripted wire: what the relay says is pushed by
// hand, what the session sends is captured. Welcomes carry the generation record (charter §12 P-1).

type Doc = { title: string; count: number };
const initial = (): Doc => ({ title: 'init', count: 0 });
const h = (p: number): Hlc => ({ p, l: 0 });

function scripted() {
  const sent: ClientMsg[] = [];
  let deliver: ((m: ServerMsg) => void) | undefined;
  let close: ((code: number, reason: string) => void) | undefined;
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
      onClose: (cb) => {
        close = cb;
        return () => undefined;
      },
      close: () => undefined,
    };
  };
  return {
    sent,
    factory,
    push: (m: ServerMsg) => deliver?.(m),
    drop: () => close?.(1006, ''),
  };
}
type Wire = ReturnType<typeof scripted>;
const sentEnvs = (wire: Wire): OpEnvelope[] =>
  wire.sent.filter((m): m is Extract<ClientMsg, { t: 'env' }> => m.t === 'env').map((m) => m.env);
const hellos = (wire: Wire) =>
  wire.sent.filter((m): m is Extract<ClientMsg, { t: 'hello' }> => m.t === 'hello');
const compacts = (wire: Wire) =>
  wire.sent.filter((m): m is Extract<ClientMsg, { t: 'compact' }> => m.t === 'compact');

const rootReg = (title: string, count = 0): RegisterCheckpoint => ({
  path: [],
  siblings: [
    {
      kind: 'set',
      value: { title, count },
      writer: 'seed',
      origin: 'seed',
      hlc: h(1),
      epoch: 0,
    },
  ],
  water: {},
});

type Gen = {
  index?: number;
  policy?: 'discard' | 'replay';
  registers?: RegisterCheckpoint[];
  preCutMax?: Record<string, Hlc>;
  receipts?: Record<string, Record<string, [number, number][]>>;
  ranges?: Record<string, [number, number][]>;
};
/** A snapshot welcome; generation index > 0 is a cut's own welcome (it carries the seed). */
const snapshot = (instance: string, seq: number, gen: Gen = {}): ServerMsg => {
  const index = gen.index ?? 0;
  const registers = gen.registers ?? [rootReg('init')];
  return {
    t: 'welcome',
    room: 'r',
    seq,
    instance,
    schemaVersion: 0,
    peers: [],
    members: [],
    mode: 'snapshot',
    ...(index > 0 ? { seed: registers } : { registers }),
    wm: {},
    index,
    reason: index === 0 ? 'genesis' : gen.policy === 'replay' ? 'compaction' : 'migration',
    policy: gen.policy ?? 'discard',
    extent: index > 0 ? extentOf(registers) : {},
    preCutMax: gen.preCutMax ?? {},
    firstStamps: {},
    receipts: gen.receipts ?? {},
    ranges: gen.ranges ?? {},
    settled: {},
  } as ServerMsg;
};
const remote = (
  origin: string,
  version: number,
  seq: number,
  path: string[],
  next: unknown,
  cites: { origin: string; hlc: Hlc }[] = [],
  instance = 'g1',
): SeqEnvelope => ({
  proto: OP_PROTO_VERSION,
  instance,
  origin,
  writer: origin,
  version,
  hlc: h(seq * 10),
  policyVersion: 0,
  ops: [{ kind: 'set', path, next, cites, epoch: 0 }],
  seq,
});

describe('session: a compaction cut replays the pending tail (D5′, D7, D9)', () => {
  it('trims by receipts (exact membership), resends the rest VERBATIM in version order, and classifies a replay whose cite the cut folded away as a conflict — never sent, never applied', () => {
    const wire = scripted();
    const a = agentSeat<Doc>(initial(), { room: 'r', writer: 'w', transport: wire.factory });
    wire.push(snapshot('g1', 1));
    wire.push({ t: 'env', room: 'r', env: remote('pa', 1, 2, ['title'], 'pa') });
    a.setAtPath('count', 3); // v1: admitted before the cut, its ack lost
    a.setAtPath('title', 'mine'); // v2: cites pa's dot at title
    a.setAtPath('count', 4); // v3: cites its own v1 at count
    const [e1, e2, e3] = sentEnvs(wire);
    expect(e2.ops[0].cites).toEqual([{ origin: 'pa', hlc: h(20) }]);
    // the cut: pb superseded pa at title before it; the seed keeps pb's and the client's v1 siblings
    const seed: RegisterCheckpoint[] = [
      rootReg('init'),
      {
        path: ['title'],
        siblings: [{ kind: 'set', value: 'pb', writer: 'pb', origin: 'pb', hlc: h(30), epoch: 0 }],
        water: {},
      },
      {
        path: ['count'],
        siblings: [
          { kind: 'set', value: 3, writer: 'w', origin: e1.origin, hlc: e1.hlc, epoch: 0 },
        ],
        water: {},
      },
    ];
    const before = sentEnvs(wire).length;
    wire.push(
      snapshot('g2', 9, {
        index: 1,
        policy: 'replay',
        registers: seed,
        preCutMax: { seed: h(1), pa: h(20), pb: h(30), [e1.origin]: e1.hlc },
        receipts: { [e1.origin]: { g1: [[1, 1]] } },
      }),
    );
    const resent = sentEnvs(wire).slice(before);
    // v1 trimmed, v2 a conflict, v3 resent as it was written: same ops, dot, version
    expect(resent).toEqual([{ ...e3, instance: 'g2' }]);
    expect(a.conflicts().map((c) => [c.env.version, c.cause])).toEqual([[2, 'uncovered']]);
    expect(a.conflicts()[0].env).toEqual(e2);
    expect(a.snapshot()).toEqual({ title: 'pb', count: 4 }); // the conflict's effect is not applied
    // the echo of the replay acknowledges it in the new generation
    a.close();
  });

  it('re-author writes the raw ops again as a NEW write citing the current state; discard lets it go', () => {
    const wire = scripted();
    const a = agentSeat<Doc>(initial(), { room: 'r', writer: 'w', transport: wire.factory });
    wire.push(snapshot('g1', 1));
    wire.push({ t: 'env', room: 'r', env: remote('pa', 1, 2, ['title'], 'pa') });
    a.setAtPath('title', 'mine');
    a.setAtPath('count', 7);
    const [e1, e2] = sentEnvs(wire);
    const seed: RegisterCheckpoint[] = [
      rootReg('init'),
      {
        path: ['title'],
        siblings: [{ kind: 'set', value: 'pb', writer: 'pb', origin: 'pb', hlc: h(30), epoch: 0 }],
        water: {},
      },
      {
        path: ['count'],
        siblings: [{ kind: 'set', value: 1, writer: 'pc', origin: 'pc', hlc: h(40), epoch: 0 }],
        water: {},
      },
    ];
    wire.push(
      snapshot('g2', 9, {
        index: 1,
        policy: 'replay',
        registers: seed,
        preCutMax: { seed: h(1), pa: h(20), pb: h(30), pc: h(40) },
      }),
    );
    // e1 cites pa (folded away): a conflict; e2 cited nothing at count (a create): resent
    expect(a.conflicts().map((c) => c.env.version)).toEqual([e1.version]);
    expect(a.snapshot()).toEqual({ title: 'pb', count: 7 });
    const before = sentEnvs(wire).length;
    expect(a.conflicts()[0].reauthor()).toBe(true);
    expect(a.conflicts()).toEqual([]);
    const [again] = sentEnvs(wire).slice(before);
    expect(again.instance).toBe('g2');
    expect(again.version).toBeGreaterThan(e2.version);
    // the authored raw op exactly (its `prev` as written), re-stamped with the CURRENT cites
    expect(again.ops).toEqual([
      {
        kind: 'set',
        path: ['title'],
        next: 'mine',
        prev: 'pa',
        cites: [{ origin: 'pb', hlc: h(30) }],
        epoch: 0,
      },
    ]);
    expect(a.snapshot().title).toBe('mine');
    a.close();
  });
});

describe('session: refusals are conflicts, and the snapshot they owe is asked for until it installs (D-b, D-b″, R16-2)', () => {
  it('a citation refusal lands as a conflict, owes a snapshot at its seq: hello without seq, re-asked after a snapshot below it, cleared at or past it; a repeated reply finds nothing to classify', async () => {
    const wire = scripted();
    const a = agentSeat<Doc>(initial(), { room: 'r', writer: 'w', transport: wire.factory });
    wire.push(snapshot('g1', 1));
    a.setAtPath('title', 'refused');
    const [env] = sentEnvs(wire);
    const barrier = a.whenAcked();
    const before = hellos(wire).length;
    const drop = (seq: number): ServerMsg => ({
      t: 'drop',
      room: 'r',
      origin: env.origin,
      version: env.version,
      reason: 'citation',
      seq,
    });
    wire.push(drop(7));
    await expect(barrier).rejects.toThrow('conflict: citation');
    expect(a.conflicts().map((c) => c.cause)).toEqual(['citation']);
    expect(hellos(wire).length).toBe(before + 1);
    expect(hellos(wire)[before].seq).toBeUndefined();
    wire.push(drop(8)); // the resend's answer, repeated: nothing left to classify
    expect(a.conflicts()).toHaveLength(1);
    expect(a.snapshot().title).toBe('refused'); // still shown until the owed snapshot lands
    wire.push(snapshot('g1', 5)); // installs (not older than anything) but below the refusal
    expect(hellos(wire).length).toBe(before + 2); // asked again
    expect(hellos(wire)[before + 1].seq).toBeUndefined();
    wire.push(snapshot('g1', 8));
    expect(a.snapshot().title).toBe('init'); // retracted
    expect(hellos(wire).length).toBe(before + 2);
    a.close();
  });

  it('an epoch-bump refusal is a conflict too; `order` and `schema` stay refusals', () => {
    const wire = scripted();
    const refused: string[] = [];
    const a = agentSeat<Doc>(initial(), {
      room: 'r',
      writer: 'w',
      transport: wire.factory,
      onRefused: (_e, reason) => refused.push(reason),
    });
    wire.push(snapshot('g1', 1));
    a.setAtPath('title', 'x');
    a.setAtPath('count', 1);
    const [e1, e2] = sentEnvs(wire);
    wire.push({
      t: 'drop',
      room: 'r',
      origin: e1.origin,
      version: e1.version,
      reason: 'epoch-bump',
      seq: 3,
    });
    wire.push({
      t: 'drop',
      room: 'r',
      origin: e2.origin,
      version: e2.version,
      reason: 'order',
      seq: 3,
    });
    expect(a.conflicts().map((c) => c.cause)).toEqual(['epoch-bump']);
    expect(refused).toEqual(['order']);
    a.close();
  });
});

describe('session: welcomes and ingress (D-d, D10, R16-3)', () => {
  it('sequence knowledge advances on a deduplicated relay echo, so an older snapshot of the generation is ignored', () => {
    const wire = scripted();
    const a = agentSeat<Doc>(initial(), { room: 'r', writer: 'w', transport: wire.factory });
    const changes: number[] = [];
    a.changes((e) => e.kind === 'change' && changes.push(e.seq));
    wire.push(snapshot('g1', 1));
    wire.push({ t: 'env', room: 'r', env: remote('pa', 1, 2, ['title'], 'pa') });
    a.setAtPath('count', 5);
    const [own] = sentEnvs(wire);
    wire.push({ t: 'env', room: 'r', env: { ...own, seq: 4 } }); // the own echo: deduplicated
    wire.push({ t: 'env', room: 'r', env: remote('pa', 1, 2, ['title'], 'pa') }); // a duplicate delivery
    expect(changes).toEqual([2]); // applied once: the duplicate reaches nothing
    expect(a.status()).toBe('live');
    wire.push(snapshot('g1', 3)); // older than the echo at 4
    expect(a.snapshot()).toEqual({ title: 'pa', count: 5 });
    wire.push(snapshot('g1', 0)); // older than the installed snapshot: stale
    expect(a.snapshot()).toEqual({ title: 'pa', count: 5 });
    a.close();
  });

  it('an envelope of another generation is fenced: never ingested, and it teaches no sequence', () => {
    const wire = scripted();
    const a = agentSeat<Doc>(initial(), { room: 'r', writer: 'w', transport: wire.factory });
    wire.push(snapshot('g1', 1));
    wire.push({ t: 'env', room: 'r', env: remote('pa', 1, 5, ['title'], 'stray', [], 'g0') });
    expect(a.snapshot().title).toBe('init');
    wire.push(snapshot('g1', 2)); // not older than anything ingested: installs
    expect(a.stableSnapshot()?.seq).toBe(2);
    a.close();
  });

  it('a stale welcome of an older generation, arriving after the newer one, is ignored', () => {
    const wire = scripted();
    const a = agentSeat<Doc>(initial(), { room: 'r', writer: 'w', transport: wire.factory });
    wire.push(snapshot('g1', 1));
    wire.push(snapshot('g2', 4, { index: 1, policy: 'replay', registers: [rootReg('two')] }));
    wire.push(snapshot('g1', 6, { registers: [rootReg('one')] }));
    expect(a.snapshot().title).toBe('two');
    a.setAtPath('count', 1);
    expect(sentEnvs(wire).at(-1)?.instance).toBe('g2');
    a.close();
  });
});

// a session driven directly (the census verbs and the durable record live below the seats)
const microtaskDriver = (): OpLogDriver => (run) => {
  let scheduled = false;
  const watch = createWatch(
    () => run(),
    (w) => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        w.run();
      });
    },
    false,
  );
  watch.notify();
  return { destroy: () => watch.destroy() };
};
function direct(wire: Wire, extra: { instance?: string; record?: SessionRecord } = {}) {
  const doc = store<Doc>(initial(), createStoreContext());
  const sync = opSync(doc as never, { writer: 'w', driver: microtaskDriver() });
  const session: MeshSession = meshSession({
    room: 'r',
    writer: 'w',
    transport: wire.factory,
    sync,
    policyVersion: 0,
    ...extra,
    hooks: { onStatus: () => undefined },
  });
  const write = (fn: (d: Doc) => Doc): void => {
    doc.set(fn(doc()));
    sync.flush();
  };
  return { doc, sync, session, write };
}

describe('session: census readiness is client-declared (R16-5)', () => {
  it('declares ready while pressed with nothing outstanding, re-declares on every change, bound to the generation; a reconnect and a new generation release the press', () => {
    const wire = scripted();
    const { session, write } = direct(wire);
    session.connect();
    wire.push(snapshot('g1', 1));
    expect(compacts(wire)).toEqual([]);
    session.declareReady(true);
    expect(compacts(wire).map((m) => [m.instance, m.ready])).toEqual([['g1', true]]);
    write((d) => ({ ...d, count: 1 })); // the outbox fills: not ready
    const [env] = sentEnvs(wire);
    wire.push({ t: 'env', room: 'r', env: { ...env, seq: 2 } }); // acknowledged: ready again
    expect(compacts(wire).map((m) => m.ready)).toEqual([true, false, true]);
    wire.push(snapshot('g2', 3, { index: 1, policy: 'replay' })); // a cut: nobody is pressed
    expect(compacts(wire).map((m) => m.ready)).toEqual([true, false, true]);
    session.declareReady(true);
    expect(compacts(wire).at(-1)).toMatchObject({ instance: 'g2', ready: true });
    wire.drop(); // a reconnect is a leave and a join
    session.close();
  });

  it('surfaces the compaction notice', () => {
    const wire = scripted();
    const seen: unknown[] = [];
    const doc = store<Doc>(initial(), createStoreContext());
    const sync = opSync(doc as never, { writer: 'w', driver: microtaskDriver() });
    const session = meshSession({
      room: 'r',
      writer: 'w',
      transport: wire.factory,
      sync,
      policyVersion: 0,
      hooks: { onStatus: () => undefined, onCompaction: (s) => seen.push(s) },
    });
    session.connect();
    wire.push(snapshot('g1', 1));
    wire.push({ t: 'compaction', room: 'r', count: 3, budget: 300, ready: ['x'] });
    expect(seen).toEqual([{ count: 3, budget: 300, ready: ['x'] }]);
    session.close();
  });
});

describe('session: the durable record (D-d)', () => {
  it("round-trips: the record keeps the tail's generation, evidence and intents but NO registers and no sequence; a restart installs nothing from disk, sends hello WITHOUT seq and resends the outbox before any welcome", () => {
    const wire = scripted();
    const first = direct(wire);
    first.session.connect();
    wire.push(snapshot('g1', 1));
    wire.push({ t: 'env', room: 'r', env: remote('pa', 1, 2, ['title'], 'pa') });
    first.write((d) => ({ ...d, count: 9 }));
    const [pending] = sentEnvs(wire);
    const record = first.session.record();
    expect(record.generation).toEqual({
      instance: 'g1',
      index: 0,
      reason: 'genesis',
      policy: 'discard',
      extent: {},
      preCutMax: {},
    });
    expect(record).not.toHaveProperty('registers');
    expect(record).not.toHaveProperty('maxSeq');
    expect(record.intents).toEqual([
      {
        origin: pending.origin,
        version: pending.version,
        intent: { raws: [{ kind: 'set', path: ['count'], next: 9, prev: 0 }], bump: false },
      },
    ]);
    first.session.close();

    const again = scripted();
    const next = direct(again, { instance: 'g1', record });
    next.sync.restore([pending], pending.version);
    next.session.connect();
    expect(next.doc()).toEqual({ title: 'init', count: 9 }); // the tail only: no stale registers
    expect(again.sent.map((m) => m.t)).toEqual(['hello', 'env']); // the outbox resent first
    expect(hellos(again)[0].seq).toBeUndefined(); // a snapshot is asked for
    // any snapshot of the tail's generation installs (no sequence knowledge survived), the
    // un-admitted own write stays applied over it
    again.push(snapshot('g1', 1, { registers: [rootReg('fresh')] }));
    expect(next.doc()).toEqual({ title: 'fresh', count: 9 });
    expect(next.session.unackedEnvs().map((e) => e.version)).toEqual([pending.version]);
    next.session.close();
  });

  it('R26-1 (§26): a replay admitted under the NEW instance whose entry the record never saw is trimmed at the next cut by its version, never resent', () => {
    const wire = scripted();
    const first = direct(wire);
    first.session.connect();
    wire.push(snapshot('g0', 1));
    first.write((d) => ({ ...d, count: 1 })); // g0:B#1, pending
    const [b1] = sentEnvs(wire);
    expect(b1.instance).toBe('g0');
    const saved = first.session.record(); // the last record that reached the disk
    // cut g1: B#1 replays verbatim as g1:B#1; the relay admits it; B crashes before the record saves
    wire.push(snapshot('g1', 2, { index: 1, policy: 'replay' }));
    expect(sentEnvs(wire).at(-1)).toEqual({ ...b1, instance: 'g1' });
    first.session.close();

    const again = scripted();
    const next = direct(again, { instance: 'g0', record: saved });
    next.sync.restore([b1], b1.version); // the record's tail still names g0
    next.session.connect();
    const before = sentEnvs(again).length;
    // cut g2: its receipts hold (B, g1, {1}) — not (B, g0, …)
    again.push(
      snapshot('g2', 4, {
        index: 2,
        policy: 'replay',
        receipts: { [b1.origin]: { g1: [[1, 1]] } },
      }),
    );
    expect(sentEnvs(again).slice(before)).toEqual([]); // never resent: the write is in the room once
    expect(next.session.unackedEnvs()).toEqual([]);
    expect(next.session.conflicts()).toEqual([]);
    next.session.close();
  });

  it('pins `pathKey` as the extent key (the welcome and the client agree on register identity)', () => {
    expect(pathKey(['count'])).toBe('count');
    expect(Object.keys(extentOf([rootReg('x')]))).toEqual(['']);
  });
});

describe('generation: the pure pieces the session and the proof share', () => {
  it('the intent of an envelope is its raw ops without expansion clears, cites or epoch; it bumped when an epoch rises above the baseline', () => {
    const env: OpEnvelope = {
      proto: OP_PROTO_VERSION,
      instance: 'g1',
      origin: 'o',
      writer: 'w',
      version: 1,
      hlc: h(5),
      policyVersion: 0,
      ops: [
        { kind: 'set', path: ['b'], next: { c: 9 }, cites: [{ origin: 'x', hlc: h(1) }], epoch: 2 },
        { kind: 'clear', path: ['b', 'c'], cites: [{ origin: 'y', hlc: h(2) }], epoch: 0 },
        { kind: 'delete', path: ['k'], prev: 1, cites: [], epoch: 0 },
      ],
    };
    expect(intentOf(env, () => 2)).toEqual({
      raws: [
        { kind: 'set', path: ['b'], next: { c: 9 } },
        { kind: 'delete', path: ['k'], prev: 1 },
      ],
      bump: false,
    });
    expect(intentOf(env, (p) => (p[0] === 'b' && p.length === 1 ? 1 : 0)).bump).toBe(true);
  });

  it('the welcome fence and the receipt trim', () => {
    const fence = { index: 1, instance: 'g1', seq: 4, maxSeq: 6 };
    expect(welcomeVerdict(fence, { index: 2, instance: 'g2', seq: 1 })).toBe('newer');
    expect(welcomeVerdict(fence, { index: 1, instance: 'g1', seq: 6 })).toBe('same');
    expect(welcomeVerdict(fence, { index: 1, instance: 'g1', seq: 5 })).toBe('older-than-traffic');
    expect(welcomeVerdict(fence, { index: 1, instance: 'g1', seq: 3 })).toBe('stale');
    expect(welcomeVerdict(fence, { index: 0, instance: 'g0', seq: 9 })).toBe('stale');
    const t = (version: number, origin = 'o') => ({ env: { origin, instance: 'g0', version } });
    const { trimmed, keep } = trimByReceipts([t(3), t(1), t(2), t(4)], {
      o: {
        g0: [
          [1, 1],
          [3, 3],
        ],
      },
    });
    expect(trimmed.map((x) => x.env.version)).toEqual([1, 3]);
    expect(keep.map((x) => x.env.version)).toEqual([2, 4]); // the hole below 3 is kept, never lost
    // membership is instance-agnostic: a version receipted in a LATER generation (its replay) is
    // admitted; another origin's receipt is not
    const later = trimByReceipts([t(2), t(4)], { o: { g1: [[4, 4]] }, x: { g0: [[2, 2]] } });
    expect(later.trimmed.map((x) => x.env.version)).toEqual([4]);
    expect(later.keep.map((x) => x.env.version)).toEqual([2]);
  });
});
