import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpInterceptorFn,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
} from '@angular/common/http';
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable } from 'rxjs';
import { manualQueryResource } from './manual-query';
import { provideMockQueryCache, provideMockResourceSensors } from './util';

type Pending = {
  url: string;
  respond: (body: unknown) => void;
  fail: (status?: number) => void;
  closed: () => boolean;
};

let inFlight: Pending[];

const deferred: HttpInterceptorFn = (req) =>
  new Observable<HttpEvent<unknown>>((sub) => {
    let closed = false;
    inFlight.push({
      url: req.urlWithParams,
      respond: (body) => {
        sub.next(new HttpResponse({ body, status: 200 }));
        sub.complete();
      },
      fail: (status = 500) =>
        sub.error(new HttpErrorResponse({ status, url: req.url })),
      closed: () => closed,
    });
    return () => {
      closed = true;
    };
  });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle() {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await wait(0);
  }
}

function state(p: Promise<unknown>) {
  let s: 'pending' | 'resolved' | 'rejected' = 'pending';
  let reason: unknown;
  p.then(
    () => (s = 'resolved'),
    (e) => {
      s = 'rejected';
      reason = e;
    },
  );
  return { get: () => s, reason: () => reason };
}

beforeEach(() => {
  inFlight = [];
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'browser' },
      provideMockQueryCache(),
      provideMockResourceSensors(),
      provideHttpClient(withNoXsrfProtection(), withInterceptors([deferred])),
    ],
  });
});

describe('manualQueryResource trigger contract', () => {
  it.each([
    ['a string request', () => 'https://x/search'],
    [
      'an object request',
      () => ({ url: 'https://x/search', params: { q: 'a' } }),
    ],
  ])(
    'a repeated equal trigger fetches again and settles (%s)',
    async (_, fn) => {
      const res = TestBed.runInInjectionContext(() => manualQueryResource(fn));
      const first = res.trigger();
      await settle();
      inFlight.shift()?.respond({ n: 1 });
      await expect(first).resolves.toEqual({ n: 1 });

      const second = res.trigger();
      await settle();
      expect(inFlight.length).toBe(1);
      inFlight.shift()?.respond({ n: 2 });
      await expect(second).resolves.toEqual({ n: 2 });
    },
  );

  it('with retry, resolves with the value of a successful retry', async () => {
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource(() => 'https://x/r', {
        retry: { max: 2, backoff: 5 },
      }),
    );
    const p = state(res.trigger());
    await settle();
    inFlight.shift()?.fail();
    await settle();
    expect(p.get()).toBe('pending');
    await wait(20);
    await settle();
    inFlight.shift()?.respond({ ok: true });
    await settle();
    expect(p.get()).toBe('resolved');
    expect(res.value()).toEqual({ ok: true });
  });

  it('with retry, rejects once the retries are exhausted', async () => {
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource(() => 'https://x/r2', {
        retry: { max: 1, backoff: 5 },
      }),
    );
    const p = state(res.trigger());
    await settle();
    inFlight.shift()?.fail();
    await wait(20);
    await settle();
    expect(p.get()).toBe('pending');
    inFlight.shift()?.fail(503);
    await settle();
    expect(p.get()).toBe('rejected');
    expect((p.reason() as HttpErrorResponse).status).toBe(503);
  });

  it('rejects with an AbortError when the load is aborted', async () => {
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource(() => 'https://x/a'),
    );
    const p = state(res.trigger());
    await settle();
    res.abort();
    await settle();
    expect(p.get()).toBe('rejected');
    expect((p.reason() as DOMException).name).toBe('AbortError');
  });

  it('rejects with an AbortError when a value write aborts the load', async () => {
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource<{ n: number }>(() => 'https://x/w'),
    );
    const p = state(res.trigger());
    await settle();
    res.set({ n: 9 });
    await settle();
    expect(p.get()).toBe('rejected');
    expect((p.reason() as DOMException).name).toBe('AbortError');
  });

  it('destroy() mid-flight rejects with an AbortError and stops the query', async () => {
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource(() => 'https://x/d'),
    );
    const p = state(res.trigger());
    await settle();
    const req = inFlight[0];
    res.destroy();
    await settle();
    expect(p.get()).toBe('rejected');
    expect((p.reason() as DOMException).name).toBe('AbortError');
    expect(res.status()).toBe('idle');
    expect(req.closed()).toBe(true);
  });

  it('a trigger issued while paused waits for its own load, not the old value', async () => {
    const paused = signal(false);
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource<{ id: number }>(() => 'https://x/p', {
        pause: paused,
      }),
    );
    const first = res.trigger();
    await settle();
    inFlight.shift()?.respond({ id: 1 });
    await expect(first).resolves.toEqual({ id: 1 });

    paused.set(true);
    await settle();
    const second = state(res.trigger('https://x/p2'));
    await settle();
    expect(second.get()).toBe('pending');
    expect(inFlight.length).toBe(0);

    paused.set(false);
    await settle();
    inFlight.shift()?.respond({ id: 2 });
    await settle();
    expect(second.get()).toBe('resolved');
    expect(res.value()).toEqual({ id: 2 });
  });
});
