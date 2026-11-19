import { describe, expect, it } from 'vitest';
import {
  createRelay,
  type RelayConnection,
  type RelayRow,
  type RoomSnapshot,
} from './relay';
import {
  MESH_PROTO_VERSION,
  type OpEnvelope,
  type SeqEnvelope,
  type ServerMsg,
} from './wire';

// A resend of an admitted version is answered with a `drop` 'duplicate', which a client counts as
// the acknowledgement of that write. These specs hold the real relay, with a commit hook whose
// promises the spec settles by hand, to the rule the echo already follows: no acknowledgement of
// a write before its row is durable, and none at all once its row failed.

type Gate = { resolve(): void; reject(cause: unknown): void };

const flush = async (turns = 50): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

type Harness = {
  readonly snapshot?: RoomSnapshot;
  /** `onCommit` answers a promise the spec settles (`gated`, the default) or nothing (`void`). */
  readonly commit?: 'gated' | 'void';
  /** The same for `onRow` (default `void`). */
  readonly row?: 'gated' | 'void';
  /** Arms the citation gate, which relay cuts need. */
  readonly cuts?: boolean;
  readonly onDrop?: (reason: string) => void;
  readonly journalLimit?: number;
  /** Both failure hooks throw after recording what they were told. */
  readonly failThrows?: boolean;
};

function harness(o: Harness = {}) {
  const gates: Gate[] = [];
  const rowGates: Gate[] = [];
  const failed: SeqEnvelope[] = [];
  const rowFailed: RelayRow[] = [];
  const causes: unknown[] = [];
  /** Runs once, inside the next persistence hook, before the hook returns. */
  const inside: { commit?: () => void; row?: () => void } = {};
  const hold = (into: Gate[], mode: 'gated' | 'void') => {
    if (mode === 'void') return undefined;
    let gate!: Gate;
    const p = new Promise<void>(
      (resolve, reject) => (gate = { resolve, reject }),
    );
    into.push(gate);
    return p;
  };
  const relay = createRelay({
    policy: o.cuts ? { verifyCitations: true } : undefined,
    onCommit: () => {
      const done = hold(gates, o.commit ?? 'gated');
      const run = inside.commit;
      inside.commit = undefined;
      run?.();
      return done;
    },
    onRow: () => {
      const done = hold(rowGates, o.row ?? 'void');
      const run = inside.row;
      inside.row = undefined;
      run?.();
      return done;
    },
    onDurabilityFailed: (_room, env, cause) => {
      failed.push(env);
      causes.push(cause);
      if (o.failThrows) throw new Error('observer threw');
    },
    onRowDurabilityFailed: (_room, row, cause) => {
      rowFailed.push(row);
      causes.push(cause);
      if (o.failThrows) throw new Error('observer threw');
    },
    onDrop: o.onDrop && ((_room, _env, reason) => o.onDrop?.(reason)),
    journalLimit: o.journalLimit,
  });
  if (o.snapshot) expect(relay.hydrate('r', o.snapshot)).toBe(true);
  /** `throwOn`: the socket's `send` throws for that message kind, and records only the rest. */
  const join = (origin: string, seq?: number, throwOn?: ServerMsg['t']) => {
    const got: ServerMsg[] = [];
    const conn: RelayConnection = relay.connect(
      {
        send: (m) => {
          if (m.t === throwOn) throw new Error('socket closed');
          got.push(m);
        },
      },
      { writer: origin },
    );
    conn.receive({
      t: 'hello',
      room: 'r',
      origin,
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
      seq,
    });
    const send = (env: OpEnvelope): void =>
      conn.receive({ t: 'env', room: 'r', env });
    return { got, conn, send };
  };
  return { relay, gates, rowGates, failed, rowFailed, causes, inside, join };
}

const instanceOf = (got: readonly ServerMsg[]): string => {
  const w = [...got].reverse().find((m) => m.t === 'welcome');
  return w?.t === 'welcome' ? w.instance : 'unwelcomed';
};

const envelope = (
  got: readonly ServerMsg[],
  origin: string,
  version: number,
  over?: Partial<OpEnvelope>,
): OpEnvelope => ({
  proto: MESH_PROTO_VERSION,
  instance: instanceOf(got),
  origin,
  writer: origin,
  version,
  hlc: { p: version, l: 0 },
  policyVersion: 0,
  ops: [
    version === 1
      ? { kind: 'set', path: [], next: { k: {} }, cites: [], epoch: 0 }
      : {
          kind: 'set',
          path: ['k', version],
          next: version,
          cites: [],
          epoch: 0,
        },
  ],
  ...over,
});

/** What a connection heard about one version, in order: its echo and its duplicate drops. */
const heard = (got: readonly ServerMsg[], origin: string, version: number) =>
  got.flatMap((m) =>
    m.t === 'env' && m.env.origin === origin && m.env.version === version
      ? ['env']
      : m.t === 'drop' && m.origin === origin && m.version === version
        ? [`drop ${m.reason}`]
        : [],
  );

