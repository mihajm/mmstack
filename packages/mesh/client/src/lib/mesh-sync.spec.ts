/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createRegisterStore,
  createRelay,
  MESH_PROTO_VERSION,
  validateEnvelope as validateEnvelopeWire,
  type Dot as WireDot,
  type ServerMsg as WireServerMsg,
  type OpEnvelope as WireEnvelope,
  type RegisterCheckpoint as WireRegisterCheckpoint,
  type Relay,
  type SyncOp as WireSyncOp,
  type SyncSibling as WireSibling,
} from '@mmstack/mesh-protocol';
import {
  createConvergingApply,
  isConflicted,
  OP_PROTO_VERSION,
  preserve,
  store,
  validateEnvelope,
  type Conflicted,
  type Dot,
  type OpEnvelope,
  type RegisterCheckpoint,
  type SyncOp,
  type SyncSibling,
} from '@mmstack/primitives';
import { meshSync, type MeshSyncOptions } from './mesh-sync';
import { directTransport, type MeshTransportFactory } from './transport';

type State = { title: string; nested: { a: number; b: number } };
const initial = (): State => ({ title: 'init', nested: { a: 0, b: 0 } });

// Compile-asserted structural twins: mesh-protocol stays zero-dep, so its wire types must
// remain assignable to and from the primitives originals in BOTH directions.
const _toWire = (e: OpEnvelope): WireEnvelope => e;
const _fromWire = (e: WireEnvelope): OpEnvelope => e;
const _dotToWire = (d: Dot): WireDot => d;
const _dotFromWire = (d: WireDot): Dot => d;
const _opToWire = (o: SyncOp): WireSyncOp => o;
const _opFromWire = (o: WireSyncOp): SyncOp => o;
const _sibToWire = (s: SyncSibling): WireSibling => s;
const _sibFromWire = (s: WireSibling): SyncSibling => s;
const _regToWire = (r: RegisterCheckpoint): WireRegisterCheckpoint => r;
const _regFromWire = (r: WireRegisterCheckpoint): RegisterCheckpoint => r;
// the ingress validator is a structural twin too: identical signature on both sides
const _validateToWire: (e: WireEnvelope) => string | null = validateEnvelope;
const _validateFromWire: (e: OpEnvelope) => string | null = validateEnvelopeWire;
void _validateToWire;
void _validateFromWire;
void _toWire;
void _fromWire;
void _dotToWire;
void _dotFromWire;
void _opToWire;
void _opFromWire;
void _sibToWire;
void _sibFromWire;
void _regToWire;
void _regFromWire;

