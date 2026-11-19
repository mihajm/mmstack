import {
  computed,
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { store, toStore } from './store';
import {
  MESSAGE_BUS,
  MessageBus,
  tabSync,
  type StoreTabSyncOptions,
  type TabSyncBus,
} from './tab-sync';

type Msg = { t: string; to?: string; from?: string; [k: string]: unknown };

class Net {
  readonly log: { from: Bus; id: string; value: Msg }[] = [];
  private readonly buses = new Set<Bus>();
  add(b: Bus): void {
    this.buses.add(b);
  }
  broadcast(from: Bus, id: string, value: Msg): void {
    this.log.push({ from, id, value });
    for (const b of this.buses) if (b !== from) b.receive(id, value);
  }
  answersTo(origin: string): Msg[] {
    return this.log
      .map((e) => e.value)
      .filter(
        (m) => (m.t === 'state' || m.t === 'uptodate') && m.to === origin,
      );
  }
  sentBy(b: Bus): Msg[] {
    return this.log.filter((e) => e.from === b).map((e) => e.value);
  }
}

class Bus implements TabSyncBus {
  private readonly listeners = new Map<string, Set<(v: unknown) => void>>();
  private queue: [string, Msg][] | null = null;
  readonly subscribed: string[] = [];
  constructor(readonly net: Net) {
    net.add(this);
  }
  subscribe<T>(id: string, cb: (v: T) => void) {
    this.subscribed.push(id);
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    const wrapped = (v: unknown) => cb(v as T);
    set.add(wrapped);
    return {
      unsub: () => void set?.delete(wrapped),
      post: (v: T) => this.net.broadcast(this, id, v as Msg),
    };
  }
  post(id: string, value: Msg): void {
    this.net.broadcast(this, id, value);
  }
  hold(): void {
    this.queue ??= [];
  }
  release(): void {
    const q = this.queue ?? [];
    this.queue = null;
    for (const [id, v] of q) this.receive(id, v);
  }
  receive(id: string, value: Msg): void {
    if (this.queue) return void this.queue.push([id, value]);
    for (const l of [...(this.listeners.get(id) ?? [])]) l(value);
  }
}

type Doc = { title: string; x: number };
const base = (): Doc => ({ title: 'base', x: 0 });

function tab(net: Net, opt: Partial<StoreTabSyncOptions> = {}, init = base()) {
  const bus = new Bus(net);
  const injector = createEnvironmentInjector(
    [],
    TestBed.inject(EnvironmentInjector),
  );
  const s = tabSync(store(init, { injector }), {
    id: 'doc',
    injector,
    bus,
    ...opt,
  });
  const origin = () =>
    net.sentBy(bus).find((m) => m.t === 'hello')?.from as string;
  return { s, bus, injector, origin };
}

const advance = (ms: number) => {
  vi.advanceTimersByTime(ms);
  TestBed.tick();
};

function liveTab(net: Net, opt: Partial<StoreTabSyncOptions> = {}) {
  const t = tab(net, opt);
  advance(300);
  return t;
}

function foreignEnv(title: string) {
  const net = new Net();
  const t = liveTab(net);
  t.s.title.set(title);
  TestBed.tick();
  const env = net.sentBy(t.bus).find((m) => m.t === 'env');
  t.injector.destroy();
  if (!env) throw new Error('no envelope captured');
  return env;
}

function foreignState(title: string) {
  const net = new Net();
  const t = liveTab(net, { jitterMs: 0 });
  t.s.title.set(title);
  TestBed.tick();
  const raw = new Bus(net);
  raw.post('doc', {
    t: 'hello',
    proto: helloProto(net),
    from: 'probe',
    wm: {},
  });
  const state = net.answersTo('probe').find((m) => m.t === 'state');
  t.injector.destroy();
  if (!state) throw new Error('no state captured');
  return state;
}

function helloProto(net: Net): number {
  const hello = net.log.find((e) => e.value.t === 'hello');
  return hello?.value['proto'] as number;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('tabSync store mode: the join answer', () => {
  it('with two live responders exactly one answers a joiner', () => {
    const net = new Net();
    const a = liveTab(net);
    a.s.title.set('from-a');
    TestBed.tick();
    const c = tab(net);
    advance(300);
    expect(c.s().title).toBe('from-a');

    const b = tab(net);
    advance(300);
    expect(net.answersTo(b.origin())).toHaveLength(1);
    expect(b.s().title).toBe('from-a');
    for (const t of [a, b, c]) t.injector.destroy();
  });

  it('an uptodate answer ends the join at once: peer writes land without waiting for the timeout', () => {
    const net = new Net();
    const a = liveTab(net, { jitterMs: 0 });
    const b = tab(net);
    expect(net.answersTo(b.origin()).map((m) => m.t)).toEqual(['uptodate']);
    a.s.title.set('after-join');
    TestBed.tick();
    expect(b.s().title).toBe('after-join');
    a.injector.destroy();
    b.injector.destroy();
  });

  it('a state answer hydrates and ends the join at once', () => {
    const net = new Net();
    const a = liveTab(net, { jitterMs: 0 });
    a.s.title.set('before');
    TestBed.tick();
    const b = tab(net);
    expect(b.s().title).toBe('before');
    a.s.x.set(7);
    TestBed.tick();
    expect(b.s()).toEqual({ title: 'before', x: 7 });
    a.injector.destroy();
    b.injector.destroy();
  });

  it('a joining tab never answers another joiner', () => {
    const net = new Net();
    const a = liveTab(net);
    a.s.title.set('from-a');
    TestBed.tick();
    const b = tab(net, { jitterMs: 0 });
    const c = tab(net, { jitterMs: 0 });
    advance(300);
    expect(net.sentBy(b.bus).some((m) => m.t !== 'hello')).toBe(false);
    expect(c.s().title).toBe('from-a');
    for (const t of [a, b, c]) t.injector.destroy();
  });

  it('a live tab never re-hydrates from a late state answer', () => {
    const net = new Net();
    const b = liveTab(net);
    b.s.title.set('mine');
    TestBed.tick();
    const late = foreignState('other');
    new Bus(net).post('doc', { ...late, to: b.origin() });
    expect(b.s().title).toBe('mine');
    b.injector.destroy();
  });
});

describe('tabSync store mode: the join window', () => {
  it('keeps an envelope that arrives while joining and applies it when the join times out', () => {
    const env = foreignEnv('foreign');
    const net = new Net();
    const b = tab(net);
    new Bus(net).post('doc', env);
    expect(b.s().title).toBe('base');
    advance(300);
    expect(b.s().title).toBe('foreign');
    b.injector.destroy();
  });

  it('keeps an envelope that the hydrating snapshot lacks', () => {
    const env = foreignEnv('foreign');
    const net = new Net();
    const a = liveTab(net);
    a.s.x.set(1);
    TestBed.tick();
    const b = tab(net);
    a.bus.hold();
    new Bus(net).post('doc', env);
    advance(30);
    a.bus.release();
    advance(300);
    expect(net.answersTo(b.origin()).map((m) => m.t)).toEqual(['state']);
    expect(b.s()).toEqual({ title: 'foreign', x: 1 });
    a.injector.destroy();
    b.injector.destroy();
  });
});

describe('tabSync store mode: teardown', () => {
  it('a destroyed tab applies no remote writes', () => {
    const net = new Net();
    const a = liveTab(net);
    const b = tab(net);
    advance(300);
    a.injector.destroy();
    b.s.title.set('after');
    TestBed.tick();
    expect(a.s().title).toBe('base');
    b.injector.destroy();
  });

  it('a tab destroyed while joining never replays its buffered envelopes', () => {
    const env = foreignEnv('foreign');
    const net = new Net();
    const b = tab(net);
    new Bus(net).post('doc', env);
    b.injector.destroy();
    advance(300);
    expect(b.s().title).toBe('base');
  });

  it('a tab destroyed before its jittered answer never answers', () => {
    const net = new Net();
    const a = liveTab(net);
    const b = tab(net);
    a.injector.destroy();
    advance(300);
    expect(net.answersTo(b.origin())).toEqual([]);
    b.injector.destroy();
  });

  it('a local write still owed to the outbox reaches peers when the tab is destroyed', () => {
    const net = new Net();
    const a = liveTab(net);
    const b = tab(net);
    advance(300);
    a.bus.hold();
    b.s.x.set(5);
    TestBed.tick();
    a.s.title.set('last-word');
    a.bus.release();
    a.injector.destroy();
    TestBed.tick();
    expect(b.s()).toEqual({ title: 'last-word', x: 5 });
    b.injector.destroy();
  });
});

describe('tabSync: options and modes', () => {
  function signalTab(net: Net) {
    const bus = new Bus(net);
    const injector = createEnvironmentInjector(
      [{ provide: MESSAGE_BUS, useValue: bus }],
      TestBed.inject(EnvironmentInjector),
    );
    return { bus, injector };
  }

  it('the string shorthand is the channel id', () => {
    const net = new Net();
    const { bus, injector } = signalTab(net);
    const theme = injector.runInContext(() => tabSync(signal('a'), 'theme'));
    expect(bus.subscribed).toEqual(['theme']);
    new Bus(net).post('theme', 'b' as never);
    expect(theme()).toBe('b');
    injector.destroy();
  });

  it('on the server the signal is returned unsynced', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const bus = new Bus(new Net());
    const subscribe = vi.spyOn(bus, 'subscribe');
    const sig = signal(1);
    const out = TestBed.runInInjectionContext(() =>
      tabSync(sig, { id: 'srv', bus }),
    );
    expect(out).toBe(sig);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('a readonly store is not synced and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const net = new Net();
    const bus = new Bus(net);
    const src = signal({ v: 1 });
    TestBed.runInInjectionContext(() =>
      tabSync(toStore(computed(() => src())) as never, { id: 'ro', bus }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('readonly'));
    src.set({ v: 2 });
    TestBed.tick();
    expect(net.log).toEqual([]);
    expect(bus.subscribed).toEqual([]);
    warn.mockRestore();
  });

  it('a plain signal syncs without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const net = new Net();
    const bus = new Bus(net);
    const sig: WritableSignal<number> = signal(0);
    TestBed.runInInjectionContext(() => tabSync(sig, { id: 'plain', bus }));
    expect(warn).not.toHaveBeenCalled();
    sig.set(1);
    TestBed.tick();
    expect(net.log.map((e) => e.value)).toEqual([1]);
    warn.mockRestore();
  });

  it('id-less calls from different call sites get different channels', () => {
    const net = new Net();
    const { bus, injector } = signalTab(net);
    injector.runInContext(() => {
      expect(() => tabSync(signal(0))).not.toThrow();
      tabSync(signal(0));
    });
    expect(bus.subscribed).toHaveLength(2);
    expect(bus.subscribed[0]).not.toBe(bus.subscribed[1]);
    injector.destroy();
  });

  it('MessageBus closes its channel when its injector is destroyed', async () => {
    vi.useRealTimers();
    const env = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const bus = env.runInContext(() => new MessageBus());
    const listener = vi.fn();
    bus.subscribe('closing', listener);
    env.destroy();
    const peer = new BroadcastChannel('mmstack-tab-sync-bus');
    peer.postMessage({ id: 'closing', value: 1 });
    await new Promise((r) => setTimeout(r, 20));
    peer.close();
    expect(listener).not.toHaveBeenCalled();
  });
});