describe('relay: a duplicate is acknowledged only once its row is durable', () => {
  it('a resend made before the row settles is answered after it, behind the echo', async () => {
    const h = harness();
    const a = h.join('a');
    const e1 = envelope(a.got, 'a', 1);
    a.send(e1);
    a.send(e1);
    await flush();
    expect(heard(a.got, 'a', 1)).toEqual([]);
    h.gates[0].resolve();
    await flush();
    expect(heard(a.got, 'a', 1)).toEqual(['env', 'drop duplicate']);
  });

  it('rows settled out of order: every echo and the held duplicate leave in seq order', async () => {
    const h = harness();
    const a = h.join('a');
    const e1 = envelope(a.got, 'a', 1);
    const e2 = envelope(a.got, 'a', 2);
    a.send(e1);
    a.send(e2);
    a.send(e2);
    h.gates[1].resolve();
    await flush();
    expect(heard(a.got, 'a', 2)).toEqual([]);
    h.gates[0].resolve();
    await flush();
    const order = a.got.flatMap((m) =>
      m.t === 'env'
        ? [`env ${m.env.version}`]
        : m.t === 'drop'
          ? [`drop ${m.version}`]
          : [],
    );
    expect(order).toEqual(['env 1', 'env 2', 'drop 2']);
    const seqs = a.got.flatMap((m) =>
      m.t === 'welcome' ? [m.seq] : m.t === 'env' ? [m.env.seq] : [],
    );
    expect(seqs).toEqual([0, 1, 2]);
  });

  it('a resend made before the row fails is never acknowledged; the echo stays held', async () => {
    const h = harness();
    const a = h.join('a');
    const e1 = envelope(a.got, 'a', 1);
    a.send(e1);
    a.send(e1);
    h.gates[0].reject(new Error('storage closed'));
    await flush();
    expect(h.failed.map((e) => e.version)).toEqual([1]);
    expect(h.relay.room('r')?.stalled).toBe(true);
    expect(heard(a.got, 'a', 1)).toEqual([]);
  });

  it('a resend made after the row failed is never acknowledged, and a discard sends nothing', async () => {
    const h = harness();
    const a = h.join('a');
    const e1 = envelope(a.got, 'a', 1);
    a.send(e1);
    h.gates[0].reject(new Error('storage closed'));
    await flush();
    expect(h.relay.room('r')?.stalled).toBe(true);
    a.send(e1);
    await flush();
    expect(heard(a.got, 'a', 1)).toEqual([]);
    const sent = a.got.length;
    a.conn.disconnect();
    expect(h.relay.unload('r', { discard: true })).toBe(true);
    await flush();
    expect(a.got).toHaveLength(sent);
    expect(h.failed).toHaveLength(1);
  });

  it('a resend of a durable row with nothing pending is answered before receive returns', async () => {
    const h = harness();
    const a = h.join('a');
    const e1 = envelope(a.got, 'a', 1);
    a.send(e1);
    h.gates[0].resolve();
    await flush();
    a.send(e1);
    expect(a.got[a.got.length - 1]).toMatchObject({
      t: 'drop',
      origin: 'a',
      version: 1,
      reason: 'duplicate',
    });
  });

  it("'generation', 'schema' and 'order' are answered before receive returns, with a row pending", async () => {
    const h = harness({
      snapshot: {
        seq: 3,
        schemaVersion: 2,
        ranges: {
          a: [
            [1, 1],
            [3, 3],
          ],
        },
      },
    });
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 4, { schemaVersion: 2 }));
    expect(h.gates).toHaveLength(1);
    const probes: [string, OpEnvelope][] = [
      ['generation', envelope(a.got, 'a', 5, { instance: 'elsewhere' })],
      ['schema', envelope(a.got, 'a', 5, { schemaVersion: 1 })],
      ['order', envelope(a.got, 'a', 2, { schemaVersion: 2 })],
    ];
    for (const [reason, env] of probes) {
      const at = a.got.length;
      a.send(env);
      expect(a.got.slice(at)).toEqual([
        expect.objectContaining({ t: 'drop', version: env.version, reason }),
      ]);
    }
    expect(heard(a.got, 'a', 4)).toEqual([]);
  });

  it("the client's reconnect: hello, the unacked write, the welcome, the write again", async () => {
    const h = harness();
    const first = h.join('a');
    const e1 = envelope(first.got, 'a', 1);
    first.send(e1);
    first.conn.disconnect();
    const again = h.join('a');
    again.send(e1);
    await flush();
    expect(again.got).toEqual([]);
    h.gates[0].resolve();
    await flush();
    expect(again.got.map((m) => m.t)).toEqual(['welcome', 'drop']);
    again.send(e1);
    expect(again.got.map((m) => (m.t === 'drop' ? m.reason : m.t))).toEqual([
      'welcome',
      'duplicate',
      'duplicate',
    ]);
  });
});

const envSeqs = (got: readonly ServerMsg[]): number[] =>
  got.flatMap((m) => (m.t === 'env' ? [m.env.seq] : []));

