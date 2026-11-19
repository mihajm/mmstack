import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { sse, streamResource, websocket } from './stream-resource';
import { provideMockResourceSensors } from './util';

type Listener = (ev: MessageEvent) => void;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: Listener | null = null;
  onerror: (() => void) | null = null;
  named = new Map<string, Listener>();
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.all.push(this);
  }
  addEventListener(name: string, fn: Listener) {
    this.named.set(name, fn);
  }
  close() {
    this.closed = true;
  }
  message(data: string, event?: string) {
    const ev = { data } as MessageEvent;
    if (event) this.named.get(event)?.(ev);
    else this.onmessage?.(ev);
  }
}

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: Listener | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: unknown[] = [];
  closeCalls = 0;
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.all.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls++;
    this.onclose?.({ code: 1000 });
  }
  message(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const es = () => FakeEventSource.all.at(-1)!;
const ws = () => FakeWebSocket.all.at(-1)!;
const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
  }
};
const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.all = [];
  FakeWebSocket.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'browser' },
      provideMockResourceSensors(),
    ],
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sse transport', () => {
  it('opens, parses JSON messages and closes on abort', async () => {
    const res = run(() =>
      streamResource(() => 'https://x/sse', { transport: sse() }),
    );
    await settle();
    expect(es().init?.withCredentials).toBeUndefined();
    es().onopen?.();
    expect(res.connected()).toBe(true);
    es().message('{"n":1}');
    await settle();
    expect(res.value()).toEqual({ n: 1 });
    res.abort();
    await settle();
    expect(es().closed).toBe(true);
  });

  it('uses a custom deserializer, a named event and withCredentials', async () => {
    const res = run(() =>
      streamResource(() => 'https://x/sse', {
        transport: sse({
          event: 'tick',
          withCredentials: true,
          deserialize: (d) => d.toUpperCase(),
        }),
      }),
    );
    await settle();
    expect(es().init?.withCredentials).toBe(true);
    es().message('a');
    es().message('b', 'tick');
    await settle();
    expect(res.value()).toBe('B');
  });

  it('a poison message closes the source and reconnects after backoff', async () => {
    const onError = vi.fn();
    run(() =>
      streamResource(() => 'https://x/sse', {
        transport: sse(),
        onError,
        reconnect: { backoff: 100 },
      }),
    );
    await settle();
    const first = es();
    first.message('not json');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(first.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeEventSource.all.length).toBe(2);
  });

  it('an error closes the native source (no native auto-reconnect)', async () => {
    const onError = vi.fn();
    run(() =>
      streamResource(() => 'https://x/sse', {
        transport: sse(),
        onError,
        reconnect: 0,
      }),
    );
    await settle();
    es().onerror?.();
    expect(es().closed).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('websocket transport', () => {
  it('opens, parses, forwards protocols and serializes sends', async () => {
    const res = run(() =>
      streamResource(() => 'wss://x/ws', {
        transport: websocket<{ n: number }, { q: number }>({ protocols: 'p1' }),
      }),
    );
    await settle();
    expect(ws().protocols).toBe('p1');
    ws().onopen?.();
    expect(res.connected()).toBe(true);
    ws().message('{"n":2}');
    await settle();
    expect(res.value()).toEqual({ n: 2 });
    expect(res.send({ q: 1 })).toBe(true);
    expect(ws().sent).toEqual(['{"q":1}']);
  });

  it('custom serialize and deserialize win', async () => {
    const res = run(() =>
      streamResource(() => 'wss://x/ws', {
        transport: websocket<string, string>({
          deserialize: (e) => `in:${e.data}`,
          serialize: (m) => `out:${m}`,
        }),
      }),
    );
    await settle();
    ws().onopen?.();
    ws().message('a');
    await settle();
    expect(res.value()).toBe('in:a');
    res.send('b');
    expect(ws().sent).toEqual(['out:b']);
  });

  it('a server drop fails and reconnects', async () => {
    const onError = vi.fn();
    run(() =>
      streamResource(() => 'wss://x/ws', {
        transport: websocket(),
        onError,
        reconnect: { backoff: 100 },
      }),
    );
    await settle();
    ws().onopen?.();
    ws().onclose?.({ code: 1006 });
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWebSocket.all.length).toBe(2);
  });

  it('a poison message closes the socket once and fails once', async () => {
    const onError = vi.fn();
    run(() =>
      streamResource(() => 'wss://x/ws', {
        transport: websocket(),
        onError,
        reconnect: { backoff: 100 },
      }),
    );
    await settle();
    const first = ws();
    first.onopen?.();
    first.message('x');
    expect(first.closeCalls).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(FakeWebSocket.all.length).toBe(2);
  });

  it('our own close on abort or pause is silent', async () => {
    const onError = vi.fn();
    const paused = signal(false);
    const res = run(() =>
      streamResource(() => 'wss://x/ws', {
        transport: websocket(),
        onError,
        pause: paused,
      }),
    );
    await settle();
    ws().onopen?.();
    paused.set(true);
    await settle();
    expect(ws().closeCalls).toBe(1);
    paused.set(false);
    await settle();
    ws().onopen?.();
    res.abort();
    await settle();
    expect(ws().closeCalls).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
