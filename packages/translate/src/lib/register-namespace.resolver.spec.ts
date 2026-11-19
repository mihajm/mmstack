import { untracked } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  convertToParamMap,
  provideRouter,
  type ActivatedRouteSnapshot,
  type ResolveFn,
  type RouterStateSnapshot,
} from '@angular/router';
import { createNamespace } from './create-namespace';
import { registerNamespace } from './register-namespace';
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

function setup(opts: { preload?: boolean; config?: boolean } = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
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

let nsId = 0;

function makeNs(
  opts: {
    failDefault?: (call: number) => boolean;
    failSl?: (call: number) => boolean;
  } = {},
) {
  const name = `rs${nsId++}`;
  const demo = createNamespace(name, { hello: 'Hi' });
  const sl = demo.createTranslation('sl-SI', { hello: 'Zivjo' });
  const counts = { def: 0, sl: 0 };
  const [injectT, resolver, warm] = registerNamespace(
    () => {
      counts.def++;
      return opts.failDefault?.(counts.def)
        ? Promise.reject(new Error('default down'))
        : Promise.resolve(demo.translation);
    },
    {
      'sl-SI': () => {
        counts.sl++;
        return opts.failSl?.(counts.sl)
          ? Promise.reject(new Error('sl down'))
          : Promise.resolve(sl);
      },
    },
  );
  const key = `${name}::MMT_DELIM::hello`;
  const warmIn = (locale?: string) =>
    TestBed.runInInjectionContext(() => warm(locale));
  return { injectT, resolver, warm: warmIn, counts, key };
}

describe('registerNamespace loading and resolver', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warnSpy.mockRestore());

  it('loads the default bundle once across repeated default-locale warms', async () => {
    const store = setup();
    const ns = makeNs();
    await ns.warm('en-US');
    await ns.warm('en-US');
    expect(ns.counts.def).toBe(1);
    expect(store.formatMessage(ns.key)).toBe('Hi');
  });

  it('a loaded default does not block loading another locale', async () => {
    const store = setup();
    const ns = makeNs();
    await ns.warm('en-US');
    await ns.warm('sl-SI');
    expect(ns.counts.sl).toBe(1);
    store.locale.set('sl-SI');
    expect(store.formatMessage(ns.key)).toBe('Zivjo');
  });

  it('loading another locale does not mark the default as loaded', async () => {
    const store = setup();
    const ns = makeNs();
    await ns.warm('sl-SI');
    await ns.warm('en-US');
    expect(ns.counts.def).toBe(1);
    store.locale.set('en-US');
    expect(store.formatMessage(ns.key)).toBe('Hi');
  });

  it('with preloadDefaultLocale, a default-locale warm fetches the default once', async () => {
    setup({ preload: true });
    const ns = makeNs();
    await ns.warm('en-US');
    expect(ns.counts.def).toBe(1);
  });

  it('with preloadDefaultLocale, warming another locale also loads the default', async () => {
    const store = setup({ preload: true });
    const ns = makeNs();
    await ns.warm('sl-SI');
    expect(ns.counts.def).toBe(1);
    expect(ns.counts.sl).toBe(1);
    expect(store.formatMessage(ns.key)).toBe('Hi');
  });

  it('without preloadDefaultLocale, resolving another locale does not load the default', async () => {
    const store = setup();
    const ns = makeNs();
    await resolve(ns.resolver, 'sl-SI');
    expect(ns.counts.def).toBe(0);
    expect(untracked(store.locale)).toBe('sl-SI');
  });

  it('a failing preloaded default does not discard the requested locale', async () => {
    const store = setup({ preload: true });
    const ns = makeNs({ failDefault: () => true });
    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('sl-SI');
    expect(store.formatMessage(ns.key)).toBe('Zivjo');
  });

  it('a failed default load is retried on the next warm', async () => {
    const store = setup();
    const ns = makeNs({ failDefault: (n) => n === 1 });
    await ns.warm();
    await ns.warm();
    expect(ns.counts.def).toBe(2);
    expect(store.formatMessage(ns.key)).toBe('Hi');
  });

  it('switches the locale after a successful resolve', async () => {
    const store = setup();
    const ns = makeNs();
    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('sl-SI');
    expect(store.formatMessage(ns.key)).toBe('Zivjo');
  });

  it('re-resolving an already loaded locale switches back to it', async () => {
    const store = setup();
    const ns = makeNs();
    await resolve(ns.resolver, 'sl-SI');
    store.locale.set('en-US');
    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('sl-SI');
    expect(ns.counts.sl).toBe(1);
  });

  it('re-resolving the cached default locale switches back to it', async () => {
    const store = setup({ preload: true });
    const ns = makeNs();
    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('sl-SI');
    await resolve(ns.resolver, 'en-US');
    expect(untracked(store.locale)).toBe('en-US');
    expect(ns.counts.def).toBe(1);
  });

  it('a failed load skips the locale switch', async () => {
    const store = setup();
    const ns = makeNs({ failSl: () => true });
    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('en-US');
  });

  it('a failed requested locale with a preloaded default still switches, with a dev warning', async () => {
    const store = setup({ preload: true });
    const ns = makeNs({ failSl: () => true });
    await resolve(ns.resolver, 'sl-SI');
    expect(untracked(store.locale)).toBe('sl-SI');
    expect(store.formatMessage(ns.key)).toBe('Hi');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('falling back to the default locale'),
    );
  });

  it('works without provideIntlConfig', async () => {
    const store = setup({ config: false });
    const ns = makeNs();
    await resolve(ns.resolver);
    expect(ns.counts.def).toBe(1);
    expect(store.formatMessage(ns.key)).toBe('Hi');
  });
});
