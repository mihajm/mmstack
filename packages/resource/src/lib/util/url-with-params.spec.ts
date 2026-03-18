import { HttpParams } from '@angular/common/http';
import { urlWithParams } from './url-with-params';

describe('urlWithParams', () => {
  it('should return url as-is when no params', () => {
    expect(urlWithParams({ url: '/api/users', method: 'GET' })).toBe(
      '/api/users',
    );
  });

  it('should append plain object params', () => {
    const result = urlWithParams({
      url: '/api/users',
      method: 'GET',
      params: { page: '1', size: '10' },
    });

    expect(result).toBe('/api/users?page=1&size=10');
  });

  it('should sort params alphabetically', () => {
    const result = urlWithParams({
      url: '/api/users',
      method: 'GET',
      params: { z: '1', a: '2', m: '3' },
    });

    expect(result).toBe('/api/users?a=2&m=3&z=1');
  });

  it('should encode param values', () => {
    const result = urlWithParams({
      url: '/api/search',
      method: 'GET',
      params: { q: 'hello world', tag: 'a&b' },
    });

    expect(result).toContain('q=hello%20world');
    expect(result).toContain('tag=a%26b');
  });

  it('should handle array param values as comma-separated', () => {
    const result = urlWithParams({
      url: '/api/items',
      method: 'GET',
      params: { ids: ['1', '2', '3'] },
    });

    expect(result).toBe('/api/items?ids=1,2,3');
  });

  it('should handle HttpParams instance', () => {
    const params = new HttpParams().set('key', 'value').set('foo', 'bar');

    const result = urlWithParams({
      url: '/api/data',
      method: 'GET',
      params,
    });

    expect(result).toContain('key=value');
    expect(result).toContain('foo=bar');
  });
});
