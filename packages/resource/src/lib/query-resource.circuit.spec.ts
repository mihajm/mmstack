import {
  HttpErrorResponse,
  type HttpInterceptorFn,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
} from '@angular/common/http';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { provideResourceOptions } from './options';
import { queryResource } from './query-resource';
import {
  createCircuitBreaker,
  provideMockQueryCache,
  provideMockResourceSensors,
} from './util';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    TestBed.tick();
    await wait(0);
  }
}

function setup(extra: unknown[] = []) {
  const server = { failing: true, calls: 0 };
  const interceptor: HttpInterceptorFn = (req) => {
    server.calls++;
    return server.failing
      ? throwError(() => new HttpErrorResponse({ status: 500, url: req.url }))
      : of(new HttpResponse({ status: 200, body: { ok: server.calls } }));
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'browser' },
      provideMockQueryCache(),
      provideMockResourceSensors(),
      provideHttpClient(
        withNoXsrfProtection(),
        withInterceptors([interceptor]),
      ),
      ...(extra as never[]),
    ],
  });
  return server;
}

describe('queryResource circuit breaker', () => {
  it('reports circuit-open, then sends a trial after the timeout and recovers', async () => {
    const server = setup();
    const res = TestBed.runInInjectionContext(() =>
      queryResource<{ ok: number }>(() => 'https://x/cb', {
        circuitBreaker: { threshold: 2, timeout: 40 },
      }),
    );
    await settle();
    expect(res.status()).toBe('error');
    res.reload();
    await settle();
    expect(server.calls).toBe(2);
    expect(res.disabledReason()).toBe('circuit-open');
    expect(res.disabled()).toBe(true);

    server.failing = false;
    await wait(60);
    await settle();
    expect(server.calls).toBe(3);
    expect(res.disabledReason()).toBeNull();
    expect(res.status()).toBe('resolved');
    expect(res.value()).toEqual({ ok: 3 });
  });

  it('re-opens on a failed trial and tries again after another timeout', async () => {
    const server = setup();
    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => 'https://x/cb2', {
        circuitBreaker: { threshold: 1, timeout: 40 },
      }),
    );
    await settle();
    expect(res.disabledReason()).toBe('circuit-open');

    await wait(60);
    await settle();
    expect(server.calls).toBe(2);
    expect(res.disabledReason()).toBe('circuit-open');

    server.failing = false;
    await wait(60);
    await settle();
    expect(server.calls).toBe(3);
    expect(res.status()).toBe('resolved');
  });

  it('resets the failure count on success', async () => {
    const server = setup();
    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => 'https://x/cb3', {
        circuitBreaker: { threshold: 2, timeout: 10_000 },
      }),
    );
    await settle();
    server.failing = false;
    res.reload();
    await settle();
    expect(res.status()).toBe('resolved');
    server.failing = true;
    res.reload();
    await settle();
    expect(res.status()).toBe('error');
    expect(res.disabled()).toBe(false);
  });

  it('a per-call false opts out of a provided default', async () => {
    const server = setup([provideResourceOptions({ circuitBreaker: true })]);
    const res = TestBed.runInInjectionContext(() =>
      queryResource(() => 'https://x/cb4', { circuitBreaker: false }),
    );
    for (let i = 0; i < 6; i++) {
      await settle();
      res.reload();
    }
    await settle();
    expect(server.calls).toBe(7);
    expect(res.disabled()).toBe(false);
  });

  it('destroying one resource leaves a shared breaker working for the others', async () => {
    const server = setup();
    const shared = TestBed.runInInjectionContext(() =>
      createCircuitBreaker({ threshold: 1, timeout: 40 }),
    );
    const [a, b] = TestBed.runInInjectionContext(() => [
      queryResource(() => 'https://x/a', { circuitBreaker: shared }),
      queryResource(() => 'https://x/b', { circuitBreaker: shared }),
    ]);
    await settle();
    expect(shared.status()).toBe('OPEN');
    a.destroy();

    server.failing = false;
    await wait(60);
    await settle();
    expect(shared.status()).toBe('CLOSED');
    expect(b.status()).toBe('resolved');
  });
});
