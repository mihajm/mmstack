import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { isStored, stored } from './stored';
import { withHistory } from './with-history';

function memStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    removeItem: vi.fn((k: string) => void data.delete(k)),
  };
}

function storageEvent(init: StorageEventInit) {
  const e = new Event('storage') as StorageEvent;
  for (const [k, v] of Object.entries(init))
    Object.defineProperty(e, k, { value: v });
  window.dispatchEvent(e);
}

function childInjector() {
  return createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
}

describe('stored: storage selection', () => {
  it('never reads the global localStorage when a custom store is passed', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage blocked');
      },
    });
    try {
      const store = memStore({ k: '"v"' });
      const sig = TestBed.runInInjectionContext(() =>
        stored('fb', { key: 'k', store }),
      );
      expect(sig()).toBe('v');
    } finally {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('uses a no-op store on the server', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const sig = TestBed.runInInjectionContext(() =>
      stored('x', { key: 'ssr-key' }),
    );
    expect(sig()).toBe('x');
    sig.set('y');
    TestBed.tick();
    expect(sig()).toBe('y');
    expect(localStorage.getItem('ssr-key')).toBeNull();
  });
});

describe('stored: reading', () => {
  it('a value that fails validate reads as the fallback and is removed', () => {
    const store = memStore({ k: '5' });
    const sig = TestBed.runInInjectionContext(() =>
      stored(0, { key: 'k', store, validate: (v) => v < 3 }),
    );
    expect(sig()).toBe(0);
    TestBed.tick();
    expect(store.data.has('k')).toBe(false);
  });

  it('a corrupt entry reads as the fallback', () => {
    const store = memStore({ k: 'not json' });
    const sig = TestBed.runInInjectionContext(() =>
      stored('fb', { key: 'k', store }),
    );
    expect(sig()).toBe('fb');
  });

  it('a function key is evaluated, not used as text', () => {
    const id = signal(1);
    const store = memStore({ 'u-1': '"one"' });
    const sig = TestBed.runInInjectionContext(() =>
      stored('fb', { key: () => 'u-' + id(), store }),
    );
    expect(sig()).toBe('one');
    expect(sig.key()).toBe('u-1');
    sig.set('uno');
    TestBed.tick();
    expect(store.data.get('u-1')).toBe('"uno"');
  });

  it("the user's equal never sees the internal empty marker", () => {
    const store = memStore({ k: '"A"' });
    const sig = TestBed.runInInjectionContext(() =>
      stored<string>('fb', {
        key: 'k',
        store,
        equal: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
      }),
    );
    expect(() => sig.clear()).not.toThrow();
    expect(sig()).toBe('fb');
    TestBed.tick();
    expect(store.data.has('k')).toBe(false);
    expect(() => sig.set('B')).not.toThrow();
    TestBed.tick();
    expect(sig()).toBe('B');
    expect(store.data.get('k')).toBe('"B"');
    sig.set('b');
    expect(sig()).toBe('B');
  });
});

describe('stored: key changes', () => {
  const setup = (
    opts: { onKeyChange?: 'load' | 'store'; cleanupOldKey?: boolean } = {},
  ) => {
    const key = signal('a');
    const store = memStore({ a: '"from-a"', b: '"from-b"' });
    const sig = TestBed.runInInjectionContext(() =>
      stored('fb', { key, store, ...opts }),
    );
    TestBed.tick();
    return { key, store, sig };
  };

  it('load mode (default) loads the new key and keeps the old one', () => {
    const { key, store, sig } = setup();
    key.set('b');
    TestBed.tick();
    expect(sig()).toBe('from-b');
    expect(store.data.get('a')).toBe('"from-a"');
    sig.set('next');
    TestBed.tick();
    expect(store.data.get('b')).toBe('"next"');
    expect(store.data.get('a')).toBe('"from-a"');
  });

  it('load mode with cleanupOldKey removes the old key', () => {
    const { key, store, sig } = setup({ cleanupOldKey: true });
    key.set('b');
    TestBed.tick();
    expect(sig()).toBe('from-b');
    expect(store.data.has('a')).toBe(false);
    expect(store.data.get('b')).toBe('"from-b"');
  });

  it('store mode writes the current value to the new key and keeps the old one', () => {
    const { key, store, sig } = setup({ onKeyChange: 'store' });
    key.set('b');
    TestBed.tick();
    expect(sig()).toBe('from-a');
    expect(store.data.get('b')).toBe('"from-a"');
    expect(store.data.get('a')).toBe('"from-a"');
    sig.set('next');
    TestBed.tick();
    expect(store.data.get('b')).toBe('"next"');
  });

  it('store mode with cleanupOldKey removes only the old key', () => {
    const { key, store, sig } = setup({
      onKeyChange: 'store',
      cleanupOldKey: true,
    });
    sig.set('same-key');
    TestBed.tick();
    expect(store.data.get('a')).toBe('"same-key"');
    key.set('b');
    TestBed.tick();
    expect(store.data.has('a')).toBe(false);
    expect(store.data.get('b')).toBe('"same-key"');
  });

  it('store mode honors pause and an explicit injector', () => {
    const paused = signal(true);
    const store = memStore();
    const sig = stored('fb', {
      key: 'k',
      store,
      onKeyChange: 'store',
      pause: paused,
      injector: TestBed.inject(EnvironmentInjector),
    });
    sig.set('v');
    TestBed.tick();
    expect(store.data.has('k')).toBe(false);
    paused.set(false);
    TestBed.tick();
    expect(store.data.get('k')).toBe('"v"');
  });
});

