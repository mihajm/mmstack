import {
  HttpContext,
  HttpContextToken,
  HttpHeaders,
  HttpParams,
  type HttpResourceRequest,
} from '@angular/common/http';
import fc from 'fast-check';
import { createEqualRequest } from './equality';
import { hashRequest } from './hash-request';

const T = new HttpContextToken<number>(() => 0);
const U = new HttpContextToken<number>(() => 0);
const ctx = (entries: [HttpContextToken<number>, number][]) =>
  entries.reduce((c, [k, v]) => c.set(k, v), new HttpContext());

type Req = Partial<HttpResourceRequest>;
const url = '/api';
const r = (extra: Req): Req => ({ url, ...extra });

const equalRequest = createEqualRequest();

const pairs: [string, Req, Req, boolean][] = [
  [
    'transferCache true vs object',
    r({ transferCache: true as never }),
    r({ transferCache: { includeHeaders: ['X'] } }),
    false,
  ],
  [
    'transferCache {} vs {}',
    r({ transferCache: {} }),
    r({ transferCache: {} }),
    true,
  ],
  [
    'transferCache {} vs includeHeaders',
    r({ transferCache: {} }),
    r({ transferCache: { includeHeaders: ['X'] } }),
    false,
  ],
  [
    'transferCache includeHeaders vs {}',
    r({ transferCache: { includeHeaders: ['X'] } }),
    r({ transferCache: {} }),
    false,
  ],
  [
    'transferCache header count',
    r({ transferCache: { includeHeaders: ['A', 'B'] } }),
    r({ transferCache: { includeHeaders: ['A'] } }),
    false,
  ],
  [
    'transferCache empty lists',
    r({ transferCache: { includeHeaders: [] } }),
    r({ transferCache: { includeHeaders: [] } }),
    true,
  ],
  [
    'transferCache one header differs',
    r({ transferCache: { includeHeaders: ['A', 'B'] } }),
    r({ transferCache: { includeHeaders: ['A', 'C'] } }),
    false,
  ],
  [
    'multi-value param gains a value',
    r({ params: { tags: ['a'] } }),
    r({ params: { tags: ['a', 'b'] } }),
    false,
  ],
  [
    'param array order',
    r({ params: { tags: ['a', 'b'] } }),
    r({ params: { tags: ['b', 'a'] } }),
    false,
  ],
  [
    'param array duplicates',
    r({ params: { tags: ['a', 'a', 'b'] } }),
    r({ params: { tags: ['a', 'b', 'b'] } }),
    false,
  ],
  [
    'HttpParams append differs',
    r({ params: new HttpParams().append('t', 'x').append('t', 'y') }),
    r({ params: new HttpParams().append('t', 'x').append('t', 'z') }),
    false,
  ],
  [
    'HttpHeaders append differs',
    r({ headers: new HttpHeaders().append('A', 'x').append('A', 'y') }),
    r({ headers: new HttpHeaders().append('A', 'x').append('A', 'z') }),
    false,
  ],
  ['params on one side', r({ params: { a: '1' } }), r({}), false],
  ['params on the other side', r({}), r({ params: { a: '1' } }), false],
  [
    'extra param key',
    r({ params: { a: '1' } }),
    r({ params: { a: '1', b: '2' } }),
    false,
  ],
  [
    'one of two params differs',
    r({ params: { a: '1', b: '2' } }),
    r({ params: { a: '1', b: '3' } }),
    false,
  ],
  [
    'one-element array vs HttpParams scalar',
    r({ params: { tags: ['a'] } }),
    r({ params: new HttpParams().set('tags', 'a') }),
    true,
  ],
  [
    'HttpParams scalar vs one-element array',
    r({ params: new HttpParams().set('tags', 'a') }),
    r({ params: { tags: ['a'] } }),
    true,
  ],
  ['body on one side', r({ body: { a: 1 } }), r({}), false],
  ['body undefined vs 0', r({}), r({ body: 0 }), false],
  ['body 0 vs false', r({ body: 0 }), r({ body: false }), false],
  ['body empty string vs undefined', r({ body: '' }), r({}), false],
  ['body null vs undefined', r({ body: null }), r({}), true],
  ['headers on one side', r({ headers: { A: 'x' } }), r({}), false],
  ['headers on the other side', r({}), r({ headers: { A: 'x' } }), false],
  [
    'extra header key',
    r({ headers: { A: 'x' } }),
    r({ headers: { A: 'x', B: 'y' } }),
    false,
  ],
  [
    'one of two headers differs',
    r({ headers: { A: 'x', B: 'y' } }),
    r({ headers: { A: 'x', B: 'z' } }),
    false,
  ],
  [
    'array header rebuilt',
    r({ headers: { Accept: ['a', 'b'] } }),
    r({ headers: { Accept: ['a', 'b'] } }),
    true,
  ],
  [
    'HttpHeaders scalar vs one-element array',
    r({ headers: new HttpHeaders().set('A', 'x') }),
    r({ headers: { A: ['x'] } }),
    true,
  ],
  ['context on one side', r({}), r({ context: ctx([[T, 1]]) }), false],
  [
    'single-token context rebuilt',
    r({ context: ctx([[T, 1]]) }),
    r({ context: ctx([[T, 1]]) }),
    true,
  ],
  [
    'two-token context rebuilt',
    r({
      context: ctx([
        [T, 1],
        [U, 2],
      ]),
    }),
    r({
      context: ctx([
        [T, 1],
        [U, 2],
      ]),
    }),
    true,
  ],
  [
    'two-token context, first token differs',
    r({
      context: ctx([
        [T, 2],
        [U, 2],
      ]),
    }),
    r({
      context: ctx([
        [T, 1],
        [U, 2],
      ]),
    }),
    false,
  ],
  [
    'extra context token',
    r({ context: ctx([[T, 1]]) }),
    r({
      context: ctx([
        [T, 1],
        [U, 2],
      ]),
    }),
    false,
  ],
  [
    'one of two tokens differs',
    r({
      context: ctx([
        [T, 1],
        [U, 2],
      ]),
    }),
    r({
      context: ctx([
        [T, 1],
        [U, 3],
      ]),
    }),
    false,
  ],
  [
    'empty contexts',
    r({ context: new HttpContext() }),
    r({ context: new HttpContext() }),
    true,
  ],
  [
    'reportProgress',
    r({ reportProgress: true }),
    r({ reportProgress: false }),
    false,
  ],
  ['timeout', r({ timeout: 1000 }), r({ timeout: 2000 }), false],
  [
    'credentials',
    r({ credentials: 'include' }),
    r({ credentials: 'omit' }),
    false,
  ],
  ['priority', r({ priority: 'high' }), r({ priority: 'low' }), false],
  ['mode', r({ mode: 'cors' }), r({ mode: 'no-cors' }), false],
  ['keepalive', r({ keepalive: true }), r({}), false],
  ['cache', r({ cache: 'no-store' }), r({ cache: 'default' }), false],
  ['redirect', r({ redirect: 'follow' }), r({ redirect: 'error' }), false],
  ['referrer', r({ referrer: 'a' }), r({ referrer: 'b' }), false],
  [
    'referrerPolicy',
    r({ referrerPolicy: 'no-referrer' }),
    r({ referrerPolicy: 'origin' }),
    false,
  ],
  [
    'integrity',
    r({ integrity: 'sha256-a' }),
    r({ integrity: 'sha256-b' }),
    false,
  ],
  [
    'every field equal',
    r({ timeout: 5, credentials: 'include', priority: 'high', mode: 'cors' }),
    r({ timeout: 5, credentials: 'include', priority: 'high', mode: 'cors' }),
    true,
  ],
];

describe('createEqualRequest contract', () => {
  it.each(pairs)('%s', (_, a, b, expected) => {
    expect(equalRequest(a, b)).toBe(expected);
    expect(equalRequest(b, a)).toBe(expected);
  });

  it('agrees with hashRequest on params, bodies and methods', () => {
    const scalar = fc.oneof(
      fc.constantFrom('a', 'b', 'c'),
      fc.integer({ min: 0, max: 2 }),
    );
    const params = fc.dictionary(
      fc.constantFrom('x', 'y'),
      fc.oneof(
        scalar.map(String),
        fc.array(fc.constantFrom('a', 'b'), { minLength: 1, maxLength: 3 }),
      ),
    );
    const body = fc.oneof(
      fc.constant(undefined),
      fc.constant(0),
      fc.constant(false),
      fc.constant(''),
      fc.record({ n: scalar }),
    );
    const req = fc.record({
      url: fc.constantFrom('/a', '/b'),
      method: fc.constantFrom('GET', 'POST'),
      params,
      body,
    });
    fc.assert(
      fc.property(req, req, (a, b) => {
        const sameKey = hashRequest(a) === hashRequest(b);
        expect(equalRequest(a, b)).toBe(sameKey);
      }),
    );
  });
});