// A persistence hook runs after the room took the row in and may re-enter the relay synchronously
// (an in-process adapter, a member joining from inside it). Whatever it causes is released behind
// that row, and so after its durability; with a hook that returns nothing, all of it still leaves
// before `receive` returns.
describe('relay: what a persistence hook causes is released behind its row', () => {
  it('a gated commit hook that resends the envelope being committed: the duplicate waits for the row', async () => {
    const h = harness();
    const a = h.join('a');
    const e1 = envelope(a.got, 'a', 1);
    h.inside.commit = () => a.send(e1);
    a.send(e1);
    await flush();
    expect(heard(a.got, 'a', 1)).toEqual([]);
    h.gates[0].resolve();
    await flush();
    expect(heard(a.got, 'a', 1)).toEqual(['env', 'drop duplicate']);
  });

  it('a void commit hook that resends the envelope being committed: echo, then duplicate, in the same tick', () => {
    const h = harness({ commit: 'void' });
    const a = h.join('a');
    const e1 = envelope(a.got, 'a', 1);
    h.inside.commit = () => a.send(e1);
    a.send(e1);
    expect(heard(a.got, 'a', 1)).toEqual(['env', 'drop duplicate']);
  });

  it('a gated commit hook that lets the same origin reconnect: the delta welcome waits for the row', async () => {
    const h = harness();
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    h.gates[0].resolve();
    await flush();
    let again: ReturnType<typeof h.join> | undefined;
    h.inside.commit = () => (again = h.join('a', 1));
    a.send(envelope(a.got, 'a', 2));
    await flush();
    expect(again?.got).toEqual([]);
    h.gates[1].resolve();
    await flush();
    expect(again?.got).toEqual([
      expect.objectContaining({
        t: 'welcome',
        mode: 'delta',
        envs: [expect.objectContaining({ origin: 'a', version: 2 })],
      }),
    ]);
  });

  it('a void commit hook that lets the same origin reconnect: the delta welcome leaves in the same tick', async () => {
    const h = harness({ commit: 'void' });
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    let again: ReturnType<typeof h.join> | undefined;
    h.inside.commit = () => (again = h.join('a', 1));
    a.send(envelope(a.got, 'a', 2));
    expect(again?.got).toEqual([
      expect.objectContaining({
        t: 'welcome',
        mode: 'delta',
        envs: [expect.objectContaining({ origin: 'a', version: 2 })],
      }),
    ]);
  });

  for (const commit of ['gated', 'void'] as const) {
    it(`a ${commit} commit hook during which another member writes: every connection reads seqs in order`, async () => {
      const h = harness({ commit });
      const a = h.join('a');
      const b = h.join('b');
      h.inside.commit = () => b.send(envelope(b.got, 'b', 1));
      a.send(envelope(a.got, 'a', 1));
      for (const g of [...h.gates].reverse()) g.resolve();
      await flush();
      expect(envSeqs(a.got)).toEqual([1, 2]);
      expect(envSeqs(b.got)).toEqual([1, 2]);
    });
  }

  it('a held duplicate answer whose member was replaced by a same-origin hello reaches neither connection', async () => {
    const h = harness();
    const first = h.join('a');
    const e1 = envelope(first.got, 'a', 1);
    first.send(e1);
    first.send(e1);
    const second = h.join('a');
    h.gates[0].resolve();
    await flush();
    expect(heard(first.got, 'a', 1)).toEqual([]);
    expect(second.got.map((m) => m.t)).toEqual(['welcome']);
  });

  it('control, void hook: the duplicate answered at once stays with the connection that asked', () => {
    const h = harness({ commit: 'void' });
    const first = h.join('a');
    const e1 = envelope(first.got, 'a', 1);
    first.send(e1);
    first.send(e1);
    const second = h.join('a');
    expect(heard(first.got, 'a', 1)).toEqual(['env', 'drop duplicate']);
    expect(second.got.map((m) => m.t)).toEqual(['welcome']);
  });
});

const welcomes = (got: readonly ServerMsg[]) =>
  got.flatMap((m) => (m.t === 'welcome' ? [m] : []));

/** a#2 citing a dot no room holds: refused 'citation' once the citation gate is armed. */
const uncited = (got: readonly ServerMsg[]): OpEnvelope =>
  envelope(got, 'a', 2, {
    ops: [
      {
        kind: 'set',
        path: ['k'],
        next: 1,
        cites: [{ origin: 'zz', hlc: { p: 9, l: 0 } }],
        epoch: 0,
      },
    ],
  });

