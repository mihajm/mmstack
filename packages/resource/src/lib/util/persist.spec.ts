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

      expect(persisted.value()).toBe('initial');

      mock.value.set(undefined);

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

      mock._statusCode.set(undefined);
      expect(persisted.statusCode()).toBe(200);
    });
  });

  it('yields the fallback before anything is held, then the previous value across a gap', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource<string[] | undefined>(undefined, {
        status: 'loading',
      });
      const persisted = persistResourceValues(mock, true, undefined, []);

      expect(persisted.value()).toEqual([]);

      mock.value.set(['a']);
      expect(persisted.value()).toEqual(['a']);

      mock.value.set(undefined);
      expect(persisted.value()).toEqual(['a']);
    });
  });

  it('hasValue follows the held value: true through a gap, false in error', () => {
    TestBed.runInInjectionContext(() => {
      const mock = createMockResource<string | undefined>(undefined, {
        status: 'loading',
      });
      const persisted = persistResourceValues(mock, true);
      expect(persisted.hasValue()).toBe(false);

      mock.value.set('first');
      mock._status.set('resolved');
      expect(persisted.hasValue()).toBe(true);

      mock.value.set(undefined);
      mock._status.set('loading');
      expect(persisted.hasValue()).toBe(true);

      mock._status.set('error');
      expect(persisted.hasValue()).toBe(false);
      expect(persisted.value()).toBe('first');
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