describe('wire twins (protocol ↔ primitives)', () => {
  it('speaks the same protocol version as the op layer', () => {
    expect(MESH_PROTO_VERSION).toBe(OP_PROTO_VERSION);
  });

  it("the relay's retention twin ingests to the same register state as the client register", () => {
    const canon = (regs: readonly RegisterCheckpoint[]) =>
      regs
        .filter((r) => r.siblings.length || Object.keys(r.water).length)
        .map((r) => ({
          path: r.path.map(String),
          siblings: [...r.siblings].sort((a, b) =>
            a.origin < b.origin ? -1 : 1,
          ),
          water: Object.fromEntries(Object.entries(r.water).sort()),
        }))
        .sort((a, b) => (a.path.join('.') < b.path.join('.') ? -1 : 1));

    const env = (
      origin: string,
      version: number,
      hlc: { p: number; l: number },
      ops: SyncOp[],
    ): OpEnvelope => ({
      proto: OP_PROTO_VERSION,
      origin,
      writer: `w-${origin}`,
      version,
      hlc,
      policyVersion: 0,
      ops,
    });
    const dot = (origin: string, p: number): Dot => ({ origin, hlc: { p, l: 0 } });

    // seed, causal succession (cited), a concurrent uncited write, a delete, a subtree
    // replace with a clear group, and a duplicate delivery
    const envelopes: OpEnvelope[] = [
      env('A', 1, { p: 1, l: 0 }, [
        { kind: 'set', path: [], next: { title: 't', items: {} }, cites: [], epoch: 0 },
      ]),
      env('A', 2, { p: 2, l: 0 }, [
        { kind: 'set', path: ['items', 'x'], next: 1, cites: [], epoch: 0 },
      ]),
      env('B', 1, { p: 2, l: 1 }, [
        { kind: 'set', path: ['items', 'x'], next: 2, cites: [], epoch: 0 },
      ]),
      env('B', 2, { p: 3, l: 0 }, [
        { kind: 'delete', path: ['title'], prev: 't', cites: [dot('A', 1)], epoch: 0 },
      ]),
      env('A', 3, { p: 4, l: 0 }, [
        { kind: 'set', path: ['items'], next: {}, cites: [], epoch: 1 },
        { kind: 'clear', path: ['items', 'x'], cites: [dot('A', 2), dot('B', 2)], epoch: 1 },
      ]),
    ];

    const conv = createConvergingApply();
    const twin = createRegisterStore();
    for (const e of envelopes) {
      conv.ingest(e);
      twin.ingest(e);
      twin.ingest(e); // duplicate delivery is idempotent
    }
    expect(canon(twin.checkpoint())).toEqual(canon(conv.checkpoint()));
  });

  it('PROPERTY: the relay twin and the client register reach identical state for any op stream and order (incl. malformed ops)', () => {
    const canon = (regs: readonly RegisterCheckpoint[]) =>
      regs
        .filter((r) => r.siblings.length || Object.keys(r.water).length)
        .map((r) => ({
          path: r.path.map(String),
          siblings: [...r.siblings]
            .map((s) => ({ kind: s.kind, origin: s.origin, hlc: s.hlc, epoch: s.epoch, value: s.kind === 'set' ? s.value : undefined }))
            .sort((a, b) => (a.origin < b.origin ? -1 : 1)),
          water: Object.fromEntries(Object.entries(r.water).sort()),
        }))
        .sort((a, b) => (a.path.join('/') < b.path.join('/') ? -1 : 1));

    const rng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(seed);
      const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
      const paths: (string | number)[][] = [[], ['a'], ['a', 'b'], ['a', 'c'], ['d']];
      const origins = ['o1', 'o2', 'o3'];
      const envs: OpEnvelope[] = [];
      const lastDot = new Map<string, Dot>();
      let p = 1;
      const n = 10 + Math.floor(r() * 14);
      for (let i = 0; i < n; i++) {
        const path = pick(paths);
        const origin = pick(origins);
        const hlc = { p: p++, l: 0 };
        const key = path.join('/');
        const observed = lastDot.get(key);
        // a spread of cite shapes, including a SELF-cite and an occasional root delete/clear (the
        // malformed cases both twins must drop identically)
        const roll = r();
        const cites: Dot[] = roll < 0.15 ? [{ origin, hlc }] : observed && roll < 0.65 ? [observed] : [];
        const kindRoll = r();
        const kind = kindRoll < 0.6 ? 'set' : kindRoll < 0.8 ? 'delete' : 'clear';
        const op: SyncOp =
          kind === 'set'
            ? ({ kind: 'set', path, next: `v${i}`, cites, epoch: Math.floor(r() * 3) } as SyncOp)
            : kind === 'delete'
              ? ({ kind: 'delete', path, prev: null, cites, epoch: Math.floor(r() * 3) } as SyncOp)
              : ({ kind: 'clear', path, cites, epoch: Math.floor(r() * 3) } as SyncOp);
        envs.push({ proto: OP_PROTO_VERSION, origin, writer: origin, version: i + 1, hlc, policyVersion: 0, ops: [op] });
        if (kind !== 'clear') lastDot.set(key, { origin, hlc });
      }

      // deliver in three orders, with duplicates in one, into fresh twin+client each time
      const orders: OpEnvelope[][] = [
        envs,
        [...envs].reverse(),
        [...envs, ...envs].sort(() => (r() < 0.5 ? -1 : 1)), // shuffled + duplicated
      ];
      const results = orders.map((order) => {
        const conv = createConvergingApply();
        const twin = createRegisterStore();
        for (const e of order) {
          conv.ingest(e);
          twin.ingest(e as WireEnvelope);
        }
        const c = canon(conv.checkpoint());
        const t = canon(twin.checkpoint() as unknown as RegisterCheckpoint[]);
        expect(t, `seed ${seed}: twin ≠ client register`).toEqual(c);
        return c;
      });
      // and every order converged to the same register state (order-independence of both)
      expect(results[1], `seed ${seed}: order-dependent register state`).toEqual(results[0]);
      expect(results[2], `seed ${seed}: duplicate/shuffle-dependent register state`).toEqual(results[0]);
    }
  });

  it('PROPERTY: client prune and relay compact reclaim identically, so a pruning peer stays in twin parity', () => {
    // GC is the other half of #17: if the client register and the relay twin reclaim DIFFERENT
    // registers, a peer that prunes diverges from a joiner seeded off the relay. Drive a churny
    // stream (many set-then-cited-delete pairs -> lone tombstones) through both, GC both at the same
    // frontier, and assert their retained state is byte-identical.
    const canon = (regs: readonly RegisterCheckpoint[]) =>
      regs
        .filter((r) => r.siblings.length || Object.keys(r.water).length)
        .map((r) => ({
          path: r.path.map(String),
          siblings: [...r.siblings]
            .map((s) => ({ kind: s.kind, origin: s.origin, hlc: s.hlc, epoch: s.epoch }))
            .sort((a, b) => (a.origin < b.origin ? -1 : 1)),
          water: Object.fromEntries(Object.entries(r.water).sort()),
        }))
        .sort((a, b) => (a.path.join('/') < b.path.join('/') ? -1 : 1));
    const rng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
      const paths: (string | number)[][] = [['a'], ['a', 'b'], ['a', 'b', 'c'], ['d'], ['d', 'e']];
      const origins = ['o1', 'o2'];
      const conv = createConvergingApply();
      const twin = createRegisterStore();
      const lastDot = new Map<string, Dot>();
      let p = 1;
      const n = 16 + Math.floor(r() * 16);
      for (let i = 0; i < n; i++) {
        const path = pick(paths);
        const origin = pick(origins);
        const hlc = { p: p++, l: 0 };
        const key = path.join('/');
        const observed = lastDot.get(key);
        // bias toward deletes that cite the observed set, so lone tombstones actually form
        const del = r() < 0.5 && observed;
        const op: SyncOp = del
          ? ({ kind: 'delete', path, prev: null, cites: [observed], epoch: 0 } as SyncOp)
          : ({ kind: 'set', path, next: `v${i}`, cites: observed && r() < 0.5 ? [observed] : [], epoch: 0 } as SyncOp);
        const e: OpEnvelope = { proto: OP_PROTO_VERSION, origin, writer: origin, version: i + 1, hlc, policyVersion: 0, ops: [op] };
        conv.ingest(e);
        twin.ingest(e as WireEnvelope);
        lastDot.set(key, { origin, hlc });
      }
      const frontier = { p: Math.floor((p / 2) * (0.5 + r())), l: 0 };
      conv.prune(frontier);
      twin.compact(frontier);
      expect(
        canon(twin.checkpoint() as unknown as RegisterCheckpoint[]),
        `seed ${seed}: prune/compact reclaimed differently`,
      ).toEqual(canon(conv.checkpoint()));
    }
  });
});

