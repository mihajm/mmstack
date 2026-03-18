import { type HttpResourceRef } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { catchValueError } from './catch-value-error';
import { createMockResource } from './testing/mock-resource';

describe('catchValueError', () => {
  it('should return the resource value when no error', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('hello');
      const safe = catchValueError(mock, 'fallback');

      expect(safe.value()).toBe('hello');
    });
  });

  it('should return fallback when value() throws', () => {
    TestBed.runInInjectionContext(() => {
      // Build a throwing resource manually
      const setSpy = vi.fn();
      const throwingResource = {
        ...createMockResource('data'),
        value: Object.assign(
          () => {
            throw new Error('Resource error');
          },
          {
            set: setSpy,
            update: vi.fn(),
            asReadonly: () => signal('').asReadonly(),
          },
        ),
      } as unknown as HttpResourceRef<string>;

      const safe = catchValueError(throwingResource, 'fallback');
      expect(safe.value()).toBe('fallback');
    });
  });

  it('should forward set back to the original resource', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('original');
      const safe = catchValueError(mock, 'fallback');

      safe.value.set('updated');
      expect(mock.value()).toBe('updated');
    });
  });

  it('should preserve other resource properties', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('data');
      const safe = catchValueError(mock, 'fallback');

      expect(safe.status).toBe(mock.status);
      expect(safe.error).toBe(mock.error);
      expect(safe.reload).toBe(mock.reload);
    });
  });
});
