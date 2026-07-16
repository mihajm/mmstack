/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { TestBed } from '@angular/core/testing';
import {
  createRelay,
  pathPrefixAcl,
  type ClientMsg,
  type PrincipalCtx,
  type Relay,
  type SeqEnvelope,
  type ServerMsg,
} from '@mmstack/mesh-protocol';
import {
  createStoreContext,
  OP_PROTO_VERSION,
  store,
} from '@mmstack/primitives';
import { agentSeat, describeOp, setAtPath, type SeatEvent } from './agent-seat';
import { meshSync } from './mesh-sync';
import { directTransport, type MeshTransportFactory } from './transport';

type Doc = {
  title: string;
  nested: { a: number; b: number };
  tasks: Record<string, { title: string; done: boolean }>;
};
const initial = (): Doc => ({
  title: 'init',
  nested: { a: 0, b: 0 },
  tasks: {},
});

function seat(relay: Relay, writer: string, over?: object) {
  const events: SeatEvent[] = [];
  const s = agentSeat<Doc>(initial(), {
    room: 'case-1',
    writer,
    transport: directTransport(relay, { writer, kind: 'agent' }),
    ...over,
  });
  s.changes((e) => events.push(e));
  return { s, events };
}

/** Wraps a transport so inbound frames can be held back (stableSnapshot windows) and the
 *  live connection dropped (reconnect paths), while outbound sends flow untouched. */
function gatedTransport(relay: Relay, ctx: PrincipalCtx) {
  const inner = directTransport(relay, ctx);
  let paused = false;
  const queue: ServerMsg[] = [];
  let dispatch: ((m: ServerMsg) => void) | undefined;
  let dropCurrent: (() => void) | undefined;
  const factory: MeshTransportFactory = () => {
    const t = inner();
    const cbs = new Set<(m: ServerMsg) => void>();
    dispatch = (m) => {
      for (const cb of [...cbs]) cb(m);
    };
    dropCurrent = () => t.close();
    t.onMessage((m) => {
      if (paused) queue.push(m);
      else dispatch?.(m);
    });
    return {
      send: (m) => t.send(m),
      onMessage: (cb) => {
        cbs.add(cb);
        return () => cbs.delete(cb);
      },
      onClose: (cb) => t.onClose(cb),
      close: () => t.close(),
    };
  };
  return {
    factory,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      for (const m of queue.splice(0)) dispatch?.(m);
    },
    drop: () => dropCurrent?.(),
  };
}

const changes = (events: SeatEvent[]) =>
  events.filter((e) => e.kind === 'change');

