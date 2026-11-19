import { TestBed } from '@angular/core/testing';
import {
  injectDynamicLocale,
  injectLocaleInternal,
  injectLocaleLoadState,
  provideIntlConfig,
  TranslationStore,
} from './translation-store';

type Chunk = {
  namespace: string;
  flat: Record<string, string>;
  locale: string;
};

function chunk(
  namespace: string,
  locale: string,
  flat: Record<string, string>,
) {
  return { namespace, locale, flat } satisfies Chunk;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r));
  }
  TestBed.tick();
};

function setup(supportedLocales = ['en-US', 'de-DE', 'es-ES']) {
  TestBed.configureTestingModule({
    providers: [
      provideIntlConfig({ defaultLocale: 'en-US', supportedLocales }),
    ],
  });
  return TestBed.runInInjectionContext(() => {
    injectLocaleInternal().set('en-US');
    return {
      store: TestBed.inject(TranslationStore),
      locale: injectDynamicLocale(),
      loadState: injectLocaleLoadState(),
    };
  });
}

describe('TranslationStore locale switching', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('setting the current locale cancels a pending switch', async () => {
    const { store, locale } = setup();
    const de = deferred<Chunk>();
    store.registerOnDemandLoaders('ns', { 'de-DE': () => de.promise });
    locale.set('de-DE');
    await flush();
    locale.set('en-US');
    de.resolve(chunk('ns', 'de-DE', { k: 'Hallo' }));
    await flush();
    expect(store.locale()).toBe('en-US');
    expect(store.loadQueue()).toEqual([]);
  });

  it('a synchronous switch cancels an earlier pending switch', async () => {
    const { store, locale } = setup();
    const de = deferred<Chunk>();
    store.registerOnDemandLoaders('ns', { 'de-DE': () => de.promise });
    store.register('other', { 'es-ES': { k: 'Hola' } });
    locale.set('de-DE');
    await flush();
    locale.set('es-ES');
    expect(store.locale()).toBe('es-ES');
    de.resolve(chunk('ns', 'de-DE', { k: 'Hallo' }));
    await flush();
    expect(store.locale()).toBe('es-ES');
  });

  it('a cancelled switch can be picked again while its load is in flight', async () => {
    const { store, locale } = setup();
    const de = deferred<Chunk>();
    store.registerOnDemandLoaders('ns', { 'de-DE': () => de.promise });
    locale.set('de-DE');
    await flush();
    locale.set('en-US');
    locale.set('de-DE');
    de.resolve(chunk('ns', 'de-DE', { k: 'Hallo' }));
    await flush();
    expect(store.locale()).toBe('de-DE');
  });

  it('the last queued switch wins', async () => {
    const { store, locale } = setup();
    const es = deferred<Chunk>();
    const de = deferred<Chunk>();
    store.registerOnDemandLoaders('ns', {
      'es-ES': () => es.promise,
      'de-DE': () => de.promise,
    });
    locale.set('es-ES');
    locale.set('de-DE');
    es.resolve(chunk('ns', 'es-ES', { k: 'Hola' }));
    de.resolve(chunk('ns', 'de-DE', { k: 'Hallo' }));
    await flush();
    expect(store.locale()).toBe('de-DE');
  });

  it('a loader that throws synchronously does not block later switches', async () => {
    const { store, locale } = setup();
    store.registerOnDemandLoaders('a', {
      'es-ES': () => {
        throw new Error('sync');
      },
    });
    store.registerOnDemandLoaders('b', {
      'de-DE': () => Promise.resolve(chunk('b', 'de-DE', { k: 'Hallo' })),
    });
    locale.set('es-ES');
    await flush();
    expect(store.locale()).toBe('en-US');
    locale.set('de-DE');
    await flush();
    expect(store.locale()).toBe('de-DE');
    expect(store.formatMessage('b::MMT_DELIM::k')).toBe('Hallo');
  });

  it('the load state is idle when nothing is queued', async () => {
    const { store, locale, loadState } = setup();
    TestBed.tick();
    expect(loadState.isLoading()).toBe(false);
    expect(loadState.status()).toBe('idle');

    store.registerOnDemandLoaders('ns', {
      'es-ES': () => Promise.resolve(chunk('ns', 'es-ES', { k: 'Hola' })),
    });
    locale.set('es-ES');
    await flush();
    expect(store.locale()).toBe('es-ES');
    expect(loadState.isLoading()).toBe(false);
    expect(loadState.status()).toBe('idle');
  });

  it('a locale without a loader in one namespace still loads the others', async () => {
    const { store, locale } = setup();
    store.registerOnDemandLoaders('a', {
      'es-ES': () => Promise.resolve(chunk('a', 'es-ES', { k: 'Hola' })),
    });
    store.registerOnDemandLoaders('b', {
      'de-DE': () => Promise.resolve(chunk('b', 'de-DE', { k: 'Hallo' })),
    });
    locale.set('es-ES');
    await flush();
    expect(store.locale()).toBe('es-ES');
    expect(store.formatMessage('a::MMT_DELIM::k')).toBe('Hola');
  });

  it('a namespace already present for the locale is not loaded again', async () => {
    const { store, locale } = setup();
    store.register('ns', { 'es-ES': { k: 'live' } });
    store.register('other', { 'es-ES': { x: 'y' } });
    const loader = vi.fn(() =>
      Promise.resolve(chunk('ns', 'es-ES', { k: 'stale' })),
    );
    store.registerOnDemandLoaders('ns', { 'es-ES': loader });
    locale.set('es-ES');
    await flush();
    expect(loader).not.toHaveBeenCalled();
    expect(store.locale()).toBe('es-ES');
    expect(store.formatMessage('ns::MMT_DELIM::k')).toBe('live');
  });

  it("another namespace's data for the locale does not count as this namespace", async () => {
    const { store, locale } = setup();
    store.register('header', { 'es-ES': { a: 'b' } });
    store.register('h', { 'es-ES': { a: 'b' } });
    store.registerOnDemandLoaders('home', {
      'es-ES': () => Promise.resolve(chunk('home', 'es-ES', { k: 'Casa' })),
    });
    locale.set('es-ES');
    await flush();
    expect(store.formatMessage('home::MMT_DELIM::k')).toBe('Casa');
  });

  it('a locale with some data still loads its other namespaces', async () => {
    const { store, locale } = setup();
    store.register('a', { 'es-ES': { k: 'A' } });
    store.registerOnDemandLoaders('b', {
      'es-ES': () => Promise.resolve(chunk('b', 'es-ES', { k: 'B es' })),
    });
    locale.set('es-ES');
    await flush();
    expect(store.locale()).toBe('es-ES');
    expect(store.formatMessage('b::MMT_DELIM::k')).toBe('B es');
  });

  it('a removed namespace does not come back through its loaders', async () => {
    const { store, locale } = setup();
    store.registerOnDemandLoaders('gone', {
      'es-ES': () => Promise.resolve(chunk('gone', 'es-ES', { k: 'back' })),
    });
    store.registerOnDemandLoaders('kept', {
      'es-ES': () => Promise.resolve(chunk('kept', 'es-ES', { k: 'Hola' })),
    });
    store.register('gone', { 'en-US': { k: 'here' } });
    store.removeNamespace('gone');
    locale.set('es-ES');
    await flush();
    expect(store.locale()).toBe('es-ES');
    expect(store.formatMessage('gone::MMT_DELIM::k')).toBe('');
  });
});

