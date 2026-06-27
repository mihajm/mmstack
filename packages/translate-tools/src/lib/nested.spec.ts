import { fromJson, leafEntries, leafMap, type NestedTranslation, toJson } from './nested';

describe('nested', () => {
  const tree: NestedTranslation = {
    greeting: 'Hi {name}',
    detail: {
      authorLabel: 'Author',
      stats: '{count, plural, one {1 from {name}} other {# from {name}}}',
    },
  };

  describe('toJson / fromJson', () => {
    it('serializes to pretty JSON and round-trips', () => {
      expect(JSON.parse(toJson(tree))).toEqual(tree);
      expect(fromJson(toJson(tree))).toEqual(tree);
    });

    it('handles an empty object', () => {
      expect(JSON.parse(toJson({}))).toEqual({});
      expect(fromJson('{}')).toEqual({});
    });

    it('rejects non-object roots, arrays, and non-string leaves', () => {
      expect(() => fromJson('[]')).toThrow();
      expect(() => fromJson('null')).toThrow();
      expect(() => fromJson('"x"')).toThrow();
      expect(() => fromJson('{"a": 1}')).toThrow();
      expect(() => fromJson('{"a": [1]}')).toThrow();
      expect(() => fromJson('{"a": {"b": true}}')).toThrow();
    });

    it('points at the offending path in the error', () => {
      expect(() => fromJson('{"a": {"b": 1}}')).toThrow(/a\.b/);
    });
  });

  describe('leafEntries / leafMap', () => {
    it('walks string leaves with dotted paths', () => {
      expect(leafEntries(tree)).toEqual([
        ['greeting', 'Hi {name}'],
        ['detail.authorLabel', 'Author'],
        ['detail.stats', '{count, plural, one {1 from {name}} other {# from {name}}}'],
      ]);
    });

    it('builds a path -> message map', () => {
      expect(leafMap(tree).get('detail.authorLabel')).toBe('Author');
      expect(leafEntries({})).toEqual([]);
    });
  });
});
