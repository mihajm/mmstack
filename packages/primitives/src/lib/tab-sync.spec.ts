import {
  ApplicationRef,
  createEnvironmentInjector,
  EnvironmentInjector,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { mutableStore, store } from './store';
import { MessageBus, tabSync } from './tab-sync';

/**
 * A synchronous cross-"tab" bus network for deterministic store-mode tests: `post` from one tab's
 * bus delivers to every OTHER tab's bus immediately (BroadcastChannel semantics, minus the async).
 */
class FakeBusNet {
  private readonly buses = new Set<FakeBus>();
  add(b: FakeBus): void {
    this.buses.add(b);
  }
  broadcast(from: FakeBus, id: string, value: unknown): void {
    for (const b of this.buses) if (b !== from) b.deliver(id, value);
  }
}

class FakeBus {
  private readonly listeners = new Map<string, Set<(v: unknown) => void>>();
  constructor(private readonly net: FakeBusNet) {
    net.add(this);
  }
  subscribe<T>(id: string, cb: (v: T) => void) {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    const wrapped = (v: unknown) => cb(v as T);
    set.add(wrapped);
    return {
      unsub: () => set?.delete(wrapped),
      post: (v: T) => this.net.broadcast(this, id, v),
    };
  }
  deliver(id: string, value: unknown): void {
    for (const l of [...(this.listeners.get(id) ?? [])]) l(value);
  }
}

function tickAndStable() {
  TestBed.tick();
  return TestBed.inject(ApplicationRef).whenStable();
}

describe('tabSync', () => {
  let testChannel: BroadcastChannel;

  beforeEach(() => {
    testChannel = new BroadcastChannel('mmstack-tab-sync-bus');
  });

  afterEach(() => {
    testChannel.close();
  });

  /**
   * Simulates a true inbound message from another tab.
   * Yields to the event loop so happy-dom processes the macrotask broadcast.
   */
  async function dispatchInbound(id: string, value: unknown) {
    testChannel.postMessage({ id, value });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Poll until a condition holds — BroadcastChannel delivery is async, so a fixed sleep flakes. */
  async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('should sync signal across tabs and broadcast changes', async () => {
    const bus = TestBed.inject(MessageBus);
    const subscribeSpy = vi.spyOn(bus, 'subscribe');

    // Listen on the parallel channel to catch outbound broadcasts from the bus
    const outboundSpy = vi.fn();
    testChannel.addEventListener('message', outboundSpy);

    const sig = TestBed.runInInjectionContext(() =>
      tabSync(signal('dark'), { id: 'theme-sync' }),
    );

    expect(subscribeSpy).toHaveBeenCalledWith(
      'theme-sync',
      expect.any(Function),
    );

    await tickAndStable();
    expect(outboundSpy).not.toHaveBeenCalled();

    sig.set('light');
    await tickAndStable();
    await waitFor(() => outboundSpy.mock.calls.length === 1); // broadcast is async

    expect(sig()).toBe('light');
    expect(outboundSpy).toHaveBeenCalledTimes(1);
    expect(outboundSpy.mock.calls[0][0].data).toEqual({
      id: 'theme-sync',
      value: 'light',
    });
  });

  it('applies inbound values without re-broadcasting them (no echo loop)', async () => {
    const outboundSpy = vi.fn();
    testChannel.addEventListener('message', outboundSpy);

    const sig = TestBed.runInInjectionContext(() =>
      tabSync(signal({ lang: 'en' }), { id: 'prefs' }),
    );
    await tickAndStable();

    // A fresh object arriving from the "other tab"
    await dispatchInbound('prefs', { lang: 'de' });

    expect(sig()).toEqual({ lang: 'de' });
    expect(outboundSpy).not.toHaveBeenCalled(); // Should not echo back

    // A later local change still broadcasts
    sig.set({ lang: 'fr' });
    await tickAndStable();
    await waitFor(() => outboundSpy.mock.calls.length === 1);

    expect(outboundSpy).toHaveBeenCalledTimes(1);
    expect(outboundSpy.mock.calls[0][0].data).toEqual({
      id: 'prefs',
      value: { lang: 'fr' },
    });
  });

  it('an inbound value equal to the current one does not block later broadcasts', async () => {
    const outboundSpy = vi.fn();
    testChannel.addEventListener('message', outboundSpy);

    const sig = TestBed.runInInjectionContext(() =>
      tabSync(signal('dark'), { id: 'theme' }),
    );
    await tickAndStable();

    // Equality-suppressed write
    await dispatchInbound('theme', 'dark');
    expect(outboundSpy).not.toHaveBeenCalled();

    sig.set('light');
    await tickAndStable();
    await waitFor(() => outboundSpy.mock.calls.length === 1);

    expect(outboundSpy).toHaveBeenCalledTimes(1);
  });

  it('supports multiple subscribers on the same id', async () => {
    const bus = TestBed.inject(MessageBus);
    const a: unknown[] = [];
    const b: unknown[] = [];

    const subA = bus.subscribe('shared', (v) => a.push(v));
    bus.subscribe('shared', (v) => b.push(v));

    await dispatchInbound('shared', 1);
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);

    subA.unsub();
    await dispatchInbound('shared', 2);
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });

  it('cleans up listeners and stops syncing when the injection context is destroyed', async () => {
    const parentInjector = TestBed.inject(EnvironmentInjector);
    const scopedInjector = createEnvironmentInjector([], parentInjector);

    const sig = scopedInjector.runInContext(() =>
      tabSync(signal('dark'), { id: 'cleanup-test' }),
    );

    await tickAndStable();

    // Destroy the context (this triggers the DestroyRef inside tabSync)
    scopedInjector.destroy();

    // Simulate a message arriving from another tab AFTER destruction
    await dispatchInbound('cleanup-test', 'light');

    // The signal should remain completely unaffected
    expect(sig()).toBe('dark');
  });

  it('accepts an explicit injector (created outside an injection context)', () => {
    const injector = TestBed.inject(EnvironmentInjector);
    const sig = tabSync(signal('dark'), { id: 'injector-test', injector });
    expect(sig()).toBe('dark');
  });
});

describe('tabSync — store mode (op sync across tabs)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function storeTab<T extends object>(net: FakeBusNet, id: string, initial: T) {
    const parent = TestBed.inject(EnvironmentInjector);
    const injector = createEnvironmentInjector(
      [{ provide: MessageBus, useValue: new FakeBus(net) as unknown as MessageBus }],
      parent,
    );
    const s = injector.runInContext(() => tabSync(store(initial), { id }));
    return { s, injector };
  }

  it('two tabs merge concurrent edits to DIFFERENT leaves (ops, not clobber)', () => {
    const net = new FakeBusNet();
    const a = storeTab(net, 'doc', { x: 0, y: 0 });
    const b = storeTab(net, 'doc', { x: 0, y: 0 });
    vi.advanceTimersByTime(300); // both hello-timeouts fire → both go live as independent bases
    TestBed.tick();

    a.s.x.set(1);
    TestBed.tick();
    b.s.y.set(2);
    TestBed.tick();
    vi.advanceTimersByTime(50);
    TestBed.tick();

    expect(a.s()).toEqual({ x: 1, y: 2 }); // whole-value sync would have lost one edit
    expect(b.s()).toEqual({ x: 1, y: 2 });
    a.injector.destroy();
    b.injector.destroy();
  });

  it('a late joiner hydrates a peer state through the hello exchange', () => {
    const net = new FakeBusNet();
    const a = storeTab(net, 'doc', { title: 'base' });
    vi.advanceTimersByTime(300);
    TestBed.tick(); // A live and alone
    a.s.title.set('from-a');
    TestBed.tick();

    const b = storeTab(net, 'doc', { title: 'base' }); // joins after A has state
    vi.advanceTimersByTime(60); // A answers the hello (jittered) with a snapshot → B hydrates
    TestBed.tick();

    expect(b.s()).toEqual({ title: 'from-a' });
    a.injector.destroy();
    b.injector.destroy();
  });
});

describe('tabSync — mode detection', () => {
  it('warns that a mutable store falls back to whole-value sync', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    TestBed.runInInjectionContext(() => tabSync(mutableStore({ a: 1 }), { id: 'mut' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mutable'));
    warn.mockRestore();
  });
});
