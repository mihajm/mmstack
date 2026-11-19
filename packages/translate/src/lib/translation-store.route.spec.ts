import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import {
  injectLocaleInternal,
  provideIntlConfig,
  TranslationStore,
} from './translation-store';

@Component({ selector: 'mm-route-dummy', template: '' })
class Dummy {}

const routes: Routes = [
  { path: 'plain', component: Dummy },
  {
    path: ':locale',
    component: Dummy,
    children: [
      { path: '', component: Dummy },
      { path: 'nested/:locale', component: Dummy },
    ],
  },
];

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r));
  }
  TestBed.tick();
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      provideIntlConfig({
        defaultLocale: 'en-US',
        supportedLocales: ['en-US', 'sl-SI', 'de-DE'],
        localeParamName: 'locale',
      }),
    ],
  });
  TestBed.runInInjectionContext(() => injectLocaleInternal().set('en-US'));
  return TestBed.inject(Router);
}

async function go(router: Router, url: string) {
  await router.navigateByUrl(url);
  await flush();
}

describe('TranslationStore route locale param', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    TestBed.runInInjectionContext(() => injectLocaleInternal().set('en-US'));
  });

  it('a navigation switches to the URL locale without a namespace resolver', async () => {
    const router = setup();
    const store = TestBed.inject(TranslationStore);
    store.register('x', { 'sl-SI': { k: 'v' } });
    await go(router, '/sl-SI');
    expect(store.locale()).toBe('sl-SI');
  });

  it('the deepest route param wins', async () => {
    const router = setup();
    const store = TestBed.inject(TranslationStore);
    await go(router, '/sl-SI/nested/de-DE');
    expect(store.locale()).toBe('de-DE');
  });

  it('a store created after navigation reads the current URL locale', async () => {
    const router = setup();
    await router.navigateByUrl('/sl-SI');
    const store = TestBed.inject(TranslationStore);
    await flush();
    expect(store.locale()).toBe('sl-SI');
  });

  it('a route without the param keeps the current locale', async () => {
    const router = setup();
    const store = TestBed.inject(TranslationStore);
    await go(router, '/plain');
    expect(store.locale()).toBe('en-US');
  });

  it('a URL locale with no translations and no loaders still switches', async () => {
    const router = setup();
    const store = TestBed.inject(TranslationStore);
    await go(router, '/de-DE');
    expect(store.locale()).toBe('de-DE');
  });

  it('a URL locale with loaders loads its translations before switching', async () => {
    const router = setup();
    const store = TestBed.inject(TranslationStore);
    store.registerOnDemandLoaders('ns', {
      'sl-SI': () => Promise.resolve({ namespace: 'ns', flat: { k: 'Zivjo' } }),
    });
    await go(router, '/sl-SI');
    expect(store.locale()).toBe('sl-SI');
    expect(store.formatMessage('ns::MMT_DELIM::k')).toBe('Zivjo');
    expect(store.loadQueue()).toEqual([]);
  });

  it('navigating back to the current locale cancels a pending switch', async () => {
    const router = setup();
    const store = TestBed.inject(TranslationStore);
    const sl = deferred<{ namespace: string; flat: Record<string, string> }>();
    store.registerOnDemandLoaders('ns', { 'sl-SI': () => sl.promise });
    await go(router, '/en-US');
    await go(router, '/sl-SI');
    await go(router, '/en-US');
    sl.resolve({ namespace: 'ns', flat: { k: 'Zivjo' } });
    await flush();
    expect(store.locale()).toBe('en-US');
  });
});
