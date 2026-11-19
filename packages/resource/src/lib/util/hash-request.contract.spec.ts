import { HttpHeaders } from '@angular/common/http';
import { hashRequest } from './hash-request';
import { hash } from './hash-unknown';

const url = '/api/x';

describe('hashRequest vary partitioning', () => {
  it('partitions on an HttpHeaders instance', () => {
    const key = (v: string) =>
      hashRequest({ url, headers: new HttpHeaders({ Authorization: v }) }, [
        'Authorization',
      ]);
    expect(key('a')).not.toBe(key('b'));
    expect(key('a')).toBe(key('a'));
  });

  it('an absent header on an HttpHeaders instance partitions without throwing', () => {
    const absent = () =>
      hashRequest({ url, headers: new HttpHeaders() }, ['X-Tenant']);
    expect(absent).not.toThrow();
    expect(absent()).not.toBe(
      hashRequest({ url, headers: new HttpHeaders({ 'X-Tenant': 't' }) }, [
        'X-Tenant',
      ]),
    );
  });

  it('multi-valued headers do not collide with their concatenation', () => {
    const joined = hashRequest({ url, headers: { 'X-T': 'ab' } }, ['X-T']);
    expect(
      hashRequest({ url, headers: { 'X-T': ['a', 'b'] } }, ['X-T']),
    ).not.toBe(joined);
    expect(
      hashRequest(
        {
          url,
          headers: new HttpHeaders().append('X-T', 'a').append('X-T', 'b'),
        },
        ['X-T'],
      ),
    ).not.toBe(joined);
  });

  it('reads the named header, not the first one', () => {
    const key = (auth: string) =>
      hashRequest(
        { url, headers: { 'X-Other': 'same', Authorization: auth } },
        ['Authorization'],
      );
    expect(key('a')).not.toBe(key('b'));
  });
});

describe('hashRequest bodies', () => {
  it('FormData keys are independent of insertion order when values repeat', () => {
    const a = new FormData();
    a.set('a', 'x');
    a.set('b', 'x');
    const b = new FormData();
    b.set('b', 'x');
    b.set('a', 'x');
    expect(hashRequest({ url, method: 'POST', body: a })).toBe(
      hashRequest({ url, method: 'POST', body: b }),
    );
  });

  it('URLSearchParams bodies with different values get different keys', () => {
    expect(
      hashRequest({ url, method: 'POST', body: new URLSearchParams('a=1') }),
    ).not.toBe(
      hashRequest({ url, method: 'POST', body: new URLSearchParams('a=2') }),
    );
  });
});

describe('hash of Maps and Sets', () => {
  it('a Map with structurally equal keys hashes the same in any insertion order', () => {
    const a = new Map<unknown, string>([
      [{ a: 1 }, 'x'],
      [{ a: 1 }, 'y'],
    ]);
    const b = new Map<unknown, string>([
      [{ a: 1 }, 'y'],
      [{ a: 1 }, 'x'],
    ]);
    expect(hash(a)).toBe(hash(b));
  });

  it('Maps with different values still hash differently', () => {
    expect(hash(new Map([['k', 1]]))).not.toBe(hash(new Map([['k', 2]])));
  });
});
