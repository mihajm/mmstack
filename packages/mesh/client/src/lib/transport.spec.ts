import { webSocketTransport } from './transport';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
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
});
