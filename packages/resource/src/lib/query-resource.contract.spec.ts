import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpInterceptorFn,
  type HttpRequest,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
} from '@angular/common/http';
import { EnvironmentInjector, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { providePaused } from '@mmstack/primitives';
import { Observable } from 'rxjs';
import { queryResource } from './query-resource';
import {
  createCacheInterceptor,
  injectQueryCache,
  provideMockQueryCache,
  provideMockResourceSensors,
} from './util';

let calls: HttpRequest<unknown>[];
let auto: boolean;
let failing: boolean;
let pending: (() => void)[];

const server: HttpInterceptorFn = (req) =>
  new Observable<HttpEvent<unknown>>((sub) => {
    calls.push(req);
    const respond = () => {
      if (failing)
        sub.error(new HttpErrorResponse({ status: 500, url: req.url }));
      else {
        sub.next(
          new HttpResponse({
            status: 200,
            body: { url: req.url, n: calls.length },
          }),
        );
        sub.complete();
      }
    };
    if (auto) respond();
    else pending.push(respond);
  });

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function settle() {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await wait();
  }
}
const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);

let online: ReturnType<typeof signal<boolean>>;

function setup(extra: unknown[] = []) {
  calls = [];
  auto = true;
  failing = false;
  pending = [];
  online = signal(true);
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'browser' },
      provideMockQueryCache(),
      provideMockResourceSensors({ networkStatus: online }),
      provideHttpClient(
        withNoXsrfProtection(),
        withInterceptors([createCacheInterceptor(), server]),
      ),
      ...(extra as never[]),
    ],
  });
}

describe('queryResource request contract', () => {
  beforeEach(() => setup());

  it('a dependency change that rebuilds an equal request does not refetch', async () => {
    const bump = signal(0);
    run(() =>
      queryResource(
        () => (bump(), { url: 'https://x/eq', params: { a: '1' } }),
      ),
    );
    await settle();
    bump.set(1);
    await settle();
    expect(calls.length).toBe(1);
  });

  it('a custom equalRequest only sees defined requests', async () => {
    const url = signal<string | undefined>(undefined);
    const res = run(() =>
      queryResource(() => url(), { equalRequest: (a, b) => a.url === b.url }),
    );
    await settle();
    url.set('https://x/u');
    await settle();
    url.set(undefined);
    await settle();
    url.set('https://x/u');
    await settle();
    expect(calls.length).toBe(2);
    expect(res.status()).toBe('resolved');
  });

  it('abort() with nothing in flight keeps a resolved status', async () => {
    const res = run(() => queryResource(() => 'https://x/ab'));
    await settle();
    res.abort();
    expect(res.status()).toBe('resolved');
  });

  it('asReadonly() reads the composed value, also after an error', async () => {
    const res = run(() =>
      queryResource(() => 'https://x/ro', {
        defaultValue: { url: 'none', n: 0 },
      }),
    );
    await settle();
    const ro = res.asReadonly();
    expect(ro.value()).toEqual({ url: 'https://x/ro', n: 1 });
    failing = true;
    res.reload();
    await settle();
    expect(ro.status()).toBe('error');
    expect(() => ro.value()).not.toThrow();
    expect(ro.value()).toEqual(res.value());
  });
});