describe('relay: cut and refusal rows hold what their hook causes', () => {
  it('control: a cut taken while an envelope is pending re-welcomes only after that envelope is durable', async () => {
    const h = harness({ cuts: true });
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    expect(h.relay.cut('r', { reason: 'compaction' })).toBe(true);
    await flush();
    expect(welcomes(a.got)).toHaveLength(1);
    h.gates[0].resolve();
    await flush();
    expect(a.got.map((m) => m.t)).toEqual(['welcome', 'env', 'welcome']);
    const [, rewelcome] = welcomes(a.got);
    expect(rewelcome.mode).toBe('snapshot');
    if (rewelcome.mode !== 'snapshot') return;
    expect(rewelcome.receipts).toEqual({
      a: { [instanceOf([a.got[0]])]: [[1, 1]] },
    });
  });

  it('a gated cut row whose hook lets a member join: that welcome waits for the cut row', async () => {
    const h = harness({ cuts: true, commit: 'void', row: 'gated' });
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    let c: ReturnType<typeof h.join> | undefined;
    h.inside.row = () => (c = h.join('c'));
    expect(h.relay.cut('r', { reason: 'compaction' })).toBe(true);
    await flush();
    expect(c?.got).toEqual([]);
    expect(welcomes(a.got)).toHaveLength(1);
    h.rowGates[0].resolve();
    await flush();
    expect(welcomes(c?.got ?? [])).toHaveLength(1);
    expect(welcomes(a.got)).toHaveLength(2);
  });

  it('void cut row: nothing leaves while the hook runs; the re-welcome and the joiner welcome leave in the same tick', () => {
    const h = harness({ cuts: true, commit: 'void' });
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    let c: ReturnType<typeof h.join> | undefined;
    let during: { joiner: number; rewelcomes: number } | undefined;
    h.inside.row = () => {
      c = h.join('c');
      during = { joiner: c.got.length, rewelcomes: welcomes(a.got).length };
    };
    expect(h.relay.cut('r', { reason: 'compaction' })).toBe(true);
    expect(during).toEqual({ joiner: 0, rewelcomes: 1 });
    expect(welcomes(c?.got ?? [])).toHaveLength(1);
    expect(welcomes(a.got)).toHaveLength(2);
    expect(welcomes(c?.got ?? [])[0].instance).toBe(
      welcomes(a.got)[1].instance,
    );
  });

  it('a gated refusal row whose hook resends the refused envelope: neither answer precedes the row', async () => {
    const h = harness({ cuts: true, commit: 'void', row: 'gated' });
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    const bad = uncited(a.got);
    h.inside.row = () => a.send(bad);
    a.send(bad);
    await flush();
    expect(heard(a.got, 'a', 2)).toEqual([]);
    h.rowGates[0].resolve();
    await flush();
    expect(heard(a.got, 'a', 2)).toEqual(['drop citation', 'drop citation']);
  });

  it('void refusal row: nothing leaves while the hook runs; both answers leave in the same tick', () => {
    const h = harness({ cuts: true, commit: 'void' });
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    const bad = uncited(a.got);
    let during: string[] | undefined;
    h.inside.row = () => {
      a.send(bad);
      during = heard(a.got, 'a', 2);
    };
    a.send(bad);
    expect(during).toEqual([]);
    expect(heard(a.got, 'a', 2)).toEqual(['drop citation', 'drop citation']);
  });
});

const boom = new Error('hook threw');
const throwing = (): never => {
  throw boom;
};

/** What an adapter's `catch` around `call` reads, synchronously, with no await. */
const atThrow = (h: ReturnType<typeof harness>, call: () => unknown) => {
  try {
    call();
  } catch (cause) {
    return {
      cause,
      stalled: h.relay.room('r')?.stalled,
      failed: h.failed.length,
      rowFailed: h.rowFailed.length,
    };
  }
  return undefined;
};

type Listen = (event: 'unhandledRejection', fn: (c: unknown) => void) => void;
// the spec tsconfig carries no Node types; the suite runs in Node
const { process: node } = globalThis as unknown as {
  process: { on: Listen; off: Listen };
};

/** The rejections Node reports unhandled while `body` runs and for one macrotask after it. */
const unhandledOver = async (body: () => Promise<void>): Promise<unknown[]> => {
  const seen: unknown[] = [];
  const on = (cause: unknown): void => void seen.push(cause);
  node.on('unhandledRejection', on);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    node.off('unhandledRejection', on);
  }
  return seen;
};

