import { TestBed } from '@angular/core/testing';
import { retryOnError } from './retry-on-error';
import { createMockResource } from './testing/mock-resource';

describe('retryOnError', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should reload on error up to max retries (number option)', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('data', { status: 'idle' });
      retryOnError(mock, 3);

      // 1st error
      mock._status.set('error');
      TestBed.tick();
      vi.advanceTimersByTime(1000); // 1000 * 2^0
      expect(mock._reloadSpy).toHaveBeenCalledTimes(1);

      // 2nd error (need to transition status to trigger effect again)
      mock._status.set('loading');
      TestBed.tick();
      mock._status.set('error');
      TestBed.tick();
      vi.advanceTimersByTime(2000); // 1000 * 2^1
      expect(mock._reloadSpy).toHaveBeenCalledTimes(2);

      // 3rd error
      mock._status.set('loading');
      TestBed.tick();
      mock._status.set('error');
      TestBed.tick();
      vi.advanceTimersByTime(4000); // 1000 * 2^2
      expect(mock._reloadSpy).toHaveBeenCalledTimes(3);

      // 4th error - should NOT retry
      mock._status.set('loading');
      TestBed.tick();
      mock._status.set('error');
      TestBed.tick();
      vi.advanceTimersByTime(10000);
      expect(mock._reloadSpy).toHaveBeenCalledTimes(3);
    });
  });

  it('should reset retries on success', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('data', { status: 'idle' });
      retryOnError(mock, 2);

      mock._status.set('error');
      TestBed.tick();
      vi.advanceTimersByTime(1000);
      expect(mock._reloadSpy).toHaveBeenCalledTimes(1);

      // Success resets counter
      mock._status.set('loading');
      TestBed.tick();
      mock._status.set('resolved');
      TestBed.tick();

      // New error should retry from 0
      mock._status.set('error');
      TestBed.tick();
      vi.advanceTimersByTime(1000);
      expect(mock._reloadSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('should use custom backoff from object options', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('data', { status: 'idle' });
      retryOnError(mock, { max: 1, backoff: 500 });

      mock._status.set('error');
      TestBed.tick();

      vi.advanceTimersByTime(499);
      expect(mock._reloadSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(mock._reloadSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('should destroy both effect and resource on destroy', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('data');
      const wrapped = retryOnError(mock, 1);

      wrapped.destroy();
      expect(mock._destroySpy).toHaveBeenCalledTimes(1);
    });
  });

  it('fires onError with retryCount + isFinal on every attempt', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('data', { status: 'idle' });
      const onError = vi.fn();

      retryOnError(mock, 2, onError);

      const err1 = new Error('boom 1');
      mock._error.set(err1);
      mock._status.set('error');
      TestBed.tick();
      vi.advanceTimersByTime(1000);
      expect(onError).toHaveBeenLastCalledWith(err1, 0, false);

      const err2 = new Error('boom 2');
      mock._error.set(err2);
      mock._status.set('loading');
      TestBed.tick();
      mock._status.set('error');
      TestBed.tick();
      vi.advanceTimersByTime(2000);
      expect(onError).toHaveBeenLastCalledWith(err2, 1, false);

      const err3 = new Error('boom 3');
      mock._error.set(err3);
      mock._status.set('loading');
      TestBed.tick();
      mock._status.set('error');
      TestBed.tick();
      // 3rd attempt (retryCount=2) is the final one — isFinal flips to true
      expect(onError).toHaveBeenLastCalledWith(err3, 2, true);

      expect(onError).toHaveBeenCalledTimes(3);
    });
  });

  it('marks the first failure as final when retry is 0', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('data', { status: 'idle' });
      const onError = vi.fn();

      retryOnError(mock, 0, onError);

      const err = new Error('boom');
      mock._error.set(err);
      mock._status.set('error');
      TestBed.tick();

      expect(onError).toHaveBeenCalledWith(err, 0, true);
      expect(mock._reloadSpy).not.toHaveBeenCalled();
    });
  });
});
