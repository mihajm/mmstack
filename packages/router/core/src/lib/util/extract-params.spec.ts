import { extractRouteParams } from './extract-params';

describe('extractRouteParams', () => {
  it('extracts positional params', () => {
    expect(extractRouteParams('/users/:id', '/users/42')).toEqual({
      params: { id: '42' },
      query: {},
    });
  });

  it('prefix-matches with extra link segments', () => {
    expect(extractRouteParams('/users/:id', '/users/42/orders')).toEqual({
      params: { id: '42' },
      query: {},
    });
  });

  it('extracts multiple params', () => {
    expect(extractRouteParams('/org/:org/repo/:repo', '/org/mm/repo/stack')).toEqual({
      params: { org: 'mm', repo: 'stack' },
      query: {},
    });
  });

  it('parses the query string and ignores the fragment', () => {
    expect(extractRouteParams('/list', '/list?tab=open&x=1#frag')).toEqual({
      params: {},
      query: { tab: 'open', x: '1' },
    });
  });

  it('returns null on a literal mismatch', () => {
    expect(extractRouteParams('/users/:id', '/teams/42')).toBeNull();
  });

  it('returns null when the link is shorter than the pattern', () => {
    expect(extractRouteParams('/users/:id', '/users')).toBeNull();
  });

  it('decodes encoded param values', () => {
    expect(extractRouteParams('/q/:term', '/q/a%20b')).toEqual({
      params: { term: 'a b' },
      query: {},
    });
  });

  it('handles a ** wildcard (swallows the rest)', () => {
    expect(extractRouteParams('/files/**', '/files/a/b/c')).toEqual({
      params: {},
      query: {},
    });
  });
});