// A hook that throws has not made its row durable: the room stalls on that row exactly as on a
// rejected promise, the failure is reported through the same hook, and the throw still reaches
// whoever called into the relay. The row stays admitted.
describe('relay: a persistence hook that throws has failed its row', () => {
  it('commit hook: the throw reaches the caller, the room stalls, onDurabilityFailed fires once, nothing is acknowledged', async () => {
    const h = harness({ commit: 'void' });
    const a = h.join('a');
    const e1 = envelope(a.got, 'a', 1);
    h.inside.commit = throwing;
    expect(atThrow(h, () => a.send(e1))).toEqual({
      cause: boom,
      stalled: true,
      failed: 1,
      rowFailed: 0,
    });
    expect(heard(a.got, 'a', 1)).toEqual([]);
    await flush();
    expect(h.relay.room('r')).toMatchObject({ stalled: true, seq: 1 });
    expect(h.failed.map((e) => e.version)).toEqual([1]);
    expect(h.causes).toEqual([boom]);
    a.send(e1);
    const b = h.join('b');
    await flush();
    expect(heard(a.got, 'a', 1)).toEqual([]);
    expect(b.got).toEqual([]);
    expect(h.failed).toHaveLength(1);
  });

  it('refusal row hook: the throw reaches the caller, the room stalls, onRowDurabilityFailed fires once, the refusal is never answered', async () => {
    const h = harness({ cuts: true, commit: 'void' });
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    const bad = uncited(a.got);
    h.inside.row = throwing;
    expect(atThrow(h, () => a.send(bad))).toEqual({
      cause: boom,
      stalled: true,
      failed: 0,
      rowFailed: 1,
    });
    expect(heard(a.got, 'a', 2)).toEqual([]);
    await flush();
    expect(h.relay.room('r')?.stalled).toBe(true);
    expect(h.rowFailed).toEqual([
      expect.objectContaining({
        kind: 'refuse',
        version: 2,
        reason: 'citation',
      }),
    ]);
    expect(h.failed).toEqual([]);
    expect(h.causes).toEqual([boom]);
    a.send(bad);
    await flush();
    expect(heard(a.got, 'a', 2)).toEqual([]);
    expect(h.rowFailed).toHaveLength(1);
  });

  it('cut row hook: the throw reaches the caller, the room stalls, onRowDurabilityFailed fires once, nothing the cut decided is answered', async () => {
    const h = harness({ cuts: true, commit: 'void' });
    const a = h.join('a');
    const e1 = envelope(a.got, 'a', 1);
    a.send(e1);
    h.inside.row = throwing;
    expect(
      atThrow(h, () => h.relay.cut('r', { reason: 'compaction' })),
    ).toEqual({ cause: boom, stalled: true, failed: 0, rowFailed: 1 });
    await flush();
    expect(h.relay.room('r')?.stalled).toBe(true);
    expect(h.rowFailed).toEqual([expect.objectContaining({ kind: 'cut' })]);
    expect(h.failed).toEqual([]);
    expect(h.causes).toEqual([boom]);
    // a resend into the cut's generation fence is refused 'generation', which acknowledges nothing
    a.send(e1);
    const c = h.join('c');
    await flush();
    expect(welcomes(a.got)).toHaveLength(1);
    expect(heard(a.got, 'a', 1)).toEqual(['env', 'drop generation']);
    expect(c.got).toEqual([]);
    expect(h.rowFailed).toHaveLength(1);
  });

  it('a throw inside another hook, behind a pending predecessor: stalls at once, and the rows ahead of it are never released', async () => {
    const h = harness();
    const a = h.join('a');
    const [e1, e2, e3] = [1, 2, 3].map((v) => envelope(a.got, 'a', v));
    a.send(e1);
    let caught: ReturnType<typeof atThrow>;
    h.inside.commit = () => {
      h.inside.commit = throwing;
      caught = atThrow(h, () => a.send(e3));
    };
    const seen = await unhandledOver(async () => {
      a.send(e2);
      await flush();
    });
    expect(caught).toEqual({
      cause: boom,
      stalled: true,
      failed: 1,
      rowFailed: 0,
    });
    expect(seen).toEqual([]);
    expect(h.failed.map((e) => e.version)).toEqual([3]);
    h.gates[1].resolve();
    h.gates[0].resolve();
    await flush();
    expect(envSeqs(a.got)).toEqual([]);
    expect(h.failed).toHaveLength(1);
    expect(h.causes).toEqual([boom]);
    a.send(e3);
    await flush();
    expect(heard(a.got, 'a', 3)).toEqual([]);
  });

  it('a throw behind a pending predecessor stalls at once; the predecessor settling later releases nothing and reports nothing', async () => {
    const h = harness();
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    h.inside.commit = throwing;
    expect(atThrow(h, () => a.send(envelope(a.got, 'a', 2)))).toEqual({
      cause: boom,
      stalled: true,
      failed: 1,
      rowFailed: 0,
    });
    h.gates[0].reject(new Error('storage closed'));
    await flush();
    expect(envSeqs(a.got)).toEqual([]);
    expect(h.failed.map((e) => e.version)).toEqual([2]);
    expect(h.causes).toEqual([boom]);
  });

  it('a rejection behind a pending row raises no unhandled rejection and is reported once the drain reaches it', async () => {
    const h = harness();
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    a.send(envelope(a.got, 'a', 2));
    const lost = new Error('storage closed');
    const seen = await unhandledOver(async () => {
      h.gates[1].reject(lost);
      await flush();
    });
    expect(seen).toEqual([]);
    expect(h.failed).toEqual([]);
    expect(h.relay.room('r')?.stalled).toBe(false);
    h.gates[0].resolve();
    await flush();
    expect(envSeqs(a.got)).toEqual([1]);
    expect(h.relay.room('r')?.stalled).toBe(true);
    expect(h.failed.map((e) => e.version)).toEqual([2]);
    expect(h.causes).toEqual([lost]);
  });
});

