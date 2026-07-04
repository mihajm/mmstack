import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { signal } from '@angular/core';
import { retry, throwError } from 'rxjs';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { memorySink, type MemorySink } from './memory-sink';
import { provideTelemetry } from './provide';
import { TELEMETRY } from './telemetry';
import { telemetryInterceptor, withTelemetryParent } from './http-interceptor';

describe('telemetryInterceptor', () => {
  function setup(withTelemetry = true): {
    http: HttpClient;
    ctrl: HttpTestingController;
    sink: MemorySink;
  } {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([telemetryInterceptor])),
        provideHttpClientTesting(),
        ...(withTelemetry ? [provideTelemetry({ sinks: [sink] })] : []),
      ],
    });
    return {
      http: TestBed.inject(HttpClient),
      ctrl: TestBed.inject(HttpTestingController),
      sink,
    };
  }

  it('records a span per request with conservative attrs (no query) and a status', () => {
    const { http, ctrl, sink } = setup();
    http.get('https://api.example.com/todos?secret=abc&_start=5').subscribe();

    ctrl
      .expectOne((r) => r.url.startsWith('https://api.example.com/todos'))
      .flush([{ id: 1 }]);

    expect(sink.spans.length).toBe(1);
    const span = sink.spans[0];
    expect(span.name).toBe('HTTP GET');
    expect(span.attrs['http.method']).toBe('GET');
    expect(span.attrs['http.target']).toBe('api.example.com/todos'); // host+path, NO query
    expect(span.attrs['http.status_code']).toBe(200);
    expect(typeof span.attrs['http.duration_ms']).toBe('number');
    expect(span.ended).toBe(true);
    ctrl.verify();
  });

  it('records the error status and marks the span errored on failure', () => {
    const { http, ctrl, sink } = setup();
    http.get('/api/x').subscribe({ error: () => undefined });

    ctrl
      .expectOne('/api/x')
      .flush('nope', { status: 500, statusText: 'Server Error' });

    const span = sink.spans[0];
    expect(span.attrs['http.status_code']).toBe(500);
    expect(span.error).toBeDefined();
    expect(span.ended).toBe(true);
    ctrl.verify();
  });

  it('nests the HTTP span under a parent via withTelemetryParent', () => {
    const { http, ctrl, sink } = setup();
    const telemetry = TestBed.inject(TELEMETRY);
    const parent = telemetry.startSpan('interaction');

    http.get('/api/x', { context: withTelemetryParent(parent) }).subscribe();
    ctrl.expectOne('/api/x').flush({});
    parent.end();

    const httpSpan = sink.spans.find((s) => s.name === 'HTTP GET');
    const parentSpan = sink.spans.find((s) => s.name === 'interaction');
    expect(httpSpan?.ctx.traceId).toBe(parentSpan?.ctx.traceId);
    expect(httpSpan?.ctx.parentSpanId).toBe(parentSpan?.ctx.spanId);
    ctrl.verify();
  });

  it('is inert when telemetry is the noop (request still works)', () => {
    const { http, ctrl } = setup(false);
    let response: unknown;
    http.get('/api/x').subscribe((r) => (response = r));
    ctrl.expectOne('/api/x').flush({ ok: true });

    expect(response).toEqual({ ok: true });
    expect(TestBed.inject(TELEMETRY).enabled()).toBe(false);
    ctrl.verify();
  });

  it('ends the span with an error when a downstream interceptor throws synchronously', () => {
    const sink = memorySink();
    const boom = new Error('sync fail');
    const failing: HttpInterceptorFn = () => {
      throw boom;
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([telemetryInterceptor, failing])),
        provideHttpClientTesting(),
        provideTelemetry({ sinks: [sink] }),
      ],
    });

    let caught: unknown;
    TestBed.inject(HttpClient)
      .get('/api/x')
      .subscribe({ error: (e: unknown) => (caught = e) });

    expect(caught).toBe(boom);
    const span = sink.spans[0];
    expect(span.error).toBe(boom);
    expect(span.ended).toBe(true);
    expect(typeof span.attrs['http.duration_ms']).toBe('number');
    expect(span.attrs['http.status_code']).toBeUndefined();
  });

  it('spans each retry attempt separately (one span per subscription)', () => {
    const { http, ctrl, sink } = setup();
    http
      .get('/api/x')
      .pipe(retry(1))
      .subscribe({ error: () => undefined });

    ctrl.expectOne('/api/x').flush('nope', { status: 500, statusText: 'Server Error' });
    ctrl.expectOne('/api/x').flush('nope', { status: 500, statusText: 'Server Error' });

    expect(sink.spans.length).toBe(2);
    const [first, second] = sink.spans;
    expect(first.ctx.spanId).not.toBe(second.ctx.spanId);
    expect(first.ended).toBe(true);
    expect(second.ended).toBe(true);
    ctrl.verify();
  });

  it('computes http.duration_ms from the actual elapsed time', () => {
    let clock = 1_000;
    const nowSpy = vi
      .spyOn(globalThis.performance, 'now')
      .mockImplementation(() => clock);
    try {
      const { http, ctrl, sink } = setup();
      http.get('/api/x').subscribe();
      clock = 1_250; // request "takes" 250ms
      ctrl.expectOne('/api/x').flush({});

      expect(sink.spans[0].attrs['http.duration_ms']).toBe(250);
      ctrl.verify();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('ends the span with a duration but no status when the request is aborted', () => {
    const { http, ctrl, sink } = setup();
    const sub = http.get('/api/x').subscribe();
    const req = ctrl.expectOne('/api/x');
    sub.unsubscribe();

    expect(req.cancelled).toBe(true);
    const span = sink.spans[0];
    expect(span.ended).toBe(true);
    expect(typeof span.attrs['http.duration_ms']).toBe('number');
    expect(span.attrs['http.status_code']).toBeUndefined();
    expect(span.error).toBeUndefined();
  });

  it('records a transport failure as status 0 with the error, and still ends the span', () => {
    const { http, ctrl, sink } = setup();
    let caught: unknown;
    http.get('/api/x').subscribe({ error: (e: unknown) => (caught = e) });
    ctrl.expectOne('/api/x').error(new ProgressEvent('error'));

    const span = sink.spans[0];
    expect(span.attrs['http.status_code']).toBe(0); // HttpErrorResponse for a network failure
    expect(span.error).toBe(caught);
    expect(span.ended).toBe(true);
    ctrl.verify();
  });

  it('records a non-HttpErrorResponse error without any status code and still ends the span', () => {
    const sink = memorySink();
    const boom = new Error('sync fail');
    const failing: HttpInterceptorFn = () => throwError(() => boom);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([telemetryInterceptor, failing])),
        provideHttpClientTesting(),
        provideTelemetry({ sinks: [sink] }),
      ],
    });

    let caught: unknown;
    TestBed.inject(HttpClient)
      .get('/api/x')
      .subscribe({ error: (e: unknown) => (caught = e) });

    expect(caught).toBe(boom);
    const span = sink.spans[0];
    expect(span.attrs['http.status_code']).toBeUndefined();
    expect(span.error).toBe(boom);
    expect(span.ended).toBe(true);
  });

  it('strips the query from relative URLs too', () => {
    const { http, ctrl, sink } = setup();
    http.get('/api/x?token=secret').subscribe();
    ctrl.expectOne((r) => r.url.startsWith('/api/x')).flush({});

    expect(sink.spans[0].attrs['http.target']).toBe('/api/x');
    ctrl.verify();
  });

  it('ignores non-Response events: no status until the response, no premature end', () => {
    const { http, ctrl, sink } = setup();
    http
      .get('/api/x', { reportProgress: true, observe: 'events' })
      .subscribe();
    const req = ctrl.expectOne('/api/x');

    req.event({ type: 3, loaded: 5, total: 10 } as never); // DownloadProgress
    const span = sink.spans[0];
    expect(span.attrs['http.status_code']).toBeUndefined();
    expect(span.ended).toBe(false);

    req.flush({});
    expect(span.attrs['http.status_code']).toBe(200);
    expect(span.ended).toBe(true);
    ctrl.verify();
  });

  it('buffers the HTTP span while the sink is pending and replays it on ready', () => {
    const ready = signal(false);
    const sink = memorySink('m', ready);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([telemetryInterceptor])),
        provideHttpClientTesting(),
        provideTelemetry({ sinks: [sink] }),
      ],
    });
    const http = TestBed.inject(HttpClient);
    const ctrl = TestBed.inject(HttpTestingController);

    http.get('/api/x').subscribe();
    ctrl.expectOne('/api/x').flush({});
    expect(sink.spans).toEqual([]); // settled request, still buffered

    ready.set(true);
    TestBed.tick();

    const span = sink.spans[0];
    expect(span.name).toBe('HTTP GET');
    expect(span.attrs['http.status_code']).toBe(200);
    expect(typeof span.attrs['http.duration_ms']).toBe('number');
    expect(span.ended).toBe(true);
    ctrl.verify();
  });
});