describe('meshSync (full loop over an in-process relay)', () => {
  function peer(relay: Relay, writer: string, over?: Partial<MeshSyncOptions>) {
    return TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      const mesh = meshSync(s, {
        room: 'case-1',
        writer,
        transport: directTransport(relay, { writer }),
        ...over,
      });
      return { s, mesh };
    });
  }

  const flush = () => TestBed.tick();

  it('seeds a fresh room, snapshots a late joiner, and replicates live writes both ways', () => {
    const relay = createRelay();
    const a = peer(relay, 'wa');
    expect(a.mesh.status()).toBe('live');

    a.s.title.set('from-a');
    flush();

    const b = peer(relay, 'wb');
    expect(b.mesh.status()).toBe('live');
    expect(b.s()).toEqual({ title: 'from-a', nested: { a: 0, b: 0 } });

    b.s.nested.b.set(2);
    a.s.nested.a.set(1);
    flush();

    expect(a.s()).toEqual({ title: 'from-a', nested: { a: 1, b: 2 } });
    expect(b.s()).toEqual(a.s());
  });

  it('fork(): a committed agent branch reaches the room and a concurrent edit survives', () => {
    const relay = createRelay();
    const a = peer(relay, 'wa');
    const b = peer(relay, 'wb');
    flush();

    // an agent forks A's store and edits it off the room
    const proposal = a.mesh.fork();
    proposal.store.title.set('agent-proposed');

    // meanwhile a concurrent edit lands on the room from B
    b.s.nested.a.set(5);
    flush();

    proposal.commit(); // approve: emits to the room
    flush();

    // the agent's title AND B's concurrent edit both survive
    expect(a.s().title).toBe('agent-proposed');
    expect(a.s().nested.a).toBe(5);
    expect(b.s()).toEqual(a.s());
  });

  it('folds deletes into the room root: a late joiner never resurrects removed keys', () => {
    const relay = createRelay();
    const a = TestBed.runInInjectionContext(() => {
      const s = signal<Record<string, unknown>>({ keep: 1, drop: 2 });
      const mesh = meshSync(s, {
        room: 'case-1',
        writer: 'wa',
        transport: directTransport(relay, { writer: 'wa' }),
      });
      return { s, mesh };
    });
    a.s.update((v) => {
      const next = { ...v };
      delete next['drop'];
      return next;
    });
    flush();

    const b = peer(relay, 'wb');
    expect(b.s() as object).toEqual({ keep: 1 });
  });

  it('reconnects via delta and rebases offline local writes onto the room', () => {
    vi.useFakeTimers();
    try {
      const relay = createRelay();
      const inner = directTransport(relay, { writer: 'wa' });
      let current: ReturnType<typeof inner> | null = null;
      const a = TestBed.runInInjectionContext(() => {
        const s = store<State>(initial());
        const mesh = meshSync(s, {
          room: 'case-1',
          writer: 'wa',
          transport: () => (current = inner()),
        });
        return { s, mesh };
      });
      const b = peer(relay, 'wb');
      flush();
      expect(a.mesh.status()).toBe('live');

      current!.close();
      expect(a.mesh.status()).toBe('reconnecting');

      a.s.nested.a.set(7);
      flush();
      b.s.title.set('while-a-was-away');
      flush();
      expect(a.s().title).toBe('init');

      vi.advanceTimersByTime(700);

      expect(a.mesh.status()).toBe('live');
      expect(a.s()).toEqual({
        title: 'while-a-was-away',
        nested: { a: 7, b: 0 },
      });
      expect(b.s()).toEqual(a.s());
    } finally {
      vi.useRealTimers();
    }
  });

  it('ejects a policy-violating writer without disturbing the healthy peer', () => {
    const ejections: string[] = [];
    const relay = createRelay({
      policy: { canWrite: (_ctx, path) => path[0] !== 'title' },
    });
    const a = peer(relay, 'wa', { onEject: (r) => ejections.push(r) });
    const b = peer(relay, 'wb');
    flush();

    a.s.title.set('forbidden');
    flush();

    expect(a.mesh.status()).toBe('ejected');
    expect(ejections).toEqual(['can-write']);
    expect(b.mesh.status()).toBe('live');

    b.s.nested.a.set(5);
    flush();
    expect(b.s().nested.a).toBe(5);
  });

  it('emit-side policy honesty: a locally-invalid write never reaches the wire, and the eject matches the relay outcome', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const violations: unknown[] = [];
      const relay = createRelay({
        policy: { canWrite: (_ctx, path) => path[0] !== 'title' },
        onViolation: (_room, v) => violations.push(v),
      });
      const ejections: (string | undefined)[] = [];
      const a = peer(relay, 'wa', {
        policy: { canWrite: (_ctx, path) => path[0] !== 'title' },
        onEject: (reason) => ejections.push(reason),
      });
      const b = peer(relay, 'wb');
      flush();

      a.s.title.set('forbidden');
      flush();

      // same outcome the relay-side test above produces — one hop early
      expect(a.mesh.status()).toBe('ejected');
      expect(ejections).toEqual(['can-write']);
      expect(violations).toEqual([]); // the optimization: the relay never even saw it
      expect(b.s().title).toBe('init');
      expect(b.mesh.status()).toBe('live');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('carries presence: roster on join, live updates, gone on close', () => {
    const relay = createRelay();
    const a = peer(relay, 'wa');
    a.mesh.setPresence({ section: 'pricing' });

    const b = peer(relay, 'wb');
    expect(b.mesh.peers().map((p) => p.writer)).toEqual(['wa']);

    b.mesh.setPresence({ section: 'notes' });
    expect(a.mesh.peers().map((p) => p.writer)).toEqual(['wb']);

    a.mesh.close();
    expect(b.mesh.peers()).toEqual([]);
  });

  it('holds writes made while connecting and flushes them on welcome (async transport)', () => {
    const relay = createRelay();
    const inner = directTransport(relay, { writer: 'wa' });
    const queue: (() => void)[] = [];
    const drain = () => {
      while (queue.length) queue.shift()!();
    };
    const a = TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      const mesh = meshSync(s, {
        room: 'case-1',
        writer: 'wa',
        transport: () => {
          const t = inner();
          return {
            ...t,
            send: (m) => queue.push(() => t.send(m)),
            onMessage: (cb) => t.onMessage((m) => queue.push(() => cb(m))),
          };
        },
      });
      return { s, mesh };
    });

    expect(a.mesh.status()).toBe('connecting');
    a.s.title.set('written-before-welcome');
    flush();
    expect(relay.room('case-1')).toBeUndefined();

    drain();
    drain();
    drain();
    drain();

    expect(a.mesh.status()).toBe('live');
    expect(relay.room('case-1')!.seq).toBeGreaterThanOrEqual(2);
    expect(a.s().title).toBe('written-before-welcome');
  });

  it('snapshot reconnect does NOT resurrect acked-and-superseded local writes', () => {
    vi.useFakeTimers();
    try {
      const relay = createRelay({ journalLimit: 2 });
      const inner = directTransport(relay, { writer: 'wa' });
      let current: ReturnType<typeof inner> | null = null;
      const a = TestBed.runInInjectionContext(() => {
        const s = store<State>(initial());
        const mesh = meshSync(s, {
          room: 'case-1',
          writer: 'wa',
          transport: () => (current = inner()),
        });
        return { s, mesh };
      });
      const b = peer(relay, 'wb');
      flush();

      a.s.title.set('mine');
      flush();
      b.s.title.set('theirs');
      flush();
      expect(a.s().title).toBe('theirs');

      current!.close();
      b.s.nested.a.set(1);
      flush();
      b.s.nested.b.set(2);
      flush();
      b.s.nested.a.set(3);
      flush();

      vi.advanceTimersByTime(700);

      expect(a.mesh.status()).toBe('live');
      expect(a.s().title).toBe('theirs');
      expect(a.s()).toEqual(b.s());
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-seeds when the relay room was recreated (epoch change)', () => {
    vi.useFakeTimers();
    try {
      const relayA = createRelay();
      let relay = relayA;
      const inner = () => directTransport(relay, { writer: 'wa' })();
      let current: ReturnType<typeof inner> | null = null;
      const a = TestBed.runInInjectionContext(() => {
        const s = store<State>(initial());
        const mesh = meshSync(s, {
          room: 'case-1',
          writer: 'wa',
          transport: () => (current = inner()),
        });
        return { s, mesh };
      });
      a.s.title.set('survives-restart');
      flush();
      expect(relayA.room('case-1')!.seq).toBeGreaterThanOrEqual(2);

      relay = createRelay();
      current!.close();
      vi.advanceTimersByTime(700);

      expect(a.mesh.status()).toBe('live');
      expect(relay.room('case-1')!.seq).toBeGreaterThanOrEqual(1);
      const c = peer(relay, 'wc');
      expect(c.s().title).toBe('survives-restart');
    } finally {
      vi.useRealTimers();
    }
  });

  it('after ejection, local writes keep working locally and never resume the connection', () => {
    const relay = createRelay({
      policy: { canWrite: (_ctx, path) => path[0] !== 'title' },
    });
    const a = peer(relay, 'wa');
    flush();
    a.s.title.set('forbidden');
    flush();
    expect(a.mesh.status()).toBe('ejected');
    expect(a.mesh.peers()).toEqual([]);

    a.s.nested.a.set(42);
    flush();
    expect(a.s().nested.a).toBe(42);
    expect(a.mesh.status()).toBe('ejected');
  });

  it('applies per-path preserve across the mesh', () => {
    const relay = createRelay();
    const policies = [{ path: 'title', merge: preserve }];
    const a = peer(relay, 'wa', { policies });
    flush();
    const b = peer(relay, 'wb', { policies });
    flush();

    a.s.title.set('A');
    b.s.title.set('B');
    flush();

    expect(a.s().title).toEqual(b.s().title);
    if (isConflicted(a.s().title)) {
      expect((a.s().title as unknown as Conflicted<string>).mine).toBeDefined();
    }
  });
});

