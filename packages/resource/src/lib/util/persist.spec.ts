import { TestBed } from '@angular/core/testing';
import { persistResourceValues } from './persist';
import { createMockResource } from './testing/mock-resource';

describe('persistResourceValues', () => {
  it('should return resource as-is when shouldPersist is false', () => {
    const mock = createMockResource('data');
    const result = persistResourceValues(mock, false);
    expect(result).toBe(mock);
  });

  it('should return resource as-is when shouldPersist defaults to false', () => {
    const mock = createMockResource('data');
    const result = persistResourceValues(mock);
    expect(result).toBe(mock);
  });

  it('should persist value across undefined transitions when shouldPersist is true', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource<string | undefined>('initial', {
        status: 'resolved',
      });

      const persisted = persistResourceValues(mock, true);

      // Read the initial persisted value
      expect(persisted.value()).toBe('initial');

      // Simulate resource going to undefined (e.g. during reload)
      mock.value.set(undefined);

      // Persisted value should retain the last defined value
      expect(persisted.value()).toBe('initial');
    });
  });

  it('should update persisted value when new defined value arrives', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource<string | undefined>('first', {
        status: 'resolved',
      });
      const persisted = persistResourceValues(mock, true);

      expect(persisted.value()).toBe('first');

      mock.value.set('second');
      expect(persisted.value()).toBe('second');
    });
  });

  it('should persist statusCode and headers as well', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('data', { statusCode: 200 });
      const persisted = persistResourceValues(mock, true);

      expect(persisted.statusCode()).toBe(200);

      // Simulate statusCode becoming undefined
      mock._statusCode.set(undefined);
      expect(persisted.statusCode()).toBe(200); // persisted
    });
  });

  it('should forward set/update back to original when source is writable', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource('original');
      const persisted = persistResourceValues(mock, true);

      persisted.value.set('updated');
      expect(mock.value()).toBe('updated');
    });
  });
});
