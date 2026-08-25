import {
  Injector,
  PLATFORM_ID,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  injectTransitionScope,
  providePaused,
  provideTransitionScope,
} from '@mmstack/primitives';
import {
  streamResource,
  type BidiStreamTransport,
  type StreamTransport,
  type StreamTransportContext,
} from './stream-resource';
import { ResourceSensors } from './util';

type Msg = { n: number };

function fakeTransport() {
  const connections: {
    url: string;
    ctx: StreamTransportContext<Msg>;
    closed: boolean;
  }[] = [];
  const transport: StreamTransport<Msg> = (ctx) => {
    const conn = { url: ctx.url, ctx, closed: false };
    connections.push(conn);
    return {
      close: () => {
        conn.closed = true;
      },
    };
  };
  return {
    transport,
    connections,
    get last() {
      return connections[connections.length - 1];
    },
  };
}

function fakeBidiTransport() {
  const connections: {
    url: string;
    ctx: StreamTransportContext<Msg>;
    closed: boolean;
    sent: string[];
  }[] = [];
  const transport: BidiStreamTransport<Msg, string> = (ctx) => {
    const conn = { url: ctx.url, ctx, closed: false, sent: [] as string[] };
    connections.push(conn);
    return {
      close: () => {
        conn.closed = true;
      },
      send: (m) => conn.sent.push(m),
    };
  };
  return {
    transport,
    connections,
    get last() {
      return connections[connections.length - 1];
    },
  };
}

