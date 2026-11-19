import {
  makeStateKey,
  PLATFORM_ID,
  TransferState,
  untracked,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  convertToParamMap,
  provideRouter,
  type ActivatedRouteSnapshot,
  type ResolveFn,
  type RouterStateSnapshot,
} from '@angular/router';
import { registerRemoteNamespace } from './register-namespace';
import {
  injectLocaleInternal,
  provideIntlConfig,
  TranslationStore,
} from './translation-store';

function snapshot(locale?: string): ActivatedRouteSnapshot {
  return {
    paramMap: convertToParamMap(locale ? { locale } : {}),
    parent: null,
  } as unknown as ActivatedRouteSnapshot;
}

function setup(
  opts: { preload?: boolean; config?: boolean; server?: boolean } = {},
) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      ...(opts.server ? [{ provide: PLATFORM_ID, useValue: 'server' }] : []),
      ...(opts.config === false
        ? []
        : provideIntlConfig({
            defaultLocale: 'en-US',
            supportedLocales: ['en-US', 'sl-SI'],
            localeParamName: 'locale',
            preloadDefaultLocale: opts.preload,
          })),
    ],
  });
  TestBed.runInInjectionContext(() => injectLocaleInternal().set('en-US'));
  return TestBed.inject(TranslationStore);
}

function resolve(fn: ResolveFn<void>, locale?: string) {
  return TestBed.runInInjectionContext(() =>
    fn(snapshot(locale), {} as RouterStateSnapshot),
  ) as Promise<void>;
}

const EN = { hello: 'Hi', onlyDefault: 'Default only' };
const SL = { hello: 'Zivjo' };

let nsId = 0;

function makeNs(
  opts: {
    failDefault?: (call: number) => boolean;
    failSl?: (call: number) => boolean;
  } = {},
) {
  const name = `remote${nsId++}`;
  const counts = { def: 0, sl: 0 };
  const [, resolver] = registerRemoteNamespace(
    name,
    () => {
      counts.def++;
      return opts.failDefault?.(counts.def)
        ? Promise.reject(new Error('default down'))
        : Promise.resolve(EN);
    },
    {
      'sl-SI': () => {
        counts.sl++;
        return opts.failSl?.(counts.sl)
          ? Promise.reject(new Error('sl down'))
          : Promise.resolve(SL);
      },
    },
  );
  const key = (k: string) => `${name}::MMT_DELIM::${k}`;
  const stateKey = (locale: string) =>
    makeStateKey<Record<string, string>>(
      `@mmstack/translate:${name}:${locale}`,
    );
  return { name, resolver, counts, key, stateKey };
}