describe('agentSeat (headless peer over an in-process relay)', () => {
  it('boots with no injection context, seeds a fresh room, and hydrates a late joiner', () => {
    const relay = createRelay();
    const a = seat(relay, 'agent-a'); // no TestBed anywhere on this path
    expect(a.s.status()).toBe('live');

    a.s.write(() => a.s.doc.title.set('from-a'));

    const b = seat(relay, 'agent-b');
    expect(b.s.status()).toBe('live');
    expect(b.s.snapshot()).toEqual({
      title: 'from-a',
      nested: { a: 0, b: 0 },
      tasks: {},
    });
    a.s.close();
    b.s.close();
  });

  it('replicates live writes with attribution, in seq order, and never echoes own writes', () => {
    const relay = createRelay();
    const a = seat(relay, 'agent-a');
    const b = seat(relay, 'agent-b');

    a.s.write(() => a.s.doc.nested.a.set(1));
    b.s.write(() => b.s.doc.nested.b.set(2));
    a.s.setAtPath('title', 'renamed');

    expect(a.s.snapshot()).toEqual(b.s.snapshot());
    expect(a.s.snapshot().nested).toEqual({ a: 1, b: 2 });
    expect(a.s.snapshot().title).toBe('renamed');

    // b saw exactly a's two batches, attributed, seq strictly increasing
    const bChanges = changes(b.events);
    expect(bChanges.map((c) => c.writer)).toEqual(['agent-a', 'agent-a']);
    for (let i = 1; i < bChanges.length; i++) {
      expect(bChanges[i].seq).toBeGreaterThan(bChanges[i - 1].seq);
    }
    // a saw only b's batch — its own writes never come back through changes
    expect(changes(a.events).map((c) => c.writer)).toEqual(['agent-b']);
    a.s.close();
    b.s.close();
  });

  it('N seats: three collaborators converge and each stream attributes the other two', () => {
    const relay = createRelay();
    const seats = ['hints', 'review', 'human'].map((w) => seat(relay, w));
    const [hints, review, human] = seats;

    hints.s.setAtPath('tasks.h1', { title: 'hint', done: false });
    review.s.setAtPath('tasks.r1', { title: 'review', done: false });
    human.s.setAtPath('title', 'planned');

    const docs = seats.map(({ s }) => s.snapshot());
    expect(docs[0]).toEqual(docs[1]);
    expect(docs[1]).toEqual(docs[2]);
    expect(Object.keys(docs[0].tasks).sort()).toEqual(['h1', 'r1']);

    expect(new Set(changes(hints.events).map((c) => c.writer))).toEqual(
      new Set(['review', 'human']),
    );
    expect(new Set(changes(human.events).map((c) => c.writer))).toEqual(
      new Set(['hints', 'review']),
    );
    for (const { s } of seats) s.close();
  });

  it('fork(): a committed proposal survives a concurrent room edit as a real concurrent write', () => {
    const relay = createRelay();
    const a = seat(relay, 'human');
    const b = seat(relay, 'agent');

    const proposal = b.s.fork();
    setAtPath(proposal.store, 'tasks.fix1', { title: 'proposed', done: false });
    setAtPath(proposal.store, 'title', 'from-fork');

    // a room edit lands while the proposal is open
    a.s.write(() => a.s.doc.nested.a.set(7));
    expect(b.s.snapshot().nested.a).toBe(7); // seat replica moved under the open fork

    proposal.commit();

    // the commit cites only what the fork observed at creation, so it lands as a
    // concurrent write; the room edit survives, the proposal lands, replicas agree
    expect(a.s.snapshot()).toEqual(b.s.snapshot());
    expect(a.s.snapshot().nested.a).toBe(7);
    expect(a.s.snapshot().tasks['fix1']).toEqual({
      title: 'proposed',
      done: false,
    });
    expect(a.s.snapshot().title).toBe('from-fork');
    a.s.close();
    b.s.close();
  });

  it('fork(): discard() drops staged edits without emitting anything', () => {
    const relay = createRelay();
    const a = seat(relay, 'human');
    const b = seat(relay, 'agent');
    const before = changes(a.events).length;

    const proposal = b.s.fork();
    setAtPath(proposal.store, 'title', 'never-lands');
    proposal.discard();

    expect(a.s.snapshot().title).toBe('init');
    expect(changes(a.events).length).toBe(before);
    a.s.close();
    b.s.close();
  });

  it('ejects a seat that writes outside its policy scope; the room never sees the write', () => {
    const policy = pathPrefixAcl([
      { prefix: ['tasks'], allow: (ctx) => ctx.writer === 'scoped-agent' },
      { prefix: [], allow: (ctx) => ctx.writer !== 'scoped-agent' },
    ]);
    const relay = createRelay({ policy });
    const human = seat(relay, 'human');
    let ejectedFor: string | undefined;
    const rogue = seat(relay, 'scoped-agent', {
      onEject: (reason: string) => (ejectedFor = reason),
    });
    expect(rogue.s.status()).toBe('live');

    rogue.s.setAtPath('title', 'out-of-scope');

    expect(rogue.s.status()).toBe('ejected');
    expect(ejectedFor).toBe('can-write');
    expect(human.s.snapshot().title).toBe('init');
    // the refused write is still folded into the ejected replica — never a cacheable base
    expect(rogue.s.stableSnapshot()).toBeNull();
    human.s.close();
    rogue.s.close();
  });

  it('a fresh-room seed that trips the emit-side policy ejects the seat — the welcome must not revive it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const policy = pathPrefixAcl([
        { prefix: ['tasks'], allow: (ctx) => ctx.writer === 'scoped-agent' },
        { prefix: [], allow: (ctx) => ctx.writer !== 'scoped-agent' },
      ]);
      let ejectedFor: string | undefined;
      // first member of a fresh room: the seat itself seeds, and the seed writes outside
      // its scope — the eject fires INSIDE welcome handling and must stick
      const rogue = seat(createRelay(), 'scoped-agent', {
        policy,
        onEject: (reason: string) => (ejectedFor = reason),
      });

      expect(rogue.s.status()).toBe('ejected');
      expect(ejectedFor).toBe('can-write');
      expect(rogue.s.stableSnapshot()).toBeNull();
      rogue.s.close();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('agentSeat stableSnapshot + changes (cache alignment)', () => {
  it('is null while a local write is unacknowledged, and seq-stamped once the room sequenced it', () => {
    const relay = createRelay();
    const gate = gatedTransport(relay, { writer: 'agent-a', kind: 'agent' });
    const a = agentSeat<Doc>(initial(), {
      room: 'case-1',
      writer: 'agent-a',
      transport: gate.factory,
    });
    expect(a.status()).toBe('live');

    const settled = a.stableSnapshot();
    expect(settled).not.toBeNull();

    gate.pause(); // the relay's echo (our ack) is now held back
    a.write(() => a.doc.title.set('in-flight'));
    expect(a.stableSnapshot()).toBeNull();

    gate.resume();
    const after = a.stableSnapshot();
    expect(after).not.toBeNull();
    expect(after!.doc.title).toBe('in-flight');
    expect(after!.seq).toBeGreaterThan(settled!.seq);
    a.close();
  });

  it('counts a same-tick unflushed write as pending, not as part of a stable base', () => {
    const relay = createRelay();
    const gate = gatedTransport(relay, { writer: 'agent-a', kind: 'agent' });
    const a = agentSeat<Doc>(initial(), {
      room: 'case-1',
      writer: 'agent-a',
      transport: gate.factory,
    });
    gate.pause();
    a.doc.title.set('raw-write'); // no write() wrapper, emission still microtask-pending
    expect(a.stableSnapshot()).toBeNull(); // stableSnapshot flushes first — never a stale stamp
    gate.resume();
    a.close();
  });

  it('an emit-side policy reject ejects the seat exactly as the relay would — one hop early, same outcome', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const policy = pathPrefixAcl([
        { prefix: ['tasks'], allow: (ctx) => ctx.writer === 'scoped-agent' },
        { prefix: [], allow: (ctx) => ctx.writer !== 'scoped-agent' },
      ]);
      const relay = createRelay({ policy });
      const human = seat(relay, 'human');

      // same rogue write twice: caught locally (seat carries the policy) vs caught at the
      // relay (seat carries none). The emit-side check is an optimization, never the
      // enforcement — so the two paths must be observationally identical.
      const outcomes = [policy, undefined].map((local) => {
        let ejectedFor: string | undefined;
        const rogue = seat(relay, 'scoped-agent', {
          policy: local,
          onEject: (reason: string) => (ejectedFor = reason),
        });
        rogue.s.setAtPath('title', 'out-of-scope');
        const outcome = {
          status: rogue.s.status(),
          reason: ejectedFor,
          stable: rogue.s.stableSnapshot(),
          kept: rogue.s.snapshot().title, // the refused value stays visible for post-mortem
        };
        rogue.s.close();
        return outcome;
      });

      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(outcomes[0]).toEqual({
        status: 'ejected',
        reason: 'can-write',
        stable: null,
        kept: 'out-of-scope',
      });
      expect(human.s.snapshot().title).toBe('init'); // the room saw neither attempt
      expect(warn).toHaveBeenCalled();
      human.s.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('two replicas at the same seq produce identical stable snapshots (the cacheable claim)', () => {
    const relay = createRelay();
    const a = seat(relay, 'agent-a');
    const b = seat(relay, 'agent-b');

    a.s.write(() => a.s.doc.nested.a.set(5));
    b.s.write(() => b.s.doc.title.set('both'));

    const sa = a.s.stableSnapshot();
    const sb = b.s.stableSnapshot();
    expect(sa).not.toBeNull();
    expect(sa!.seq).toBe(sb!.seq);
    expect(JSON.stringify(sa!.doc)).toBe(JSON.stringify(sb!.doc));
    a.s.close();
    b.s.close();
  });

  it('a reconnect covered by the journal resumes via delta: contiguous change events, no resync', () => {
    vi.useFakeTimers();
    try {
      const relay = createRelay();
      const gate = gatedTransport(relay, { writer: 'agent-b', kind: 'agent' });
      const a = seat(relay, 'agent-a');
      const events: SeatEvent[] = [];
      const b = agentSeat<Doc>(initial(), {
        room: 'case-1',
        writer: 'agent-b',
        transport: gate.factory,
      });
      b.changes((e) => events.push(e));
      const seqBefore = changes([...events]).at(-1)?.seq ?? 0;

      gate.drop();
      expect(b.status()).toBe('reconnecting');
      a.s.write(() => a.s.doc.nested.a.set(1));
      a.s.write(() => a.s.doc.nested.b.set(2));

      vi.advanceTimersByTime(700); // past base backoff + jitter
      expect(b.status()).toBe('live');
      expect(b.snapshot().nested).toEqual({ a: 1, b: 2 });

      expect(events.some((e) => e.kind === 'resync')).toBe(false);
      const seqs = changes(events)
        .map((c) => c.seq)
        .filter((s) => s > seqBefore);
      expect(seqs.length).toBe(2); // the two missed writes arrived as individual batches
      for (let i = 1; i < seqs.length; i++)
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      a.s.close();
      b.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a reconnect past the journal resyncs: one resync event, converged doc, re-checkpointable seq', () => {
    vi.useFakeTimers();
    try {
      const relay = createRelay({ journalLimit: 2 });
      const gate = gatedTransport(relay, { writer: 'agent-b', kind: 'agent' });
      const a = seat(relay, 'agent-a');
      const events: SeatEvent[] = [];
      const b = agentSeat<Doc>(initial(), {
        room: 'case-1',
        writer: 'agent-b',
        transport: gate.factory,
      });
      b.changes((e) => events.push(e));

      gate.drop();
      events.length = 0;
      for (let i = 1; i <= 5; i++) {
        a.s.write(() => a.s.doc.nested.a.set(i)); // compacts the journal past b's seq
      }

      vi.advanceTimersByTime(700);
      expect(b.status()).toBe('live');

      // the gap is not replayable — the seat must say so instead of silently resuming
      expect(events.map((e) => e.kind)).toEqual(['resync']);
      expect(b.snapshot().nested.a).toBe(5);
      const stable = b.stableSnapshot();
      expect(stable).not.toBeNull();
      expect(stable!.seq).toBe((events[0] as { seq: number }).seq);
      expect(JSON.stringify(stable!.doc)).toBe(JSON.stringify(a.s.snapshot()));
      a.s.close();
      b.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late joiner past compaction gets a resync as its first event, stamped at the snapshot seq', () => {
    const relay = createRelay({ journalLimit: 2 });
    const a = seat(relay, 'agent-a');
    for (let i = 1; i <= 5; i++) a.s.write(() => a.s.doc.nested.a.set(i));

    // hold the welcome back so the subscription observes it (a real network is async anyway)
    const gate = gatedTransport(relay, { writer: 'agent-b', kind: 'agent' });
    gate.pause();
    const events: SeatEvent[] = [];
    const b = agentSeat<Doc>(initial(), {
      room: 'case-1',
      writer: 'agent-b',
      transport: gate.factory,
    });
    b.changes((e) => events.push(e));
    gate.resume();

    expect(b.status()).toBe('live');
    expect(events[0]?.kind).toBe('resync');
    expect(b.snapshot()).toEqual(a.s.snapshot());
    expect(b.stableSnapshot()?.seq).toBe((events[0] as { seq: number }).seq);
    a.s.close();
    b.close();
  });
});

describe('agentSeat schema honesty (scripted relay)', () => {
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

  it('a newer-schema envelope inside a delta welcome ejects and never revives to live', () => {
    const wire = scripted();
    let ejectedFor: string | undefined;
    const a = agentSeat<Doc>(initial(), {
      room: 'case-1',
      writer: 'agent-a',
      transport: wire.factory,
      schemaVersion: 1,
      onEject: (reason) => (ejectedFor = reason),
    });
    expect(a.status()).toBe('connecting');

    const migration: SeqEnvelope = {
      proto: OP_PROTO_VERSION,
      origin: 'migrator',
      writer: 'deploy-job',
      version: 1,
      hlc: { p: 1, l: 0 },
      policyVersion: 0,
      schemaVersion: 2,
      ops: [{ kind: 'set', path: ['title'], next: 'v2', cites: [], epoch: 0 }],
      seq: 3,
    };
    wire.push({
      t: 'welcome',
      room: 'case-1',
      seq: 3,
      instance: 'i1',
      schemaVersion: 2,
      peers: [],
      members: [],
      mode: 'delta',
      envs: [migration],
    });

    // the eject wins over the rest of the welcome — status must not flip back to live
    expect(a.status()).toBe('ejected');
    expect(ejectedFor).toBe('schema');
    expect(a.stableSnapshot()).toBeNull();
    a.close();
  });

  it('a malformed remote envelope never enters the change stream; the next valid batch still lands', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const wire = scripted();
      const events: SeatEvent[] = [];
      const a = agentSeat<Doc>(initial(), {
        room: 'case-1',
        writer: 'agent-a',
        transport: wire.factory,
      });
      a.changes((e) => events.push(e));
      wire.push({
        t: 'welcome',
        room: 'case-1',
        seq: 0,
        instance: 'i1',
        schemaVersion: 0,
        peers: [],
        members: [],
        mode: 'up-to-date',
      });
      expect(a.status()).toBe('live');

      const CTRL = String.fromCharCode(0x1f); // control chars fail wire validation
      const env = (over: object): ServerMsg => ({
        t: 'env',
        room: 'case-1',
        env: {
          proto: OP_PROTO_VERSION,
          writer: 'w2',
          version: 1,
          hlc: { p: 1, l: 0 },
          policyVersion: 0,
          ...over,
        } as SeqEnvelope,
      });
      wire.push(
        env({
          origin: `x${CTRL}y`,
          writer: 'forger',
          seq: 1,
          ops: [{ kind: 'set', path: ['title'], next: 'HACK', cites: [], epoch: 0 }],
        }),
      );
      wire.push(
        env({
          origin: 'peer-ok',
          writer: 'honest',
          seq: 2,
          ops: [{ kind: 'set', path: ['title'], next: 'legit', cites: [], epoch: 0 }],
        }),
      );

      expect(a.snapshot().title).toBe('legit'); // the malformed write never applied
      const got = changes(events);
      expect(got).toHaveLength(1); // and was never narrated — only the valid batch
      expect(got[0].writer).toBe('honest');
      a.close();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('agentSeat interop with meshSync (one wire contract, two shells)', () => {
  it('converges both directions with an Angular meshSync peer, with attribution', () => {
    const relay = createRelay();
    const human = TestBed.runInInjectionContext(() => {
      const s = store<Doc>(initial());
      const mesh = meshSync(s, {
        room: 'case-1',
        writer: 'human',
        transport: directTransport(relay, { writer: 'human' }),
      });
      return { s, mesh };
    });
    expect(human.mesh.status()).toBe('live');

    const agent = seat(relay, 'agent-a');
    expect(agent.s.snapshot()).toEqual(human.s());

    human.s.title.set('from-human');
    TestBed.tick(); // meshSync emission rides the app tick

    expect(agent.s.snapshot().title).toBe('from-human');
    expect(changes(agent.events).at(-1)?.writer).toBe('human');

    agent.s.setAtPath('nested.a', 42);
    expect(human.s().nested.a).toBe(42);

    // the agent proposes on a fork; the human's replica gets it only on commit
    const proposal = agent.s.fork();
    setAtPath(proposal.store, 'tasks.t1', { title: 'draft', done: false });
    expect(human.s().tasks).toEqual({});
    proposal.commit();
    expect(human.s().tasks['t1']).toEqual({ title: 'draft', done: false });

    expect(human.mesh.peers().some((p) => p.writer === 'agent-a')).toBe(false); // presence is opt-in
    agent.s.setPresence({ name: 'Claude', kind: 'agent' });
    expect(
      human.mesh.peers().find((p) => p.writer === 'agent-a')?.data,
    ).toEqual({ name: 'Claude', kind: 'agent' });

    agent.s.close();
    human.mesh.close();
  });
});

describe('setAtPath', () => {
  const make = () =>
    store<Doc & { list: { v: number }[]; rec: Record<string, string> }>(
      {
        ...initial(),
        list: [{ v: 1 }, { v: 2 }],
        rec: { '0': 'zero' },
      },
      createStoreContext(), // injector-free, like the seat itself
    );

  it('writes through existing child signals, preserving untouched sibling identity', () => {
    const s = make();
    const before = s();
    setAtPath(s, 'nested.a', 9);
    const after = s();
    expect(after.nested.a).toBe(9);
    expect(after.nested.b).toBe(0);
    expect(after.tasks).toBe(before.tasks); // untouched subtree keeps its identity
    expect(after.list).toBe(before.list);
  });

  it('creates missing record keys and intermediate containers', () => {
    const s = make();
    setAtPath(s, 'tasks.t9.title', 'fresh');
    expect(s().tasks['t9']).toEqual({ title: 'fresh' });
    setAtPath(s, ['tasks', 't9', 'done'], true);
    expect(s().tasks['t9']).toEqual({ title: 'fresh', done: true });
  });

  it('addresses array elements by dot-string index without corrupting the array', () => {
    const s = make();
    const before = s();
    setAtPath(s, 'list.1.v', 22);
    const after = s();
    expect(Array.isArray(after.list)).toBe(true);
    expect(after.list.map((e) => e.v)).toEqual([1, 22]);
    expect(after.list[0]).toBe(before.list[0]); // untouched element identity preserved
  });

  it('treats a numeric-looking segment as a record key when the container is a record', () => {
    const s = make();
    setAtPath(s, 'rec.0', 'still-a-key');
    expect(s().rec).toEqual({ '0': 'still-a-key' });
  });

  it('accepts segment arrays and whole-node paths', () => {
    const s = make();
    setAtPath(s, ['title'], 'via-segments');
    expect(s().title).toBe('via-segments');
    setAtPath(s, 'nested', { a: 1, b: 1 });
    expect(s().nested).toEqual({ a: 1, b: 1 });
  });
});

describe('describeOp', () => {
  it('narrates set/delete/clear with dot paths and the writer', () => {
    expect(
      describeOp(
        { kind: 'set', path: ['plan', 'endDate'], next: '2026-10-11' },
        'mira',
      ),
    ).toBe('mira set plan.endDate to "2026-10-11"');
    expect(
      describeOp({ kind: 'delete', path: ['tasks', 't1'], prev: {} }, 'jo'),
    ).toBe('jo removed tasks.t1');
    expect(describeOp({ kind: 'clear', path: ['tasks'] }, 'jo')).toBe(
      'jo cleared tasks',
    );
  });

  it('labels the document root and truncates long values', () => {
    expect(describeOp({ kind: 'set', path: [], next: 1 }, 'w')).toBe(
      'w set the document root to 1',
    );
    const long = describeOp(
      { kind: 'set', path: ['t'], next: 'x'.repeat(500) },
      'w',
    );
    expect(long.length).toBeLessThan(160);
    expect(long.endsWith('…')).toBe(true);
  });
});