describe('relay: an onDrop that throws on a journaled refusal', () => {
  it('reaches the caller and leaves no open slot: the refusal is answered behind its row, a later envelope behind it', async () => {
    const h = harness({
      cuts: true,
      commit: 'void',
      row: 'gated',
      onDrop: (reason) => {
        if (reason === 'citation') throwing();
      },
    });
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    expect(() => a.send(uncited(a.got))).toThrow(boom);
    a.send(envelope(a.got, 'a', 3));
    await flush();
    expect(heard(a.got, 'a', 2)).toEqual([]);
    expect(heard(a.got, 'a', 3)).toEqual([]);
    h.rowGates[0].resolve();
    await flush();
    expect(heard(a.got, 'a', 2)).toEqual(['drop citation']);
    expect(heard(a.got, 'a', 3)).toEqual(['env']);
    expect(h.relay.room('r')?.stalled).toBe(false);
  });
});

/** The document traffic a connection read, in order. */
const doc = (got: readonly ServerMsg[]): string[] =>
  got.flatMap((m) =>
    m.t === 'env'
      ? [`env ${m.env.origin}#${m.env.version}@${m.env.seq}`]
      : m.t === 'welcome'
        ? [`welcome@${m.seq}`]
        : m.t === 'drop'
          ? [`drop ${m.reason} ${m.origin}#${m.version}`]
          : [],
  );

/**
 * Property R of relay-order.spec.ts: envelope seqs strictly increase on a connection, and a
 * welcome's seq is at or above every seq before it, equal only to the migration envelope whose cut
 * it announces. The first breach, or null.
 */
const breach = (got: readonly ServerMsg[]): string | null => {
  let prev: Extract<ServerMsg, { t: 'env' | 'welcome' }> | undefined;
  for (const m of got) {
    if (m.t !== 'env' && m.t !== 'welcome') continue;
    const seq = m.t === 'env' ? m.env.seq : m.seq;
    const last = prev?.t === 'env' ? prev.env.seq : prev?.seq;
    const announces =
      m.t === 'welcome' &&
      m.mode === 'snapshot' &&
      m.reason === 'migration' &&
      prev?.t === 'env' &&
      prev.env.instance !== m.instance;
    if (last !== undefined && (seq < last || (seq === last && !announces)))
      return `${m.t}@${seq} after ${last}`;
    prev = m;
  }
  return null;
};

// A hook whose re-entrant `receive` runs a hook of its own that re-enters again: a#2's hook makes
// b write b#1; b#1's hook resends a#2, lets c join and makes a write a#3; a#3's hook resends b#1.
describe('relay: hooks nested through re-entry', () => {
  const nest = (commit: 'gated' | 'void') => {
    const h = harness({ commit });
    const a = h.join('a');
    const b = h.join('b');
    a.send(envelope(a.got, 'a', 1));
    h.gates[0]?.resolve();
    const e2 = envelope(a.got, 'a', 2);
    const e3 = envelope(a.got, 'a', 3);
    const b1 = envelope(b.got, 'b', 1, {
      ops: [{ kind: 'set', path: ['b'], next: 1, cites: [], epoch: 0 }],
    });
    let c: ReturnType<typeof h.join> | undefined;
    h.inside.commit = () => {
      h.inside.commit = () => {
        a.send(e2);
        c = h.join('c');
        h.inside.commit = () => b.send(b1);
        a.send(e3);
      };
      b.send(b1);
    };
    return { h, a, b, c: () => c, e2 };
  };
  const want = {
    a: ['env a#2@2', 'env b#1@3', 'drop duplicate a#2', 'env a#3@4'],
    b: ['env a#2@2', 'env b#1@3', 'env a#3@4', 'drop duplicate b#1'],
    c: ['welcome@3', 'env a#3@4'],
  };

  it('void hooks: when the outermost receive returns, every connection has read everything, in order', async () => {
    const { a, b, c, e2 } = nest('void');
    const at = { a: a.got.length, b: b.got.length };
    a.send(e2);
    expect(doc(a.got.slice(at.a))).toEqual(want.a);
    expect(doc(b.got.slice(at.b))).toEqual(want.b);
    expect(doc(c()?.got ?? [])).toEqual(want.c);
    for (const p of [a, b, c()]) expect(breach(p?.got ?? [])).toBeNull();
  });

  it('gated hooks: nothing leaves before the outermost row is durable, then everything in order', async () => {
    const { h, a, b, c, e2 } = nest('gated');
    await flush();
    const at = { a: a.got.length, b: b.got.length };
    a.send(e2);
    expect(h.gates).toHaveLength(4);
    h.gates[3].resolve();
    h.gates[2].resolve();
    await flush();
    expect(doc(a.got.slice(at.a))).toEqual([]);
    expect(doc(b.got.slice(at.b))).toEqual([]);
    expect(doc(c()?.got ?? [])).toEqual([]);
    h.gates[1].resolve();
    await flush();
    expect(doc(a.got.slice(at.a))).toEqual(want.a);
    expect(doc(b.got.slice(at.b))).toEqual(want.b);
    expect(doc(c()?.got ?? [])).toEqual(want.c);
  });
});