describe('stored: syncTabs', () => {
  const setup = (syncTabs?: boolean) => {
    const store = memStore({ k: '"start"' });
    const injector = childInjector();
    const sig = stored('fb', { key: 'k', store, syncTabs, injector });
    return { store, sig, injector };
  };

  it('is off by default', () => {
    const { store, sig, injector } = setup();
    store.data.set('k', '"remote"');
    storageEvent({
      key: 'k',
      newValue: '"remote"',
      storageArea: store as never,
    });
    expect(sig()).toBe('start');
    injector.destroy();
  });

  it('applies a remote write for its key and storage area', () => {
    const { store, sig, injector } = setup(true);
    store.data.set('k', '"remote"');
    storageEvent({
      key: 'k',
      newValue: '"remote"',
      storageArea: store as never,
    });
    expect(sig()).toBe('remote');
    injector.destroy();
  });

  it('ignores another key and another storage area', () => {
    const { store, sig, injector } = setup(true);
    store.data.set('other', '"x"');
    storageEvent({
      key: 'other',
      newValue: '"x"',
      storageArea: store as never,
    });
    expect(sig()).toBe('start');
    const foreign = memStore({ k: '"foreign"' });
    storageEvent({
      key: 'k',
      newValue: '"foreign"',
      storageArea: foreign as never,
    });
    expect(sig()).toBe('start');
    injector.destroy();
  });

  it('a remote removal returns the fallback', () => {
    const { store, sig, injector } = setup(true);
    store.data.delete('k');
    storageEvent({ key: 'k', newValue: null, storageArea: store as never });
    expect(sig()).toBe('fb');
    injector.destroy();
  });

  it("another tab's storage clear() returns the fallback", () => {
    const { store, sig, injector } = setup(true);
    store.data.clear();
    storageEvent({ key: null, newValue: null, storageArea: store as never });
    expect(sig()).toBe('fb');
    injector.destroy();
  });

  it('a clear() of another storage area is ignored', () => {
    const { sig, injector } = setup(true);
    const foreign = memStore();
    storageEvent({ key: null, newValue: null, storageArea: foreign as never });
    expect(sig()).toBe('start');
    injector.destroy();
  });

  it('stops listening once its injector is destroyed', () => {
    const { store, sig, injector } = setup(true);
    injector.destroy();
    store.data.set('k', '"late"');
    storageEvent({ key: 'k', newValue: '"late"', storageArea: store as never });
    expect(sig()).toBe('start');
  });
});

describe('isStored', () => {
  it('is true only for stored signals', () => {
    const store = memStore();
    const s = TestBed.runInInjectionContext(() =>
      stored(0, { key: 'k', store }),
    );
    expect(isStored(s)).toBe(true);
    expect(isStored(signal(0))).toBe(false);
    expect(isStored(Object.assign(signal(0), { key: signal('k') }))).toBe(
      false,
    );
    expect(
      TestBed.runInInjectionContext(() => isStored(withHistory(signal(0)))),
    ).toBe(false);
  });
});
