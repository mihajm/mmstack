import { HttpParams } from '@angular/common/http';
import { hashRequest } from './hash-request';

describe('hashRequest', () => {
  describe('base composition', () => {
    it('returns method:url:responseType when no params/body', () => {
      expect(hashRequest({ method: 'GET', url: '/api/users' })).toBe(
        'GET:/api/users:json',
      );
    });

    it('defaults method to GET', () => {
      expect(hashRequest({ url: '/api/users' })).toBe('GET:/api/users:json');
    });

    it('defaults responseType to json', () => {
      expect(hashRequest({ method: 'POST', url: '/api/users' })).toBe(
        'POST:/api/users:json',
      );
    });

    it('distinguishes by method', () => {
      const get = hashRequest({ method: 'GET', url: '/api/users' });
      const del = hashRequest({ method: 'DELETE', url: '/api/users' });
      expect(get).not.toBe(del);
    });

    it('distinguishes by responseType', () => {
      const json = hashRequest({ url: '/api/data', responseType: 'json' });
      const text = hashRequest({ url: '/api/data', responseType: 'text' });
      const blob = hashRequest({ url: '/api/data', responseType: 'blob' });
      expect(new Set([json, text, blob]).size).toBe(3);
    });
  });

  describe('params', () => {
    it('sorts plain object params alphabetically', () => {
      expect(
        hashRequest({ url: '/api/users', params: { z: '1', a: '2', m: '3' } }),
      ).toBe('GET:/api/users:json:a=2&m=3&z=1');
    });

    it('is insensitive to param key order', () => {
      const a = hashRequest({
        url: '/api/users',
        params: { z: '1', a: '2' },
      });
      const b = hashRequest({
        url: '/api/users',
        params: { a: '2', z: '1' },
      });
      expect(a).toBe(b);
    });

    it('encodes param values', () => {
      const result = hashRequest({
        url: '/api/search',
        params: { q: 'hello world', tag: 'a&b' },
      });
      expect(result).toContain('q=hello%20world');
      expect(result).toContain('tag=a%26b');
    });

    it('expands array param values as repeated entries', () => {
      expect(
        hashRequest({ url: '/api/items', params: { ids: ['1', '2', '3'] } }),
      ).toBe('GET:/api/items:json:ids=1&ids=2&ids=3');
    });

    it('handles HttpParams instance', () => {
      const params = new HttpParams().set('a', '1').set('b', '2');
      const result = hashRequest({ url: '/api/data', params });
      expect(result).toContain('a=1');
      expect(result).toContain('b=2');
    });

    it('is insensitive to HttpParams .set order', () => {
      const a = hashRequest({
        url: '/api/data',
        params: new HttpParams().set('z', '1').set('a', '2'),
      });
      const b = hashRequest({
        url: '/api/data',
        params: new HttpParams().set('a', '2').set('z', '1'),
      });
      expect(a).toBe(b);
    });

    it('preserves repeated HttpParams values per key', () => {
      const params = new HttpParams().append('tag', 'x').append('tag', 'y');
      const result = hashRequest({ url: '/api/data', params });
      expect(result).toBe('GET:/api/data:json:tag=x&tag=y');
    });

    it('encodes HttpParams keys and values', () => {
      const params = new HttpParams().set('q', 'hello world');
      const result = hashRequest({ url: '/api/search', params });
      expect(result).toContain('q=hello%20world');
    });
  });

  describe('body', () => {
    it('omits body segment when body is null/undefined', () => {
      expect(hashRequest({ url: '/api/x', body: null })).toBe(
        'GET:/api/x:json',
      );
      expect(hashRequest({ url: '/api/x', body: undefined })).toBe(
        'GET:/api/x:json',
      );
    });

    it('includes falsy bodies (0, false, empty string)', () => {
      const zero = hashRequest({ url: '/api/x', body: 0 });
      const fls = hashRequest({ url: '/api/x', body: false });
      const empty = hashRequest({ url: '/api/x', body: '' });
      const none = hashRequest({ url: '/api/x' });
      expect(new Set([zero, fls, empty, none]).size).toBe(4);
    });

    it('is insensitive to plain-object body key order', () => {
      const a = hashRequest({
        method: 'POST',
        url: '/api/x',
        body: { a: 1, b: 2 },
      });
      const b = hashRequest({
        method: 'POST',
        url: '/api/x',
        body: { b: 2, a: 1 },
      });
      expect(a).toBe(b);
    });

    it('distinguishes by body content', () => {
      const a = hashRequest({ method: 'POST', url: '/api/x', body: { id: 1 } });
      const b = hashRequest({ method: 'POST', url: '/api/x', body: { id: 2 } });
      expect(a).not.toBe(b);
    });
  });

  describe('File body', () => {
    const make = (name: string, content: string, type = 'text/plain') =>
      new File([content], name, { type, lastModified: 1_700_000_000_000 });

    it('hashes identically for the same name/type/size/lastModified', () => {
      const a = hashRequest({ url: '/upload', body: make('a.txt', 'hello') });
      const b = hashRequest({ url: '/upload', body: make('a.txt', 'hello') });
      expect(a).toBe(b);
    });

    it('differs when name differs', () => {
      const a = hashRequest({ url: '/upload', body: make('a.txt', 'hello') });
      const b = hashRequest({ url: '/upload', body: make('b.txt', 'hello') });
      expect(a).not.toBe(b);
    });

    it('differs when size differs', () => {
      const a = hashRequest({ url: '/upload', body: make('a.txt', 'hello') });
      const b = hashRequest({
        url: '/upload',
        body: make('a.txt', 'hello-world'),
      });
      expect(a).not.toBe(b);
    });

    it('differs when type differs', () => {
      const a = hashRequest({
        url: '/upload',
        body: make('a.txt', 'hello', 'text/plain'),
      });
      const b = hashRequest({
        url: '/upload',
        body: make('a.txt', 'hello', 'application/json'),
      });
      expect(a).not.toBe(b);
    });

    it('does not collapse to {} like plain JSON.stringify would', () => {
      const result = hashRequest({
        url: '/upload',
        body: make('a.txt', 'hello'),
      });
      expect(result).toContain('File:a.txt');
      expect(result).toContain(':5'); // size
    });
  });

  describe('Blob body', () => {
    it('hashes identically for same type/size', () => {
      const a = hashRequest({
        url: '/upload',
        body: new Blob(['hello'], { type: 'text/plain' }),
      });
      const b = hashRequest({
        url: '/upload',
        body: new Blob(['hello'], { type: 'text/plain' }),
      });
      expect(a).toBe(b);
    });

    it('differs when type differs', () => {
      const a = hashRequest({
        url: '/upload',
        body: new Blob(['x'], { type: 'text/plain' }),
      });
      const b = hashRequest({
        url: '/upload',
        body: new Blob(['x'], { type: 'application/octet-stream' }),
      });
      expect(a).not.toBe(b);
    });

    it('differs when size differs', () => {
      const a = hashRequest({ url: '/upload', body: new Blob(['x']) });
      const b = hashRequest({ url: '/upload', body: new Blob(['xy']) });
      expect(a).not.toBe(b);
    });
  });

  describe('FormData body', () => {
    it('distinguishes different entries', () => {
      const fd1 = new FormData();
      fd1.set('name', 'alice');
      const fd2 = new FormData();
      fd2.set('name', 'bob');
      expect(hashRequest({ method: 'POST', url: '/x', body: fd1 })).not.toBe(
        hashRequest({ method: 'POST', url: '/x', body: fd2 }),
      );
    });

    it('is insensitive to entry insertion order', () => {
      const fd1 = new FormData();
      fd1.set('a', '1');
      fd1.set('b', '2');
      const fd2 = new FormData();
      fd2.set('b', '2');
      fd2.set('a', '1');
      expect(hashRequest({ method: 'POST', url: '/x', body: fd1 })).toBe(
        hashRequest({ method: 'POST', url: '/x', body: fd2 }),
      );
    });

    it('hashes File entries via their dedicated markers', () => {
      const file = new File(['hello'], 'a.txt', {
        type: 'text/plain',
        lastModified: 1_700_000_000_000,
      });
      const fd1 = new FormData();
      fd1.set('file', file);
      const fd2 = new FormData();
      fd2.set(
        'file',
        new File(['hello'], 'a.txt', {
          type: 'text/plain',
          lastModified: 1_700_000_000_000,
        }),
      );
      expect(hashRequest({ method: 'POST', url: '/x', body: fd1 })).toBe(
        hashRequest({ method: 'POST', url: '/x', body: fd2 }),
      );
    });
  });

  describe('URLSearchParams body', () => {
    it('hashes identically for the same entries', () => {
      const a = hashRequest({
        url: '/x',
        body: new URLSearchParams('a=1&b=2'),
      });
      const b = hashRequest({
        url: '/x',
        body: new URLSearchParams('a=1&b=2'),
      });
      expect(a).toBe(b);
    });

    it('is insensitive to entry order', () => {
      const a = hashRequest({
        url: '/x',
        body: new URLSearchParams('a=1&b=2'),
      });
      const b = hashRequest({
        url: '/x',
        body: new URLSearchParams('b=2&a=1'),
      });
      expect(a).toBe(b);
    });
  });

  describe('ArrayBuffer / typed array body', () => {
    it('hashes ArrayBuffer by byteLength', () => {
      expect(hashRequest({ url: '/x', body: new ArrayBuffer(8) })).toContain(
        'ArrayBuffer:8',
      );
    });

    it('differs across byteLength', () => {
      const a = hashRequest({ url: '/x', body: new ArrayBuffer(8) });
      const b = hashRequest({ url: '/x', body: new ArrayBuffer(16) });
      expect(a).not.toBe(b);
    });

    it('hashes typed arrays by constructor name + byteLength', () => {
      const u8 = hashRequest({ url: '/x', body: new Uint8Array(4) });
      const u16 = hashRequest({ url: '/x', body: new Uint16Array(4) });
      expect(u8).toContain('Uint8Array');
      expect(u16).toContain('Uint16Array');
      expect(u8).not.toBe(u16);
    });
  });
});
