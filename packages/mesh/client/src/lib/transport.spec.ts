import {
  createRelay,
  type RegisterCheckpoint,
  type ServerMsg,
} from '@mmstack/mesh-protocol';
import { agentSeat } from './agent-seat';
import {
  directTransport,
  webSocketTransport,
  type MeshTransportFactory,
} from './transport';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    instances.push(this);
  }
  send(frame: string): void {
    this.sent.push(frame);
  }
  close(): void {
    /* noop */
  }
}
let instances: FakeWebSocket[] = [];

describe('webSocketTransport', () => {
  const realWebSocket = globalThis.WebSocket;
  beforeEach(() => {
    instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });
  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  it('drops a malformed (non-JSON) frame without throwing, and delivers valid ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const transport = webSocketTransport('ws://relay.test')();
      const ws = instances[0];
      const received: unknown[] = [];
      transport.onMessage((m) => received.push(m));

      expect(() => ws.onmessage?.({ data: 'not json{' })).not.toThrow();
      expect(received).toEqual([]);

      ws.onmessage?.({ data: JSON.stringify({ t: 'welcome', room: 'r' }) });
      expect(received).toEqual([{ t: 'welcome', room: 'r' }]);
    } finally {
      warn.mockRestore();
    }
  });

  it('passes the close code and reason to onClose listeners', () => {
    const transport = webSocketTransport('ws://relay.test')();
    const closes: [number, string][] = [];
    transport.onClose((code, reason) => closes.push([code, reason]));
    instances[0].onclose?.({ code: 1009, reason: 'message too big' });
    expect(closes).toEqual([[1009, 'message too big']]);
  });
});

describe('directTransport', () => {
  /**
   * A socket peer's messages cross as JSON text, which drops object keys holding `undefined` and
   * turns such array slots into `null`. A direct peer must leave the relay, and receive from it,
   * exactly what a socket peer would; otherwise the two kinds of peer hold different states.
   */
  it('carries messages both ways as JSON would', async () => {
    let registers: readonly RegisterCheckpoint[] = [];
    const relay = createRelay({
      onCommit: (_room, _env, state) => {
        registers = state.checkpoint();
      },
    });
    const inbound: ServerMsg[] = [];
    const inner = directTransport(relay, { writer: 'w', kind: 'agent' });
    const transport: MeshTransportFactory = () => {
      const t = inner();
      t.onMessage((m) => inbound.push(m));
      return t;
    };
    const s = agentSeat<{ tasks: Record<string, unknown> }>(
      { tasks: {} },
      { room: 'direct-json', writer: 'w', transport },
    );
    await Promise.resolve();
    s.setAtPath('tasks.t1', {
      title: 't',
      note: undefined,
      tags: ['a', undefined],
    });
    await s.whenAcked();

    expect(registers.length).toBeGreaterThan(0);
    expect(registers).toEqual(JSON.parse(JSON.stringify(registers)));
    expect(inbound.length).toBeGreaterThan(0);
    expect(inbound).toEqual(JSON.parse(JSON.stringify(inbound)));
  });

  it('byReference: the relay’s messages reach the peer as the relay’s own objects; the peer’s still cross as JSON', async () => {
    let registers: readonly RegisterCheckpoint[] = [];
    const relay = createRelay({
      onCommit: (_room, _env, state) => {
        registers = state.checkpoint();
      },
    });
    const inbound: ServerMsg[] = [];
    const inner = directTransport(
      relay,
      { writer: 'w', kind: 'agent' },
      { byReference: true },
    );
    const transport: MeshTransportFactory = () => {
      const t = inner();
      t.onMessage((m) => inbound.push(m));
      return t;
    };
    const s = agentSeat<{ tasks: Record<string, unknown> }>(
      { tasks: {} },
      { room: 'direct-ref', writer: 'w', transport },
    );
    await Promise.resolve();
    s.setAtPath('tasks.t1', {
      title: 't',
      note: undefined,
      tags: ['a', undefined],
    });
    await s.whenAcked();

    // outbound: still the JSON hop — the relay never saw the `undefined`s
    expect(registers).toEqual(JSON.parse(JSON.stringify(registers)));
    // inbound: the echo's envelope is the relay's object, not a copy of it
    type Echo = { t: 'env'; env: { ops: readonly { next?: unknown }[] } };
    const held = inbound
      .filter((m): m is Echo => m.t === 'env')
      .flatMap((m) => m.env.ops.map((op) => op.next))
      .find((next) => (next as { title?: unknown } | undefined)?.title === 't');
    expect(held).toEqual({ title: 't', tags: ['a', null] });
    const sibling = registers
      .flatMap((r) => r.siblings)
      .find((x) => x.kind === 'set' && x.value === held);
    expect(
      sibling,
      'the peer holds the very object the relay retained',
    ).toBeDefined();
  });

  it('reports a normal close (1000, empty reason)', () => {
    const transport = directTransport(createRelay(), { writer: 'w' })();
    const closes: [number, string][] = [];
    transport.onClose((code, reason) => closes.push([code, reason]));
    transport.close();
    expect(closes).toEqual([[1000, '']]);
  });
});
