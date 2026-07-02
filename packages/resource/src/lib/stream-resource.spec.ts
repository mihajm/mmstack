import { PLATFORM_ID, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  injectTransitionScope,
  provideTransitionScope,
} from '@mmstack/primitives';
import {
  streamResource,
  type StreamTransport,
  type StreamTransportContext,
} from './stream-resource';
import { ResourceSensors } from './util';

type Msg = { n: number };

/** Records every connection attempt; the test drives open/emit/fail by hand. */
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

  /** The FIRST item of a stream resolves the loader promise — flush that microtask hop. */
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
    TestBed.tick(); // the resource's load effect connects

    expect(t.connections.length).toBe(1);
    expect(res.status()).toBe('loading');
    expect(res.connected()).toBe(false);

    t.last.ctx.open();
    expect(res.connected()).toBe(true);
    expect(res.status()).toBe('loading'); // connected but no data yet — honestly not ready

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

    url.set(undefined); // the disable lever
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
    expect(res.value()).toEqual({ n: 1 }); // the value HOLDS through the outage
    expect(res.status()).toBe('resolved'); // a retried drop is not an error state
    expect(t.connections.length).toBe(1); // backoff — not immediate

    vi.advanceTimersByTime(1000);
    expect(t.connections.length).toBe(2); // first retry after base backoff

    t.last.ctx.fail(new Error('still down'));
    vi.advanceTimersByTime(1000);
    expect(t.connections.length).toBe(2); // second retry doubles: not yet…
    vi.advanceTimersByTime(1000);
    expect(t.connections.length).toBe(3); // …now

    t.last.ctx.open(); // success resets the ladder
    t.last.ctx.fail(new Error('dropped again'));
    vi.advanceTimersByTime(1000);
    expect(t.connections.length).toBe(4); // back to base backoff

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
    t.last.ctx.fail(new Error('refused again')); // retries exhausted
    await settle();
    expect(res.status()).toBe('error');
    expect(res.error()).toBeInstanceOf(Error);

    res.reload(); // fresh attempt budget
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
    expect(t.connections.length).toBe(0); // offline — nothing burned

    online.set(true);
    TestBed.tick(); // the until() watcher observes the regain
    await Promise.resolve(); // …and resolves its promise
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
    expect(res.value()).toEqual({ n: 3 }); // kept
    expect(res.status()).toBe('local');
    expect(t.connections.length).toBe(1); // no sneaky reconnect

    res.reload(); // explicit resume
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
    expect(scope.pending()).toBe(true); // first load in flight

    expect(scope.abortPending()).toBe(1); // the cancellation seam reaches streams
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
});