describe('queryResource pausing contract', () => {
  it('pause: true outside a boundary is a silent no-op', async () => {
    setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    run(() => queryResource(() => 'https://x/p', { pause: true }));
    await settle();
    expect(calls.length).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([
    ['no pause option', undefined],
    ['pause: false', false],
  ])('under a paused boundary, %s still fetches', async (_, pause) => {
    setup([providePaused(signal(true))]);
    run(() => queryResource(() => 'https://x/b', { pause }));
    await settle();
    expect(calls.length).toBe(1);
  });

  it('a resource paused from creation reads safely and fetches on resume', async () => {
    setup();
    const paused = signal(true);
    const res = run(() =>
      queryResource(() => 'https://x/c', { pause: paused }),
    );
    expect(() => [res.value(), res.status()]).not.toThrow();
    await settle();
    expect(calls.length).toBe(0);
    paused.set(false);
    await settle();
    expect(calls.length).toBe(1);
  });

  it('polling does not refetch while paused', async () => {
    setup();
    const paused = signal(false);
    run(() =>
      queryResource(() => 'https://x/poll', { refresh: 20, pause: paused }),
    );
    await settle();
    paused.set(true);
    await settle();
    await wait(70);
    await settle();
    expect(calls.length).toBe(1);
  });
});

describe('queryResource onReconnect', () => {
  beforeEach(() => setup());

  it.each([
    [true, 2],
    [false, 1],
  ])(
    'onReconnect %s: coming back online sends %s requests past a fresh entry',
    async (onReconnect, count) => {
      run(() =>
        queryResource(() => 'https://x/r', {
          cache: { staleTime: 60_000 },
          refresh: { onReconnect },
        }),
      );
      await settle();
      online.set(false);
      await settle();
      online.set(true);
      await settle();
      expect(calls.length).toBe(count);
    },
  );
});

describe('queryResource prefetch', () => {
  beforeEach(() => setup());

  it('resolves without fetching when the query is not cached', async () => {
    const res = run(() => queryResource(() => undefined));
    await res.prefetch({ url: 'https://x/nc' });
    expect(calls.length).toBe(0);
  });

  it('a string prefetch warms the cache for that url', async () => {
    const url = signal<string | undefined>(undefined);
    const res = run(() =>
      queryResource(() => url(), { cache: { staleTime: 60_000 } }),
    );
    await res.prefetch('https://x/pf');
    expect(calls.length).toBe(1);
    url.set('https://x/pf');
    await settle();
    expect(calls.length).toBe(1);
    expect(res.value()).toEqual({ url: 'https://x/pf', n: 1 });
  });

  it('does nothing without a url', async () => {
    const res = run(() => queryResource(() => undefined, { cache: true }));
    await res.prefetch();
    expect(calls.length).toBe(0);
  });

  it('a stale entry is prefetched again', async () => {
    const res = run(() =>
      queryResource(() => undefined, { cache: { staleTime: 0 } }),
    );
    await res.prefetch('https://x/st');
    await res.prefetch('https://x/st');
    expect(calls.length).toBe(2);
  });

  it('stores the parsed body', async () => {
    const url = signal<string | undefined>(undefined);
    const res = run(() =>
      queryResource<{ parsed: unknown }, unknown>(() => url(), {
        cache: { staleTime: 60_000 },
        parse: (raw) => ({ parsed: raw }),
      }),
    );
    await res.prefetch('https://x/parse');
    url.set('https://x/parse');
    await settle();
    expect(res.value()).toEqual({ parsed: { url: 'https://x/parse', n: 1 } });
  });

  it('honors skipTabSync', async () => {
    const spy = vi.spyOn(
      run(() => injectQueryCache()),
      'store',
    );
    const res = run(() =>
      queryResource(() => undefined, { cache: { skipTabSync: true } }),
    );
    await res.prefetch('https://x/sync');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][5]).toBe(false);
  });
});

describe('queryResource refresh triggers and sensors', () => {
  function setupVisibility(
    sensors: Parameters<typeof provideMockResourceSensors>[0],
  ) {
    calls = [];
    auto = true;
    failing = false;
    pending = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideMockQueryCache(),
        provideMockResourceSensors(sensors),
        provideHttpClient(withNoXsrfProtection(), withInterceptors([server])),
      ],
    });
  }

  it('provideMockResourceSensors() with no options is online and enabled', async () => {
    setupVisibility(undefined);
    const res = run(() => queryResource(() => 'https://x/s'));
    await settle();
    expect(res.disabledReason()).toBeNull();
    expect(calls.length).toBe(1);
  });

  it('a provided visibility signal drives onFocus refetches', async () => {
    const vis = signal<DocumentVisibilityState>('visible');
    setupVisibility({ pageVisibility: vis });
    run(() =>
      queryResource(() => 'https://x/f', { refresh: { onFocus: true } }),
    );
    await settle();
    vis.set('hidden');
    await settle();
    vis.set('visible');
    await settle();
    expect(calls.length).toBe(2);
  });

  it('a poll-only refresh ignores focus changes', async () => {
    const vis = signal<DocumentVisibilityState>('visible');
    setupVisibility({ pageVisibility: vis });
    run(() =>
      queryResource(() => 'https://x/i', { refresh: { interval: 60_000 } }),
    );
    await settle();
    vis.set('hidden');
    await settle();
    vis.set('visible');
    await settle();
    expect(calls.length).toBe(1);
  });

  it('onFocus works with an explicit injector outside an injection context', async () => {
    const vis = signal<DocumentVisibilityState>('visible');
    setupVisibility({ pageVisibility: vis });
    const injector = TestBed.inject(EnvironmentInjector);
    expect(() =>
      queryResource(() => 'https://x/inj', {
        injector,
        refresh: { onFocus: true },
      }),
    ).not.toThrow();
    await settle();
    vis.set('hidden');
    await settle();
    vis.set('visible');
    await settle();
    expect(calls.length).toBe(2);
  });

  it('destroy() with only event triggers stops the query', async () => {
    setupVisibility(undefined);
    const url = signal('https://x/d1');
    const res = run(() =>
      queryResource(() => url(), { refresh: { onFocus: true } }),
    );
    await settle();
    res.destroy();
    url.set('https://x/d2');
    await settle();
    expect(calls.length).toBe(1);
  });
});