// A migration is a cut whose row is its own envelope: the re-welcome it causes carries the
// envelope's seq. A resend made in its hook carries the closed generation and is refused at once.
describe('relay: a migration holds what its hook causes', () => {
  for (const commit of ['gated', 'void'] as const) {
    it(`a ${commit} migration hook during which the migrator resends and a member joins`, async () => {
      const h = harness({ commit });
      const a = h.join('a');
      a.send(envelope(a.got, 'a', 1));
      h.gates[0]?.resolve();
      await flush();
      const mig = envelope(a.got, 'a', 2, {
        schemaVersion: 1,
        ops: [{ kind: 'set', path: [], next: { k: 2 }, cites: [], epoch: 0 }],
      });
      const at = a.got.length;
      let c: ReturnType<typeof h.join> | undefined;
      let during: { a: string[]; c: string[] } | undefined;
      h.inside.commit = () => {
        a.send(mig);
        c = h.join('c');
        during = { a: doc(a.got.slice(at)), c: doc(c.got) };
      };
      a.send(mig);
      expect(during).toEqual({ a: ['drop generation a#2'], c: [] });
      if (commit === 'gated') {
        await flush();
        expect(doc(a.got.slice(at))).toEqual(['drop generation a#2']);
        expect(c?.got).toEqual([]);
        h.gates[1].resolve();
        await flush();
      }
      expect(doc(a.got.slice(at))).toEqual([
        'drop generation a#2',
        'env a#2@2',
        'welcome@2',
      ]);
      expect(doc(c?.got ?? [])).toEqual(['welcome@2']);
      expect(welcomes(a.got)[1]).toMatchObject({ reason: 'migration' });
      for (const p of [a, c]) expect(breach(p?.got ?? [])).toBeNull();
    });
  }
});

// A socket whose `send` throws inside a released item is the adapter's bug: it never reaches the
// caller, and later releases still go out. b joins first, so b is ahead of x in every audience.
describe('relay: a socket that throws on a released message', () => {
  it('on its echo: nothing propagates, and later echoes still reach the other member', () => {
    const h = harness({ commit: 'void' });
    const b = h.join('b');
    const x = h.join('x', undefined, 'env');
    expect(() => b.send(envelope(b.got, 'b', 1))).not.toThrow();
    expect(() => x.send(envelope(x.got, 'x', 2))).not.toThrow();
    b.send(envelope(b.got, 'b', 3));
    expect(envSeqs(b.got)).toEqual([1, 2, 3]);
  });

  it('on its welcome: nothing propagates, and the room goes on answering', () => {
    const h = harness({ commit: 'void' });
    const b = h.join('b');
    expect(() => h.join('x', undefined, 'welcome')).not.toThrow();
    b.send(envelope(b.got, 'b', 1));
    expect(envSeqs(b.got)).toEqual([1]);
  });

  it('on a duplicate answered at once: nothing propagates, and the room goes on answering', () => {
    const h = harness({ commit: 'void' });
    const b = h.join('b');
    const x = h.join('x', undefined, 'drop');
    const x1 = envelope(x.got, 'x', 1);
    x.send(x1);
    expect(() => x.send(x1)).not.toThrow();
    b.send(envelope(b.got, 'b', 2));
    expect(envSeqs(b.got)).toEqual([1, 2]);
    expect(envSeqs(x.got)).toEqual([1, 2]);
  });
});

describe('relay: a persistence hook seen from the rest of the room', () => {
  it('a member joining inside a gated commit hook: the others hear the membership before the echo', async () => {
    const h = harness();
    const a = h.join('a');
    const b = h.join('b');
    h.inside.commit = () => void h.join('c');
    a.send(envelope(a.got, 'a', 1));
    const kinds = (got: readonly ServerMsg[]) =>
      got.flatMap((m) => (m.t === 'member' || m.t === 'env' ? [m.t] : []));
    expect(kinds(a.got).slice(-1)).toEqual(['member']);
    h.gates[0].resolve();
    await flush();
    expect(kinds(a.got).slice(-2)).toEqual(['member', 'env']);
    expect(kinds(b.got).slice(-2)).toEqual(['member', 'env']);
  });

  it('unload from inside a void hook, after the only member left: refused, the row still holds its place', () => {
    const h = harness({ commit: 'void' });
    const a = h.join('a');
    let unloaded: boolean | undefined;
    h.inside.commit = () => {
      a.conn.disconnect();
      unloaded = h.relay.unload('r');
    };
    a.send(envelope(a.got, 'a', 1));
    expect(unloaded).toBe(false);
    expect(h.relay.room('r')).toMatchObject({ seq: 1, members: 0 });
    expect(h.relay.unload('r')).toBe(true);
  });
});