describe('registerRemoteNamespace resolver', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warnSpy.mockRestore());

  it('switches the locale and registers the strings after a successful resolve', async () => {
    const store = setup();
    const ns = makeNs();
    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('sl-SI');
    expect(store.formatMessage(ns.key('hello'))).toBe('Zivjo');
    expect(ns.counts.def).toBe(0);
  });

  it('loads a resolved locale once and switches back to it on re-resolve', async () => {
    const store = setup();
    const ns = makeNs();
    await resolve(ns.resolver, 'sl-SI');
    store.locale.set('en-US');
    await resolve(ns.resolver, 'sl-SI');
    expect(ns.counts.sl).toBe(1);
    expect(untracked(store.locale)).toBe('sl-SI');
  });

  it('loads the default once across repeated default resolves', async () => {
    const store = setup();
    const ns = makeNs();
    await resolve(ns.resolver, 'en-US');
    await resolve(ns.resolver, 'en-US');
    expect(ns.counts.def).toBe(1);
    expect(store.formatMessage(ns.key('hello'))).toBe('Hi');
  });

  it('a loaded default does not block another locale', async () => {
    const store = setup();
    const ns = makeNs();
    await resolve(ns.resolver, 'en-US');
    await resolve(ns.resolver, 'sl-SI');
    expect(ns.counts.sl).toBe(1);
    expect(untracked(store.locale)).toBe('sl-SI');
    expect(store.formatMessage(ns.key('hello'))).toBe('Zivjo');
  });

  it('loading another locale does not mark the default as loaded', async () => {
    const store = setup();
    const ns = makeNs();
    await resolve(ns.resolver, 'sl-SI');
    await resolve(ns.resolver, 'en-US');
    expect(ns.counts.def).toBe(1);
    expect(untracked(store.locale)).toBe('en-US');
    expect(store.formatMessage(ns.key('hello'))).toBe('Hi');
  });

  it('re-resolving the cached default locale switches back to it', async () => {
    const store = setup();
    const ns = makeNs();
    await resolve(ns.resolver, 'en-US');
    await resolve(ns.resolver, 'sl-SI');
    await resolve(ns.resolver, 'en-US');
    expect(untracked(store.locale)).toBe('en-US');
    expect(ns.counts.def).toBe(1);
  });

  it('with preloadDefaultLocale, the default is loaded with the requested locale', async () => {
    const store = setup({ preload: true });
    const ns = makeNs();
    await resolve(ns.resolver, 'sl-SI');
    expect(ns.counts.def).toBe(1);
    expect(store.formatMessage(ns.key('onlyDefault'))).toBe('Default only');
    await resolve(ns.resolver, 'en-US');
    expect(ns.counts.def).toBe(1);
  });

  it('with preloadDefaultLocale, a default-locale resolve fetches the default once', async () => {
    setup({ preload: true });
    const ns = makeNs();
    await resolve(ns.resolver, 'en-US');
    expect(ns.counts.def).toBe(1);
  });

  it('without preloadDefaultLocale, resolving another locale does not load the default', async () => {
    setup();
    const ns = makeNs();
    await resolve(ns.resolver, 'sl-SI');
    expect(ns.counts.def).toBe(0);
  });

  it('works without provideIntlConfig', async () => {
    const store = setup({ config: false });
    const ns = makeNs();
    await resolve(ns.resolver);
    expect(store.formatMessage(ns.key('hello'))).toBe('Hi');
  });

  it('a lone failed loader skips the switch and is retried later', async () => {
    const store = setup();
    const ns = makeNs({ failSl: (n) => n === 1 });
    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('en-US');
    await resolve(ns.resolver, 'sl-SI');
    expect(ns.counts.sl).toBe(2);
    expect(untracked(store.locale)).toBe('sl-SI');
    expect(store.formatMessage(ns.key('hello'))).toBe('Zivjo');
  });

  it('a lone failed default loader is not marked loaded', async () => {
    const store = setup();
    const ns = makeNs({ failDefault: (n) => n === 1 });
    await resolve(ns.resolver, 'en-US');
    await resolve(ns.resolver, 'en-US');
    expect(ns.counts.def).toBe(2);
    expect(store.formatMessage(ns.key('hello'))).toBe('Hi');
  });

  it('both loaders failing skips the switch', async () => {
    const store = setup({ preload: true });
    const ns = makeNs({ failDefault: () => true, failSl: () => true });
    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('en-US');
  });

  it('a failing preloaded default does not discard the requested locale', async () => {
    const store = setup({ preload: true });
    const ns = makeNs({ failDefault: () => true });
    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('sl-SI');
    expect(store.formatMessage(ns.key('hello'))).toBe('Zivjo');
  });

  it('a failed requested locale with a preloaded default still switches, with a dev warning', async () => {
    const store = setup({ preload: true });
    const ns = makeNs({ failSl: () => true });
    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('sl-SI');
    expect(store.formatMessage(ns.key('hello'))).toBe('Hi');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('falling back to the default locale'),
    );
  });
});

describe('registerRemoteNamespace TransferState handoff', () => {
  it('the server writes each loaded locale under its own state key', async () => {
    setup({ server: true });
    const ns = makeNs();
    await resolve(ns.resolver, 'en-US');
    await resolve(ns.resolver, 'sl-SI');
    const state = TestBed.inject(TransferState);
    expect(state.get(ns.stateKey('en-US'), null)).toEqual(EN);
    expect(state.get(ns.stateKey('sl-SI'), null)).toEqual(SL);
  });

  it('a preloaded default is written under the default locale key', async () => {
    setup({ server: true, preload: true });
    const ns = makeNs();
    await resolve(ns.resolver, 'sl-SI');
    const state = TestBed.inject(TransferState);
    expect(state.get(ns.stateKey('en-US'), null)).toEqual(EN);
    expect(state.get(ns.stateKey('sl-SI'), null)).toEqual(SL);
  });

  it('the client hydrates each locale from the transferred state without loading', async () => {
    const store = setup();
    const ns = makeNs();
    const state = TestBed.inject(TransferState);
    state.set(ns.stateKey('en-US'), { hello: 'Hi (ssr)' });
    state.set(ns.stateKey('sl-SI'), { hello: 'Zivjo (ssr)' });

    await resolve(ns.resolver, 'en-US');
    expect(store.formatMessage(ns.key('hello'))).toBe('Hi (ssr)');

    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('sl-SI');
    expect(store.formatMessage(ns.key('hello'))).toBe('Zivjo (ssr)');

    expect(ns.counts).toEqual({ def: 0, sl: 0 });
  });
});
