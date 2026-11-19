import {
  type HttpEvent,
  HttpHeaders,
  type HttpInterceptorFn,
  type HttpRequest,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
} from '@angular/common/http';
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable } from 'rxjs';
import { queryResource } from './query-resource';
import {
  createCacheInterceptor,
  injectQueryCache,
  provideMockQueryCache,
  provideMockResourceSensors,
} from './util';

type Call = {
  req: HttpRequest<unknown>;
  respond: (body?: unknown, headers?: Record<string, string>) => void;
};
let calls: Call[];
let auto: boolean;

const server: HttpInterceptorFn = (req) =>
  new Observable<HttpEvent<unknown>>((sub) => {
    const respond = (
      body: unknown = { url: req.url },
      headers: Record<string, string> = {},
    ) => {
      sub.next(
        new HttpResponse({
          status: 200,
          body,
          headers: new HttpHeaders(headers),
          url: req.url,
        }),
      );
      sub.complete();
    };
    const call = { req, respond };
    calls.push(call);
    if (auto)
      respond(
        req.responseType === 'arraybuffer' ? new ArrayBuffer(4) : undefined,
      );
  });

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function settle() {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await wait();
  }
}
const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
const cache = () => run(() => injectQueryCache());

beforeEach(() => {
  calls = [];
  auto = true;
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'browser' },
      provideMockQueryCache(),
      provideMockResourceSensors(),
      provideHttpClient(
        withNoXsrfProtection(),
        withInterceptors([createCacheInterceptor(), server]),
      ),
    ],
  });
});

describe('queryResource cache composition', () => {
  it('varyHeaders partitions the cache by header', async () => {
    const make = (auth: string) =>
      run(() =>
        queryResource(
          () => ({ url: 'https://x/me', headers: { Authorization: auth } }),
          {
            cache: { staleTime: 60_000, varyHeaders: ['Authorization'] },
          },
        ),
      );
    make('a');
    await settle();
    make('b');
    await settle();
    expect(calls.length).toBe(2);
  });

  it('a raw variant shares local writes through the cache', async () => {
    auto = false;
    const a = run(() =>
      queryResource.text(() => 'https://x/t', { cache: true }),
    );
    await settle();
    a.set('x');
    const b = run(() =>
      queryResource.text(() => 'https://x/t', { cache: true }),
    );
    await settle();
    expect(b.value()).toBe('x');
  });

  it('an expired entry is not served after its ttl', async () => {
    run(() =>
      queryResource(() => 'https://x/ttl', {
        cache: { ttl: 30, staleTime: 30 },
      }),
    );
    await settle();
    await wait(60);
    auto = false;
    const b = run(() =>
      queryResource(() => 'https://x/ttl', {
        cache: { ttl: 30, staleTime: 30 },
      }),
    );
    await settle();
    expect(b.value()).toBeUndefined();
  });

  it('starts disabled with cache on without throwing, then loads', async () => {
    const url = signal<string | undefined>(undefined);
    const res = run(() =>
      queryResource<{ url: string }>(() => url(), { cache: true }),
    );
    expect(() => res.value()).not.toThrow();
    await settle();
    url.set('https://x/late');
    await settle();
    expect(res.value()).toEqual({ url: 'https://x/late' });
  });

  it.each([
    [true, true],
    [false, false],
  ])(
    'bustBrowserCache %s adds a cache-busting param: %s',
    async (bust, expected) => {
      run(() =>
        queryResource(() => 'https://x/b', {
          cache: { bustBrowserCache: bust },
        }),
      );
      await settle();
      expect(calls[0].req.params.has('_cb')).toBe(expected);
    },
  );

  it.each([
    [false, 2],
    [true, 1],
  ])(
    'no-store with ignoreCacheControl %s sends %s requests for two mounts',
    async (ignore, count) => {
      auto = false;
      const opt = { cache: { staleTime: 60_000, ignoreCacheControl: ignore } };
      run(() => queryResource(() => 'https://x/ns', opt));
      await settle();
      calls[0].respond({ n: 1 }, { 'Cache-Control': 'no-store' });
      await settle();
      run(() => queryResource(() => 'https://x/ns', opt));
      await settle();
      expect(calls.length).toBe(count);
    },
  );

  it('set() does not persist without cache.persist', async () => {
    const spy = vi.spyOn(cache(), 'store');
    const res = run(() =>
      queryResource(() => 'https://x/p', { cache: { staleTime: 1000 } }),
    );
    await settle();
    res.set({ v: 1 });
    expect(spy.mock.calls.at(-1)?.[4]).toBe(false);
  });

  it('set() without cache never writes the shared cache', async () => {
    const spy = vi.spyOn(cache(), 'store');
    const res = run(() => queryResource(() => 'https://x/nc'));
    await settle();
    res.set({ v: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps showing the cached body when its entry is invalidated mid-revalidation', async () => {
    run(() => queryResource(() => 'https://x/h', { cache: { staleTime: 0 } }));
    await settle();
    auto = false;
    const b = run(() =>
      queryResource(() => 'https://x/h', { cache: { staleTime: 0 } }),
    );
    await settle();
    expect(b.value()).toEqual({ url: 'https://x/h' });
    expect(calls.length).toBe(2);
    cache().invalidateUrlPrefix('https://x/h');
    await settle();
    expect(b.value()).toEqual({ url: 'https://x/h' });
  });

  it('does not show the old key’s body after a change to an uncached url', async () => {
    const url = signal('https://x/one');
    const res = run(() => queryResource(() => url(), { cache: true }));
    await settle();
    auto = false;
    url.set('https://x/two');
    await settle();
    expect(res.value()).toBeUndefined();
  });

  it('outcome shows a cache-served value while the revalidation is in flight', async () => {
    run(() => queryResource(() => 'https://x/o', { cache: { staleTime: 0 } }));
    await settle();
    auto = false;
    const b = run(() =>
      queryResource(() => 'https://x/o', { cache: { staleTime: 0 } }),
    );
    await settle();
    expect(b.isLoading()).toBe(true);
    expect(b.outcome()).toEqual({ url: 'https://x/o' });
  });

  it('dev-warns when a cached ArrayBuffer was detached, and only then', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = run(() =>
      queryResource.arrayBuffer(() => 'https://x/buf', { cache: true }),
    );
    await settle();
    const b = run(() =>
      queryResource.arrayBuffer(() => 'https://x/buf', { cache: true }),
    );
    await settle();
    b.value();
    expect(warn).not.toHaveBeenCalled();
    structuredClone(a.value(), { transfer: [a.value() as ArrayBuffer] });
    auto = false;
    const c = run(() =>
      queryResource.arrayBuffer(() => 'https://x/buf', { cache: true }),
    );
    await settle();
    c.value();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('detached');
    warn.mockRestore();
  });
});