describe('relay: disconnect when a room throws on the way out', () => {
  it("a cut row hook that throws in one room's census: every room drops the member, then the throw reaches the caller", () => {
    const relay = createRelay({
      policy: { verifyCitations: true },
      compaction: { consensus: true },
      onRow: throwing,
    });
    const open = (writer: string) => {
      const got: ServerMsg[] = [];
      const conn = relay.connect({ send: (m) => void got.push(m) }, { writer });
      const hello = (room: string): void =>
        conn.receive({
          t: 'hello',
          room,
          origin: writer,
          proto: MESH_PROTO_VERSION,
          policyVersion: 0,
        });
      return { got, conn, hello };
    };
    const c = open('c');
    const d = open('d');
    c.hello('r1');
    c.hello('r2');
    d.hello('r1');
    for (const room of ['r1', 'r2']) {
      const env = envelope(
        c.got.filter((m) => m.room === room),
        'c',
        1,
      );
      c.conn.receive({ t: 'env', room, env });
    }
    const r1 = relay.room('r1')?.instance ?? '';
    d.conn.receive({ t: 'compact', room: 'r1', instance: r1, ready: true });
    expect(relay.room('r1')?.instance).toBe(r1);
    expect(() => c.conn.disconnect()).toThrow(boom);
    expect(relay.room('r1')).toMatchObject({ members: 1, stalled: true });
    expect(relay.room('r2')).toMatchObject({ members: 0, seq: 1 });
    expect(relay.unload('r2')).toBe(true);
  });
});

// One member's throwing socket never costs another member a message: x joins first, so x is the
// first socket of every fan-out, and b and c come after it.
describe('relay: a throwing socket in a fan-out', () => {
  const three = (o: Harness, throwOn: ServerMsg['t']) => {
    const h = harness({ commit: 'void', ...o });
    const x = h.join('x', undefined, throwOn);
    const b = h.join('b');
    const c = h.join('c');
    return { h, x, b, c };
  };

  it('on the echo: the other members both read it, in order, and what follows', () => {
    const { b, c } = three({}, 'env');
    expect(() => b.send(envelope(b.got, 'b', 1))).not.toThrow();
    b.send(envelope(b.got, 'b', 2));
    expect(envSeqs(b.got)).toEqual([1, 2]);
    expect(envSeqs(c.got)).toEqual([1, 2]);
  });

  it('on a settled notice: the other members both read it after its echo, and what follows', () => {
    const { b, c } = three({ journalLimit: 1 }, 'settled');
    b.send(envelope(b.got, 'b', 1));
    expect(() => b.send(envelope(b.got, 'b', 2))).not.toThrow();
    b.send(envelope(b.got, 'b', 3));
    const read = (got: readonly ServerMsg[]) =>
      got.flatMap((m) =>
        m.t === 'env'
          ? [`env@${m.env.seq}`]
          : m.t === 'settled'
            ? ['settled']
            : [],
      );
    for (const p of [b, c])
      expect(read(p.got)).toEqual([
        'env@1',
        'env@2',
        'settled',
        'env@3',
        'settled',
      ]);
  });

  it('on a cut re-welcome: the other members are both re-welcomed, and read what follows', () => {
    const { h, b, c } = three({ cuts: true }, 'welcome');
    b.send(envelope(b.got, 'b', 1));
    expect(() => h.relay.cut('r', { reason: 'compaction' })).not.toThrow();
    for (const p of [b, c]) expect(welcomes(p.got)).toHaveLength(2);
    b.send(envelope(b.got, 'b', 2, { instance: welcomes(b.got)[1].instance }));
    expect(envSeqs(b.got)).toEqual([1, 3]);
    expect(envSeqs(c.got)).toEqual([1, 3]);
  });

  it('on a membership broadcast: the other members hear the join, and the joiner is welcomed', () => {
    const { h, b, c } = three({}, 'member');
    let d: ReturnType<typeof h.join> | undefined;
    expect(() => (d = h.join('d'))).not.toThrow();
    const joins = (got: readonly ServerMsg[]) =>
      got.flatMap((m) => (m.t === 'member' && !m.gone ? [m.origin] : []));
    expect(joins(b.got)).toEqual(['c', 'd']);
    expect(joins(c.got)).toEqual(['d']);
    expect(welcomes(d?.got ?? [])).toHaveLength(1);
  });
});

// A failure hook is an observer: whatever it throws, the room is stalled, the cause the caller
// sees is the persistence hook's own, and nothing escapes as an unhandled rejection.
describe('relay: a failure hook that throws', () => {
  it('after a throwing commit hook: the caller catches the commit hook error, the room is stalled', () => {
    const h = harness({ commit: 'void', failThrows: true });
    const a = h.join('a');
    h.inside.commit = throwing;
    expect(atThrow(h, () => a.send(envelope(a.got, 'a', 1)))).toEqual({
      cause: boom,
      stalled: true,
      failed: 1,
      rowFailed: 0,
    });
  });

  it('after a rejected commit promise: no unhandled rejection, the room is stalled, nothing is released', async () => {
    const h = harness({ failThrows: true });
    const a = h.join('a');
    a.send(envelope(a.got, 'a', 1));
    a.send(envelope(a.got, 'a', 2));
    const seen = await unhandledOver(async () => {
      h.gates[0].reject(new Error('storage closed'));
      await flush();
    });
    expect(seen).toEqual([]);
    expect(h.relay.room('r')?.stalled).toBe(true);
    expect(h.failed.map((e) => e.version)).toEqual([1]);
    h.gates[1].resolve();
    await flush();
    expect(envSeqs(a.got)).toEqual([]);
  });
});