describe('streamResource', () => {
  let online: WritableSignal<boolean>;

  function configure(platform: 'browser' | 'server' = 'browser') {
    online = signal(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: platform },
        { provide: ResourceSensors, useValue: { networkStatus: online } },
        provideTransitionScope(),
      ],
    });
  }

  afterEach(() => vi.useRealTimers());

  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    TestBed.tick();
  };

  it('is loading until the FIRST message, then tracks every message as the value', async () => {
    configure();
    const t = fakeTransport();
    const res = TestBed.runInInjectionContext(() =>
      streamResource<Msg>(() => 'wss://x/feed', { transport: t.transport }),
    );
    TestBed.tick();

    expect(t.connections.length).toBe(1);
    expect(res.status()).toBe('loading');
    expect(res.connected()).toBe(false);

    t.last.ctx.open();
    expect(res.connected()).toBe(true);
    expect(res.status()).toBe('loading');

    t.last.ctx.emit({ n: 1 });
    await settle();
    expect(res.status()).toBe('resolved');
    expect(res.value()).toEqual({ n: 1 });

    t.last.ctx.emit({ n: 2 });
    expect(res.value()).toEqual({ n: 2 });
  });

  it('a reactive source change tears the old connection down and connects anew', async () => {
    configure();
    const t = fakeTransport();
    const url = signal<string | undefined>('wss://x/a');
    const res = TestBed.runInInjectionContext(() =>
      streamResource<Msg>(url, { transport: t.transport }),
    );
    TestBed.tick();
    t.last.ctx.open();
    t.last.ctx.emit({ n: 1 });
    await settle();

    url.set('wss://x/b');
    TestBed.tick();
    expect(t.connections[0].closed).toBe(true);
    expect(t.connections.length).toBe(2);
    expect(t.last.url).toBe('wss://x/b');

    t.last.ctx.emit({ n: 9 });
    await settle();
    expect(res.value()).toEqual({ n: 9 });

    url.set(undefined);
    TestBed.tick();
    expect(t.last.closed).toBe(true);
    expect(res.status()).toBe('idle');
  });

  it('reconnects with exponential backoff, holding the last value through the gap', async () => {
    vi.useFakeTimers();
    configure();
    const t = fakeTransport();
    const errors: unknown[] = [];
    const res = TestBed.runInInjectionContext(() =>
      streamResource<Msg>(() => 'wss://x/feed', {
        transport: t.transport,
        reconnect: { max: 5, backoff: 1000 },
        onError: (e) => errors.push(e),
      }),
    );
    TestBed.tick();
    t.last.ctx.open();
    t.last.ctx.emit({ n: 1 });
    await settle();

    t.last.ctx.fail(new Error('dropped'));
    expect(res.connected()).toBe(false);
    expect(res.value()).toEqual({ n: 1 });
    expect(res.status()).toBe('resolved');
    expect(t.connections.length).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(t.connections.length).toBe(2);

    t.last.ctx.fail(new Error('still down'));
    vi.advanceTimersByTime(1000);
    expect(t.connections.length).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(t.connections.length).toBe(3);

    t.last.ctx.open();
    t.last.ctx.fail(new Error('dropped again'));
    vi.advanceTimersByTime(1000);
    expect(t.connections.length).toBe(4);

    expect(errors.length).toBe(3);
  });

  it('exhausted retries surface as status error; reload() starts fresh', async () => {
    vi.useFakeTimers();
    configure();
    const t = fakeTransport();
    const res = TestBed.runInInjectionContext(() =>
      streamResource<Msg>(() => 'wss://x/feed', {
        transport: t.transport,
        reconnect: 1,
      }),
    );
    TestBed.tick();
    t.last.ctx.fail(new Error('refused'));
    vi.advanceTimersByTime(1000);
    t.last.ctx.fail(new Error('refused again'));
    await settle();
    expect(res.status()).toBe('error');
    expect(res.error()).toBeInstanceOf(Error);

    res.reload();
    TestBed.tick();
    expect(t.connections.length).toBe(3);
    t.last.ctx.open();
    t.last.ctx.emit({ n: 7 });
    await settle();
    expect(res.status()).toBe('resolved');
    expect(res.value()).toEqual({ n: 7 });
  });

  it('reconnect: 0 is single-shot — the first failure is final', async () => {
    configure();
    const t = fakeTransport();
    const res = TestBed.runInInjectionContext(() =>
      streamResource<Msg>(() => 'wss://x/feed', {
        transport: t.transport,
        reconnect: 0,
      }),
    );
    TestBed.tick();
    t.last.ctx.fail(new Error('no'));
    await settle();
    expect(res.status()).toBe('error');
    expect(t.connections.length).toBe(1);
  });

  it('waits for the network: no attempts while offline, immediate fresh connect on regain', async () => {
    configure();
    online.set(false);
    const t = fakeTransport();
    TestBed.runInInjectionContext(() =>
      streamResource<Msg>(() => 'wss://x/feed', { transport: t.transport }),
    );
    TestBed.tick();
    expect(t.connections.length).toBe(0);

    online.set(true);
    TestBed.tick();
    await Promise.resolve();
    expect(t.connections.length).toBe(1);
  });

  it('abort() disconnects and STAYS disconnected, keeping the value (status local)', async () => {
    configure();
    const t = fakeTransport();
    const res = TestBed.runInInjectionContext(() =>
      streamResource<Msg>(() => 'wss://x/feed', { transport: t.transport }),
    );
    TestBed.tick();
    t.last.ctx.open();
    t.last.ctx.emit({ n: 3 });
    await settle();

    res.abort();
    expect(t.last.closed).toBe(true);
    expect(res.connected()).toBe(false);
    expect(res.value()).toEqual({ n: 3 });
    expect(res.status()).toBe('local');
    expect(t.connections.length).toBe(1);

    res.reload();
    TestBed.tick();
    expect(t.connections.length).toBe(2);
  });

  it('participates in a transition scope like any resource (register + abortPending)', () => {
    configure();
    const t = fakeTransport();
    const { res, scope } = TestBed.runInInjectionContext(() => ({
      res: streamResource<Msg>(() => 'wss://x/feed', {
        transport: t.transport,
        register: 'indicator',
      }),
      scope: injectTransitionScope(),
    }));
    TestBed.tick();
    expect(scope.pending()).toBe(true);

    expect(scope.abortPending()).toBe(1);
    expect(t.last.closed).toBe(true);
    expect(res.status()).toBe('local');
    expect(scope.pending()).toBe(false);
  });

  it('never connects on the server (a stream would wedge SSR serialization)', () => {
    configure('server');
    const t = fakeTransport();
    const res = TestBed.runInInjectionContext(() =>
      streamResource<Msg>(() => 'wss://x/feed', { transport: t.transport }),
    );
    TestBed.tick();
    expect(t.connections.length).toBe(0);
    expect(res.status()).toBe('idle');
  });

  describe('pause', () => {
    it('predicate: closes the live connection, keeps value + status, reconnects on resume with a fresh ladder', async () => {
      configure();
      const t = fakeTransport();
      const paused = signal(false);
      const res = TestBed.runInInjectionContext(() =>
        streamResource<Msg>(() => 'wss://x/feed', {
          transport: t.transport,
          pause: paused,
        }),
      );
      TestBed.tick();
      t.last.ctx.open();
      t.last.ctx.emit({ n: 1 });
      await settle();
      expect(res.connected()).toBe(true);

      paused.set(true);
      TestBed.tick();
      expect(t.connections.length).toBe(1);
      expect(t.last.closed).toBe(true);
      expect(res.connected()).toBe(false);
      expect(res.status()).toBe('resolved');
      expect(res.value()).toEqual({ n: 1 });

      paused.set(false);
      await settle();
      expect(t.connections.length).toBe(2);
      expect(t.last.closed).toBe(false);
      t.last.ctx.open();
      t.last.ctx.emit({ n: 2 });
      await settle();
      expect(res.connected()).toBe(true);
      expect(res.value()).toEqual({ n: 2 });
    });

    it('pausing mid-backoff cancels the pending retry; resume connects immediately', async () => {
      vi.useFakeTimers();
      configure();
      const t = fakeTransport();
      const paused = signal(false);
      TestBed.runInInjectionContext(() =>
        streamResource<Msg>(() => 'wss://x/feed', {
          transport: t.transport,
          pause: paused,
        }),
      );
      TestBed.tick();
      t.last.ctx.fail(new Error('drop'));
      expect(t.connections.length).toBe(1);

      paused.set(true);
      TestBed.tick();
      vi.advanceTimersByTime(60_000);
      expect(t.connections.length).toBe(1);

      paused.set(false);
      await settle();
      expect(t.connections.length).toBe(2);
    });

    it('starts paused: no connection until resumed', async () => {
      configure();
      const t = fakeTransport();
      const paused = signal(true);
      const res = TestBed.runInInjectionContext(() =>
        streamResource<Msg>(() => 'wss://x/feed', {
          transport: t.transport,
          pause: paused,
        }),
      );
      TestBed.tick();
      expect(t.connections.length).toBe(0);
      expect(res.status()).toBe('loading');

      paused.set(false);
      await settle();
      expect(t.connections.length).toBe(1);
    });

    it('abort() while paused sticks: no reconnect on resume', async () => {
      configure();
      const t = fakeTransport();
      const paused = signal(false);
      const res = TestBed.runInInjectionContext(() =>
        streamResource<Msg>(() => 'wss://x/feed', {
          transport: t.transport,
          pause: paused,
        }),
      );
      TestBed.tick();
      t.last.ctx.open();
      t.last.ctx.emit({ n: 1 });
      await settle();

      paused.set(true);
      TestBed.tick();
      res.abort();
      await settle();
      expect(res.status()).toBe('local');

      paused.set(false);
      await settle();
      expect(t.connections.length).toBe(1);
      expect(res.value()).toEqual({ n: 1 });
    });

    it('pause: true follows the ambient Activity boundary', async () => {
      configure();
      const boundary = signal(true);
      const t = fakeTransport();
      const injector = Injector.create({
        providers: [providePaused(boundary)],
        parent: TestBed.inject(Injector),
      });
      TestBed.runInInjectionContext(() =>
        streamResource<Msg>(() => 'wss://x/feed', {
          transport: t.transport,
          pause: true,
          injector,
        }),
      );
      TestBed.tick();
      expect(t.connections.length).toBe(0);

      boundary.set(false);
      await settle();
      expect(t.connections.length).toBe(1);
    });
  });

  describe('bidi (send)', () => {
    it('a read-only transport yields a ref without send', () => {
      configure();
      const t = fakeTransport();
      const res = TestBed.runInInjectionContext(() =>
        streamResource<Msg>(() => 'wss://x/feed', { transport: t.transport }),
      );
      // @ts-expect-error read-only streams have no send
      const send: unknown = res.send;
      // runtime seam exists on every stream; only the type gates it
      expect(send).toBeTypeOf('function');
    });

    it('delivers to the live connection; drops (false) while disconnected by default', async () => {
      configure();
      const t = fakeBidiTransport();
      const res = TestBed.runInInjectionContext(() =>
        streamResource<Msg, string>(() => 'wss://x/feed', {
          transport: t.transport,
        }),
      );
      TestBed.tick();
      expect(res.send('early')).toBe(false);

      t.last.ctx.open();
      expect(res.send('hi')).toBe(true);
      expect(t.last.sent).toEqual(['hi']);

      t.last.ctx.fail(new Error('drop'));
      expect(res.send('gone')).toBe(false);
      expect(t.last.sent).toEqual(['hi']);
    });

    it('outbox: queues while disconnected (incl. paused) and flushes in order on open', async () => {
      configure();
      const t = fakeBidiTransport();
      const paused = signal(false);
      const res = TestBed.runInInjectionContext(() =>
        streamResource<Msg, string>(() => 'wss://x/feed', {
          transport: t.transport,
          outbox: true,
          pause: paused,
        }),
      );
      TestBed.tick();
      expect(res.send('a')).toBe(true);
      expect(res.send('b')).toBe(true);
      t.last.ctx.open();
      expect(t.last.sent).toEqual(['a', 'b']);

      paused.set(true);
      TestBed.tick();
      expect(res.send('c')).toBe(true);
      paused.set(false);
      await settle();
      t.last.ctx.open();
      expect(t.last.sent).toEqual(['c']);
    });

    it('flushes the outbox even when the transport opens synchronously', async () => {
      configure();
      const sent: string[] = [];
      const transport: BidiStreamTransport<Msg, string> = (ctx) => {
        ctx.open();
        return { close: () => undefined, send: (m) => sent.push(m) };
      };
      const res = TestBed.runInInjectionContext(() =>
        streamResource<Msg, string>(() => 'wss://x/feed', {
          transport,
          outbox: true,
        }),
      );
      res.send('queued');
      TestBed.tick();
      expect(res.connected()).toBe(true);
      expect(sent).toEqual(['queued']);
      expect(res.send('live')).toBe(true);
      expect(sent).toEqual(['queued', 'live']);
    });

    it('a source change discards the outbox (queued messages were addressed to the old connection)', async () => {
      configure();
      const t = fakeBidiTransport();
      const url = signal<string | undefined>('wss://a');
      const res = TestBed.runInInjectionContext(() =>
        streamResource<Msg, string>(url, {
          transport: t.transport,
          outbox: true,
        }),
      );
      TestBed.tick();
      expect(res.send('for-a')).toBe(true);
      url.set('wss://b');
      await settle();
      expect(t.last.url).toBe('wss://b');
      t.last.ctx.open();
      expect(t.last.sent).toEqual([]);
    });

    it('send() returns false once retries are exhausted, even with an outbox', async () => {
      configure();
      const t = fakeBidiTransport();
      const res = TestBed.runInInjectionContext(() =>
        streamResource<Msg, string>(() => 'wss://x/feed', {
          transport: t.transport,
          outbox: true,
          reconnect: 0,
        }),
      );
      TestBed.tick();
      t.last.ctx.fail(new Error('refused'));
      await settle();
      expect(res.status()).toBe('error');
      expect(res.send('into-the-void')).toBe(false);
    });

    it('abort() discards the outbox', async () => {
      configure();
      const t = fakeBidiTransport();
      const res = TestBed.runInInjectionContext(() =>
        streamResource<Msg, string>(() => 'wss://x/feed', {
          transport: t.transport,
          outbox: true,
        }),
      );
      TestBed.tick();
      res.send('stale');
      res.abort();
      await settle();
      res.reload();
      await settle();
      t.last.ctx.open();
      expect(t.last.sent).toEqual([]);
    });
  });
});