describe('ingress validation (client ↔ relay twin)', () => {
  const CTRL = String.fromCharCode(0x1f);
  const base = (): OpEnvelope => ({
    proto: OP_PROTO_VERSION,
    origin: 'o1',
    writer: 'w1',
    version: 1,
    hlc: { p: 3, l: 0 },
    policyVersion: 0,
    ops: [{ kind: 'set', path: ['a'], next: 1, cites: [], epoch: 0 }],
  });

  it('the client validator and the relay twin agree on a curated malformed set (byte-identical decisions)', () => {
    const patch = (fn: (e: any) => void): OpEnvelope => {
      const e = structuredClone(base());
      fn(e as any);
      return e as OpEnvelope;
    };
    const samples: OpEnvelope[] = [
      base(),
      patch((e) => (e.origin = '')),
      patch((e) => (e.writer = `w${CTRL}`)),
      patch((e) => (e.hlc = { p: NaN, l: 0 })),
      patch((e) => (e.version = 0)),
      patch((e) => (e.ops = [{ kind: 'delete', path: [], prev: 0, cites: [], epoch: 0 } as any])),
      patch((e) => (e.ops = [null as any])), // totality: both twins reject, neither throws
      patch((e) => (e.ops[0] = { ...e.ops[0], epoch: -1 })),
      patch((e) => (e.ops[0] = { ...e.ops[0], path: [`x${CTRL}`] })),
      patch((e) => (e.ops[0] = { ...e.ops[0], cites: [{ origin: '', hlc: { p: 1, l: 0 } }] })),
      patch((e) => (e.ops = [
        { kind: 'set', path: ['a'], next: 1, cites: [], epoch: 0 },
        { kind: 'set', path: ['a'], next: 2, cites: [], epoch: 0 },
      ])),
    ];
    for (const env of samples) {
      expect(validateEnvelopeWire(env as WireEnvelope)).toBe(validateEnvelope(env));
    }
  });

  it('PROPERTY: client and relay twin reach identical verdicts on a randomized valid/malformed stream', () => {
    const rng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
      const origin = pick(['o1', '', `bad${CTRL}`, 'ok']);
      const writer = pick(['w1', '', `w${CTRL}`]);
      const version = pick([1, 0, -1, 2.5, 7]);
      const hlc = pick([{ p: 1, l: 0 }, { p: NaN, l: 0 }, { p: 2 } as any]);
      const kind = pick(['set', 'delete', 'clear', 'weird']);
      const path = pick([['a'], ['a', 'b'], [], [`c${CTRL}`], 'nope' as any]);
      const epoch = pick([0, 1, -1, NaN]);
      const cites = pick([[], [{ origin: 'o2', hlc: { p: 1, l: 0 } }], [{ origin: '', hlc: { p: 1, l: 0 } }], 'x' as any]);
      const dup = r() < 0.25;
      const op: any = kind === 'delete' ? { kind, path, prev: 0, cites, epoch } : kind === 'clear' ? { kind, path, cites, epoch } : { kind, path, next: 1, cites, epoch };
      const ops = dup ? [op, { ...op }] : [op];
      const env = { proto: OP_PROTO_VERSION, origin, writer, version, hlc, policyVersion: 0, ops } as OpEnvelope;
      expect(validateEnvelopeWire(env as WireEnvelope), `seed ${seed}`).toBe(validateEnvelope(env));
    }
  });

  it('a malicious direct-peer envelope (control-char origin) is rejected at the receiving client, no relay involved', () => {
    let push: (msg: WireServerMsg) => void = () => undefined;
    const transport: MeshTransportFactory = () => ({
      send: () => undefined,
      close: () => undefined,
      onMessage: (cb) => {
        push = cb;
        return () => undefined;
      },
      onClose: () => () => undefined,
    });
    const { s, mesh } = TestBed.runInInjectionContext(() => {
      const st = store<State>(initial());
      const m = meshSync(st, { room: 'p2p', writer: 'w', transport });
      return { s: st, mesh: m };
    });

    // a direct peer (no relay sequencing this) sends a forged envelope with a control char in origin
    push({
      t: 'env',
      room: 'p2p',
      env: {
        proto: OP_PROTO_VERSION,
        origin: `x${CTRL}y`,
        writer: 'w2',
        version: 1,
        hlc: { p: 1, l: 0 },
        policyVersion: 0,
        ops: [{ kind: 'set', path: ['title'], next: 'HACK', cites: [], epoch: 0 }],
        seq: 1,
      },
    });

    expect(s()).toEqual(initial()); // the store was never touched by the malformed write
    expect(mesh.health().droppedInvalidEnvelopes).toBe(1); // and the rejection is surfaced

    mesh.close();
  });
});
