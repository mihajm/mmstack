import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { providePaused } from '@mmstack/primitives';
import {
  type BidiStreamTransport,
  streamResource,
  type StreamTransportContext,
} from './stream-resource';
import { provideMockResourceSensors } from './util';

type Conn = {
  ctx: StreamTransportContext<number>;
  closed: boolean;
  sent: string[];
};

function fake() {
  const conns: Conn[] = [];
  const transport: BidiStreamTransport<number, string> = (ctx) => {
    const conn: Conn = { ctx, closed: false, sent: [] };
    conns.push(conn);
    return {
      close: () => (conn.closed = true),
      send: (m) => conn.sent.push(m),
    };
  };
  return { transport, conns, last: () => conns.at(-1)! };
}

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
  }
};
const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);

function setup(extra: unknown[] = []) {
  vi.useFakeTimers();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'browser' },
      provideMockResourceSensors(),
      ...(extra as never[]),
    ],
  });
}
afterEach(() => vi.useRealTimers());

describe('streamResource contract', () => {
  it('a non-Error failure keeps the original value as the cause', async () => {
    setup();
    const t = fake();
    const res = run(() =>
      streamResource(() => 'u', { transport: t.transport, reconnect: 0 }),
    );
    await settle();
    t.last().ctx.fail('boom');
    await settle();
    expect(res.status()).toBe('error');
    expect((res.error() as Error).cause).toBe('boom');
  });

  it('send without an outbox and no connection is dropped', async () => {
    setup();
    const t = fake();
    const res = run(() =>
      streamResource(() => undefined, { transport: t.transport }),
    );
    await settle();
    expect(res.send('x')).toBe(false);
  });

  it.each([
    [true, true],
    [false, false],
  ])(
    'outbox %s: a send before the first connect returns %s',
    async (outbox, expected) => {
      setup();
      const t = fake();
      const res = run(() =>
        streamResource(() => undefined, { transport: t.transport, outbox }),
      );
      await settle();
      expect(res.send('x')).toBe(expected);
    },
  );

  it('the object reconnect form honors max and backoff', async () => {
    setup();
    const t = fake();
    const res = run(() =>
      streamResource(() => 'u', {
        transport: t.transport,
        reconnect: { max: 1 },
      }),
    );
    await settle();
    t.last().ctx.fail(new Error('a'));
    await vi.advanceTimersByTimeAsync(999);
    expect(t.conns.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.conns.length).toBe(2);
    t.last().ctx.fail(new Error('b'));
    await settle();
    expect(res.status()).toBe('error');
  });

  it.each([
    ['no pause option', undefined],
    ['pause: false', false],
  ])('under a paused boundary, %s still connects', async (_, pause) => {
    setup([providePaused(signal(true))]);
    const t = fake();
    run(() => streamResource(() => 'u', { transport: t.transport, pause }));
    await settle();
    expect(t.conns.length).toBe(1);
  });

  it('abort() on a disabled stream keeps it idle', async () => {
    setup();
    const t = fake();
    const url = signal<string | undefined>('u');
    const res = run(() => streamResource(url, { transport: t.transport }));
    await settle();
    url.set(undefined);
    await settle();
    res.abort();
    expect(res.status()).toBe('idle');

    const never = run(() =>
      streamResource(() => undefined, { transport: t.transport }),
    );
    await settle();
    never.abort();
    expect(never.status()).toBe('idle');
  });

  it('pausing twice resumes twice', async () => {
    setup();
    const t = fake();
    const paused = signal(false);
    const res = run(() =>
      streamResource(() => 'u', { transport: t.transport, pause: paused }),
    );
    await settle();
    for (let i = 0; i < 2; i++) {
      paused.set(true);
      await settle();
      paused.set(false);
      await settle();
    }
    expect(t.conns.length).toBe(3);
    t.last().ctx.open();
    expect(res.connected()).toBe(true);
  });

  it('a pause during backoff cancels the pending retry', async () => {
    setup();
    const t = fake();
    const paused = signal(false);
    run(() =>
      streamResource(() => 'u', {
        transport: t.transport,
        pause: paused,
        reconnect: { backoff: 1000 },
      }),
    );
    await settle();
    t.last().ctx.fail(new Error('x'));
    paused.set(true);
    await settle();
    paused.set(false);
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.conns.length).toBe(2);
  });

  it('pausing with no active stream does not throw', async () => {
    setup();
    const t = fake();
    const paused = signal(true);
    run(() =>
      streamResource(() => undefined, {
        transport: t.transport,
        pause: paused,
      }),
    );
    expect(() => TestBed.tick()).not.toThrow();
  });

  it('destroy() closes the connection', async () => {
    setup();
    const t = fake();
    const res = run(() =>
      streamResource(() => 'u', { transport: t.transport }),
    );
    await settle();
    t.last().ctx.open();
    res.destroy();
    await settle();
    expect(t.last().closed).toBe(true);
    expect(res.status()).toBe('idle');
  });
});
