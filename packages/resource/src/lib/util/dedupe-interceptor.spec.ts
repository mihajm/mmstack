import {
  HttpContext,
  type HttpEvent,
  type HttpHandlerFn,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Observable, of, Subject } from 'rxjs';
import { createDedupeRequestsInterceptor, noDedupe } from './dedupe-interceptor';

describe('dedupe-interceptor', () => {
  describe('noDedupe', () => {
    it('should set NO_DEDUPE token on context', () => {
      const ctx = noDedupe();
      expect(ctx).toBeInstanceOf(HttpContext);
    });

    it('should modify an existing context', () => {
      const ctx = new HttpContext();
      const result = noDedupe(ctx);
      expect(result).toBe(ctx);
    });
  });

  describe('createDedupeRequestsInterceptor', () => {
    it('should pass through non-deduped methods (POST)', () => {
      let callCount = 0;
      const interceptor = createDedupeRequestsInterceptor();
      const mockNext: HttpHandlerFn = () => {
        callCount++;
        return of(new HttpResponse({ status: 200 }));
      };

      const req = new HttpRequest('POST', '/api/data', { payload: true });
      interceptor(req, mockNext).subscribe();
      expect(callCount).toBe(1);
    });

    it('should dedupe identical GET requests that are in-flight', () => {
      let callCount = 0;
      const subject = new Subject<HttpEvent<unknown>>();
      const interceptor = createDedupeRequestsInterceptor();
      const mockNext: HttpHandlerFn = () => {
        callCount++;
        return subject.asObservable();
      };

      const req = new HttpRequest('GET', '/api/users');

      // Subscribe twice while the request is still in-flight
      const results: HttpEvent<unknown>[] = [];
      interceptor(req, mockNext).subscribe((r) => results.push(r));
      interceptor(req, mockNext).subscribe((r) => results.push(r));

      expect(callCount).toBe(1); // Only one actual HTTP call

      // Complete the request
      const response = new HttpResponse({ status: 200, body: 'ok' });
      subject.next(response);
      subject.complete();

      // Both subscribers received the same response
      expect(results.length).toBe(2);
      expect(results[0]).toBe(results[1]);
    });

    it('should not dedupe when noDedupe context is set', () => {
      let callCount = 0;
      const interceptor = createDedupeRequestsInterceptor();
      const mockNext: HttpHandlerFn = () => {
        callCount++;
        return of(new HttpResponse({ status: 200 }));
      };

      const ctx = noDedupe();
      const req = new HttpRequest('GET', '/api/users', { context: ctx });

      interceptor(req, mockNext).subscribe();
      interceptor(req, mockNext).subscribe();

      expect(callCount).toBe(2);
    });

    it('should clean up in-flight entry after completion', () => {
      let callCount = 0;
      const interceptor = createDedupeRequestsInterceptor();
      const mockNext: HttpHandlerFn = () => {
        callCount++;
        return of(new HttpResponse({ status: 200 }));
      };

      const req = new HttpRequest('GET', '/api/users');

      // First request completes synchronously
      interceptor(req, mockNext).subscribe();
      expect(callCount).toBe(1);

      // After completion, a new request should go through
      interceptor(req, mockNext).subscribe();
      expect(callCount).toBe(2);
    });

    it('should not dedupe GET and DELETE to the same URL together', () => {
      const subject = new Subject<HttpEvent<unknown>>();
      let calls = 0;
      const interceptor = createDedupeRequestsInterceptor();
      const mockNext: HttpHandlerFn = () => {
        calls++;
        return subject.asObservable();
      };

      interceptor(new HttpRequest('GET', '/api/users'), mockNext).subscribe();
      interceptor(
        new HttpRequest('DELETE', '/api/users'),
        mockNext,
      ).subscribe();

      expect(calls).toBe(2);
    });

    it('should not dedupe requests differing only in body', () => {
      const subject = new Subject<HttpEvent<unknown>>();
      let calls = 0;
      const interceptor = createDedupeRequestsInterceptor(['POST']);
      const mockNext: HttpHandlerFn = () => {
        calls++;
        return subject.asObservable();
      };

      interceptor(
        new HttpRequest('POST', '/api/x', { id: 1 }),
        mockNext,
      ).subscribe();
      interceptor(
        new HttpRequest('POST', '/api/x', { id: 2 }),
        mockNext,
      ).subscribe();

      expect(calls).toBe(2);
    });

    it('should cancel the in-flight request and clear the dedupe entry when all subscribers unsubscribe before completion', () => {
      let callCount = 0;
      let teardownCount = 0;
      const interceptor = createDedupeRequestsInterceptor();
      const mockNext: HttpHandlerFn = () =>
        new Observable<HttpEvent<unknown>>(() => {
          callCount++;
          return () => {
            teardownCount++;
          };
        });

      const req = new HttpRequest('GET', '/api/users');

      const sub1 = interceptor(req, mockNext).subscribe();
      const sub2 = interceptor(req, mockNext).subscribe();
      expect(callCount).toBe(1); // both subscribers share the same in-flight source

      // All consumers leave before the response lands.
      sub1.unsubscribe();
      sub2.unsubscribe();
      expect(teardownCount).toBe(1); // refCount:true → source unsubscribed (HTTP cancelled)

      // A subsequent identical request should start a fresh source — the
      // finalize from the previous teardown cleared the in-flight slot.
      interceptor(req, mockNext).subscribe();
      expect(callCount).toBe(2);
    });

    it('should honor a custom keyFn override', () => {
      const subject = new Subject<HttpEvent<unknown>>();
      let calls = 0;
      // Force every request to share the same key — both should dedupe together.
      const interceptor = createDedupeRequestsInterceptor(
        ['GET', 'POST'],
        () => 'shared',
      );
      const mockNext: HttpHandlerFn = () => {
        calls++;
        return subject.asObservable();
      };

      interceptor(new HttpRequest('GET', '/api/a'), mockNext).subscribe();
      interceptor(
        new HttpRequest('POST', '/api/b', { x: 1 }),
        mockNext,
      ).subscribe();

      expect(calls).toBe(1);
    });

    it('should allow custom allowed methods', () => {
      const subject = new Subject<HttpEvent<unknown>>();
      let postCalls = 0;
      const postInterceptor = createDedupeRequestsInterceptor(['POST']);

      const postNext: HttpHandlerFn = () => {
        postCalls++;
        return subject.asObservable();
      };

      const postReq = new HttpRequest('POST', '/api/data', null);

      // POST should be deduped when in-flight
      postInterceptor(postReq, postNext).subscribe();
      postInterceptor(postReq, postNext).subscribe();
      expect(postCalls).toBe(1);

      subject.next(new HttpResponse({ status: 200 }));
      subject.complete();

      // GET should NOT be deduped (not in allowed list)
      let getCalls = 0;
      const getNext: HttpHandlerFn = () => {
        getCalls++;
        return of(new HttpResponse({ status: 200 }));
      };
      const getReq = new HttpRequest('GET', '/api/data');

      postInterceptor(getReq, getNext).subscribe();
      postInterceptor(getReq, getNext).subscribe();
      expect(getCalls).toBe(2);
    });
  });
});