describe('TranslationStore missing-key fallback load', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('a key missing in the active locale loads the default-locale data', async () => {
    const { store } = setup();
    store.registerOnDemandLoaders('ns', {
      'en-US': () => Promise.resolve(chunk('ns', 'en-US', { k: 'Fallback' })),
    });
    store.register('ns', { 'es-ES': { other: 'x' } });
    store.locale.set('es-ES');
    const sig = store.buildSimpleKeySignal('ns::MMT_DELIM::k');
    expect(sig()).toBe('');
    await flush();
    expect(sig()).toBe('Fallback');
    expect(store.locale()).toBe('es-ES');
  });

  it('a failing default loader is attempted once for many missing keys', async () => {
    const { store } = setup();
    const loader = vi.fn(() => Promise.reject(new Error('down')));
    store.registerOnDemandLoaders('ns', { 'en-US': loader });
    store.register('ns', { 'es-ES': { other: 'x' } });
    store.locale.set('es-ES');
    store.formatMessage('ns::MMT_DELIM::a');
    await flush();
    store.formatMessage('ns::MMT_DELIM::b');
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('a missing-key read does not drop a queued switch to the default locale', async () => {
    const { store, locale } = setup();
    store.registerOnDemandLoaders('ns', {
      'en-US': () => Promise.resolve(chunk('ns', 'en-US', { k: 'Hi' })),
      'es-ES': () => Promise.resolve(chunk('ns', 'es-ES', { k: 'Hola' })),
    });
    store.register('ns', { 'es-ES': { k: 'Hola' } });
    store.locale.set('es-ES');
    locale.set('en-US');
    store.formatMessage('ns::MMT_DELIM::missing');
    await flush();
    expect(store.locale()).toBe('en-US');
  });

  it('a user switch to a locale whose fallback data load is in flight still switches', async () => {
    const { store, locale } = setup();
    const en = deferred<Chunk>();
    store.registerOnDemandLoaders('ns', { 'en-US': () => en.promise });
    store.register('ns', { 'es-ES': { other: 'x' } });
    store.locale.set('es-ES');
    store.formatMessage('ns::MMT_DELIM::k');
    await flush();
    locale.set('en-US');
    en.resolve(chunk('ns', 'en-US', { k: 'Hi' }));
    await flush();
    expect(store.locale()).toBe('en-US');
  });

  it('registering loaders later allows a new fallback attempt', async () => {
    const { store } = setup();
    store.register('ns', { 'es-ES': { other: 'x' } });
    store.locale.set('es-ES');
    store.formatMessage('ns::MMT_DELIM::a');
    await flush();
    store.registerOnDemandLoaders('ns', {
      'en-US': () => Promise.resolve(chunk('ns', 'en-US', { b: 'B' })),
    });
    const sig = store.buildSimpleKeySignal('ns::MMT_DELIM::b');
    sig();
    await flush();
    expect(sig()).toBe('B');
  });
});
