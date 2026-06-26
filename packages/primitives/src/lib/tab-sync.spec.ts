import {
  ApplicationRef,
  createEnvironmentInjector,
  EnvironmentInjector,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MessageBus, tabSync } from './tab-sync';

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
    await new Promise((resolve) => setTimeout(resolve, 0)); // Wait for broadcast

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
    await new Promise((resolve) => setTimeout(resolve, 0));

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
    await new Promise((resolve) => setTimeout(resolve, 0));

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
