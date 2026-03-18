import { TestBed } from '@angular/core/testing';
import { createCircuitBreaker, type CircuitBreaker } from './circuit-breaker';

describe('circuit-breaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createCircuitBreaker with false', () => {
    it('should create a never-broken breaker', () => {
      TestBed.runInInjectionContext(() => {
        const cb = createCircuitBreaker(false);
        expect(cb.isClosed()).toBe(true);
        expect(cb.isOpen()).toBe(false);
        expect(cb.status()).toBe('CLOSED');

        // Calling fail should have no effect
        cb.fail(new Error('test'));
        expect(cb.isClosed()).toBe(true);
      });
    });
  });

  describe('createCircuitBreaker with existing instance', () => {
    it('should return the same instance', () => {
      TestBed.runInInjectionContext(() => {
        const existing = createCircuitBreaker({ treshold: 3, timeout: 1000 });
        const reused = createCircuitBreaker(existing);
        expect(reused).toBe(existing);
      });
    });
  });

  describe('standard circuit breaker', () => {
    let cb: CircuitBreaker;

    beforeEach(() => {
      TestBed.runInInjectionContext(() => {
        cb = createCircuitBreaker({ treshold: 3, timeout: 5000 });
      });
    });

    it('should start in CLOSED state', () => {
      expect(cb.status()).toBe('CLOSED');
      expect(cb.isClosed()).toBe(true);
      expect(cb.isOpen()).toBe(false);
    });

    it('should open after reaching threshold failures', () => {
      cb.fail();
      cb.fail();
      expect(cb.status()).toBe('CLOSED');

      cb.fail(); // 3rd failure = threshold
      expect(cb.status()).toBe('OPEN');
      expect(cb.isClosed()).toBe(false);
      expect(cb.isOpen()).toBe(true);
    });

    it('should reset on success', () => {
      cb.fail();
      cb.fail();
      cb.success();

      expect(cb.status()).toBe('CLOSED');

      // Should need 3 fresh failures to open again
      cb.fail();
      cb.fail();
      expect(cb.status()).toBe('CLOSED');

      cb.fail();
      expect(cb.status()).toBe('OPEN');
    });

    it('should transition to HALF_OPEN after timeout', () => {
      // Open the breaker
      cb.fail();
      cb.fail();
      cb.fail();
      expect(cb.status()).toBe('OPEN');

      TestBed.tick();
      vi.advanceTimersByTime(5000);

      expect(cb.status()).toBe('HALF_OPEN');
    });

    it('should close from HALF_OPEN on success', () => {
      cb.fail();
      cb.fail();
      cb.fail();
      expect(cb.status()).toBe('OPEN');

      TestBed.tick();
      vi.advanceTimersByTime(5000);
      expect(cb.status()).toBe('HALF_OPEN');

      cb.success();
      expect(cb.status()).toBe('CLOSED');
    });

    it('should re-open from HALF_OPEN on failure', () => {
      cb.fail();
      cb.fail();
      cb.fail();

      TestBed.tick();
      vi.advanceTimersByTime(5000);
      expect(cb.status()).toBe('HALF_OPEN');

      cb.fail();
      expect(cb.status()).toBe('OPEN');
    });

    it('should support shouldFail filter', () => {
      TestBed.runInInjectionContext(() => {
        const selective = createCircuitBreaker({
          treshold: 2,
          timeout: 1000,
          shouldFail: (err) => err?.message === 'fatal',
        });

        selective.fail(new Error('non-fatal'));
        selective.fail(new Error('non-fatal'));
        expect(selective.status()).toBe('CLOSED'); // ignored

        selective.fail(new Error('fatal'));
        selective.fail(new Error('fatal'));
        expect(selective.status()).toBe('OPEN');
      });
    });

    it('should support shouldFailForever', () => {
      TestBed.runInInjectionContext(() => {
        const breaker = createCircuitBreaker({
          treshold: 5,
          timeout: 1000,
          shouldFailForever: (err) => err?.message === 'permanent',
        });

        breaker.fail(new Error('permanent'));
        expect(breaker.status()).toBe('OPEN');

        // timeout should NOT recover it
        TestBed.tick();
        vi.advanceTimersByTime(10000);
        expect(breaker.status()).toBe('OPEN');
      });
    });

    it('should be destroyable', () => {
      expect(() => cb.destroy()).not.toThrow();
    });
  });
});
