import { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { refresh } from './refresh';
import { createMockResource } from './testing/mock-resource';

describe('refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return resource as-is when refresh is undefined', () => {
    const mock = createMockResource('data');
    const destroyRef = TestBed.inject(DestroyRef);
    const result = refresh(mock, destroyRef);
    expect(result).toBe(mock);
  });

  it('should return resource as-is when refresh is 0', () => {
    const mock = createMockResource('data');
    const destroyRef = TestBed.inject(DestroyRef);
    const result = refresh(mock, destroyRef, 0);
    expect(result).toBe(mock);
  });

  it('should auto-reload at the specified interval', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('data');
      const destroyRef = TestBed.inject(DestroyRef);
      refresh(mock, destroyRef, 5000);

      expect(mock._reloadSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000);
      expect(mock._reloadSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5000);
      expect(mock._reloadSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('should restart interval on manual reload', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('data');
      const destroyRef = TestBed.inject(DestroyRef);
      const wrapped = refresh(mock, destroyRef, 5000);

      // Advance partway through the interval
      vi.advanceTimersByTime(3000);
      expect(mock._reloadSpy).not.toHaveBeenCalled();

      // Manual reload should reset the interval
      wrapped.reload();
      expect(mock._reloadSpy).toHaveBeenCalledTimes(1);

      // The old interval should not fire at 5000ms
      vi.advanceTimersByTime(2000);
      expect(mock._reloadSpy).toHaveBeenCalledTimes(1);

      // New interval fires at 3000 + 5000 = 8000ms total
      vi.advanceTimersByTime(3000);
      expect(mock._reloadSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('should stop refreshing on destroy', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('data');
      const destroyRef = TestBed.inject(DestroyRef);
      const wrapped = refresh(mock, destroyRef, 5000);

      wrapped.destroy();

      vi.advanceTimersByTime(10000);
      expect(mock._reloadSpy).not.toHaveBeenCalled();
      expect(mock._destroySpy).toHaveBeenCalledTimes(1);
    });
  });
});
