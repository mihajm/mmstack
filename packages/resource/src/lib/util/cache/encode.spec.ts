import { HttpHeaders, HttpResponse } from '@angular/common/http';
import { deserialize, serialize } from './encode';

describe('encode', () => {
  describe('serialize', () => {
    it('should serialize a standard JSON HttpResponse into a POJO', () => {
      const response = new HttpResponse({
        body: { data: 'test' },
        status: 200,
        headers: new HttpHeaders({ 'Content-Type': 'application/json' }),
        url: 'https://example.com',
      });

      const serialized = serialize(response);

      expect(serialized.body).toEqual({ data: 'test' });
      expect(serialized.status).toBe(200);
      expect(serialized.headers).toEqual({ 'Content-Type': ['application/json'] });
      expect(serialized.url).toBe('https://example.com');
    });

    it('should serialize a Blob HttpResponse into a POJO preserving the Blob reference', () => {
      const blob = new Blob(['hello world'], { type: 'text/plain' });
      const response = new HttpResponse({
        body: blob,
        status: 200,
        headers: new HttpHeaders({ 'Content-Type': 'text/plain' }),
        url: 'https://example.com/blob',
      });

      const serialized = serialize(response);

      expect(serialized.body).toBe(blob);
      expect(serialized.status).toBe(200);
      expect(serialized.url).toBe('https://example.com/blob');
    });
  });

  describe('deserialize', () => {
    it('should deserialize a POJO back into an HttpResponse', () => {
      const pojo = {
        body: { data: 'test' },
        status: 200,
        headers: { 'content-type': ['application/json'] },
        url: 'https://example.com',
      };

      const deserialized = deserialize(pojo);

      expect(deserialized).toBeInstanceOf(HttpResponse);
      expect(deserialized?.body).toEqual({ data: 'test' });
      expect(deserialized?.status).toBe(200);
      expect(deserialized?.headers.get('content-type')).toBe('application/json');
      expect(deserialized?.url).toBe('https://example.com');
    });

    it('should deserialize a POJO containing a Blob back into an HttpResponse', () => {
      const blob = new Blob(['hello world'], { type: 'text/plain' });
      const pojo = {
        body: blob,
        status: 200,
        headers: { 'content-type': ['text/plain'] },
        url: 'https://example.com/blob',
      };

      const deserialized = deserialize(pojo);

      expect(deserialized).toBeInstanceOf(HttpResponse);
      expect(deserialized?.body).toBe(blob); // The exact same blob instance survives
      expect(deserialized?.status).toBe(200);
      expect(deserialized?.url).toBe('https://example.com/blob');
    });

    it('should return null if the pojo is invalid', () => {
      expect(deserialize(null)).toBeNull();
      expect(deserialize('not an object')).toBeNull();
      expect(deserialize({ status: 200 })).toBeNull(); // missing body
    });
  });
});
