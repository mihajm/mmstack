import { HttpHeaders, HttpParams } from '@angular/common/http';
import { createEqualRequest } from './equality';

describe('equality', () => {
  const equalRequest = createEqualRequest();

  describe('createEqualRequest', () => {
    it('should return true for two undefined requests', () => {
      expect(equalRequest(undefined, undefined)).toBe(true);
    });

    it('should return false when one is undefined', () => {
      expect(equalRequest({ url: '/api' }, undefined)).toBe(false);
      expect(equalRequest(undefined, { url: '/api' })).toBe(false);
    });

    it('should compare urls', () => {
      expect(
        equalRequest({ url: '/api/a' }, { url: '/api/a' }),
      ).toBe(true);
      expect(
        equalRequest({ url: '/api/a' }, { url: '/api/b' }),
      ).toBe(false);
    });

    it('should compare methods', () => {
      expect(
        equalRequest(
          { url: '/api', method: 'GET' },
          { url: '/api', method: 'GET' },
        ),
      ).toBe(true);
      expect(
        equalRequest(
          { url: '/api', method: 'GET' },
          { url: '/api', method: 'POST' },
        ),
      ).toBe(false);
    });

    it('should compare plain object params', () => {
      expect(
        equalRequest(
          { url: '/api', params: { a: '1', b: '2' } },
          { url: '/api', params: { a: '1', b: '2' } },
        ),
      ).toBe(true);
      expect(
        equalRequest(
          { url: '/api', params: { a: '1' } },
          { url: '/api', params: { a: '2' } },
        ),
      ).toBe(false);
    });

    it('should compare HttpParams instances with plain objects', () => {
      const params = new HttpParams().set('a', '1');
      expect(
        equalRequest(
          { url: '/api', params },
          { url: '/api', params: { a: '1' } },
        ),
      ).toBe(true);
    });

    it('should compare array params', () => {
      expect(
        equalRequest(
          { url: '/api', params: { tags: ['a', 'b'] } },
          { url: '/api', params: { tags: ['a', 'b'] } },
        ),
      ).toBe(true);
      expect(
        equalRequest(
          { url: '/api', params: { tags: ['a', 'b'] } },
          { url: '/api', params: { tags: ['a', 'c'] } },
        ),
      ).toBe(false);
    });

    it('should compare plain object headers', () => {
      expect(
        equalRequest(
          { url: '/api', headers: { Authorization: 'Bearer x' } },
          { url: '/api', headers: { Authorization: 'Bearer x' } },
        ),
      ).toBe(true);
      expect(
        equalRequest(
          { url: '/api', headers: { Authorization: 'Bearer x' } },
          { url: '/api', headers: { Authorization: 'Bearer y' } },
        ),
      ).toBe(false);
    });

    it('should compare HttpHeaders instances with plain objects', () => {
      const headers = new HttpHeaders().set('Authorization', 'Bearer x');
      expect(
        equalRequest(
          { url: '/api', headers },
          { url: '/api', headers: { Authorization: 'Bearer x' } },
        ),
      ).toBe(true);
    });

    it('should compare bodies using deep hashing', () => {
      expect(
        equalRequest(
          { url: '/api', body: { a: 1, b: 2 } },
          { url: '/api', body: { b: 2, a: 1 } },
        ),
      ).toBe(true);
      expect(
        equalRequest(
          { url: '/api', body: { a: 1 } },
          { url: '/api', body: { a: 2 } },
        ),
      ).toBe(false);
    });

    it('should compare withCredentials', () => {
      expect(
        equalRequest(
          { url: '/api', withCredentials: true },
          { url: '/api', withCredentials: true },
        ),
      ).toBe(true);
      expect(
        equalRequest(
          { url: '/api', withCredentials: true },
          { url: '/api', withCredentials: false },
        ),
      ).toBe(false);
    });

    it('should compare transferCache booleans', () => {
      expect(
        equalRequest(
          { url: '/api', transferCache: true },
          { url: '/api', transferCache: true },
        ),
      ).toBe(true);
      expect(
        equalRequest(
          { url: '/api', transferCache: true },
          { url: '/api', transferCache: false },
        ),
      ).toBe(false);
    });

    it('should compare transferCache with includeHeaders', () => {
      expect(
        equalRequest(
          { url: '/api', transferCache: { includeHeaders: ['X-Custom'] } },
          { url: '/api', transferCache: { includeHeaders: ['X-Custom'] } },
        ),
      ).toBe(true);
      expect(
        equalRequest(
          { url: '/api', transferCache: { includeHeaders: ['X-Custom'] } },
          { url: '/api', transferCache: { includeHeaders: ['X-Other'] } },
        ),
      ).toBe(false);
    });
  });

  describe('with custom equality', () => {
    it('should use custom body equality fn', () => {
      const customEqual = createEqualRequest<{ id: number }>(
        (a, b) => a?.id === b?.id,
      );

      expect(
        customEqual(
          { url: '/api', body: { id: 1 } },
          { url: '/api', body: { id: 1 } },
        ),
      ).toBe(true);
      expect(
        customEqual(
          { url: '/api', body: { id: 1 } },
          { url: '/api', body: { id: 2 } },
        ),
      ).toBe(false);
    });
  });
});
