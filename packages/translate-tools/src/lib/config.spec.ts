import { type DiscoveredNamespace } from './discover';
import { parseConfig, pinNamespaces } from './config';

const parse = (text: string) => parseConfig(text, 'c.ts');

describe('parseConfig', () => {
  it('reads every field of the object form', () => {
    expect(
      parse(`export default {
        src: ['src/**/*.ts', 'libs/**/*.ts'],
        sourceLocale: 'fr',
        namespaces: ['common', 'quote'],
      };`),
    ).toEqual({
      src: ['src/**/*.ts', 'libs/**/*.ts'],
      sourceLocale: 'fr',
      namespaces: ['common', 'quote'],
    });
  });

  it('reads the JSON-style output of generate-manifest', () => {
    expect(
      parse(`// header
export default {
  "src": ["src/**/*.ts"],
  "sourceLocale": "en",
  "namespaces": ["common"]
};`),
    ).toEqual({
      src: ['src/**/*.ts'],
      sourceLocale: 'en',
      namespaces: ['common'],
    });
  });

  it('accepts a single src string, an empty object, and template literals', () => {
    expect(parse('export default { src: `app/**/*.ts` };')).toEqual({
      src: ['app/**/*.ts'],
    });
    expect(parse('export default {};')).toEqual({});
  });

  it.each([
    [
      `import type { MmtranslateConfig } from '@mmstack/translate-tools';
export default { sourceLocale: 'de' } satisfies MmtranslateConfig;`,
    ],
    [`export default ({ sourceLocale: 'de' } as const);`],
    [`const config = { sourceLocale: 'de' };\nexport default config;`],
  ])('unwraps %s', (text) => {
    expect(parse(text)).toEqual({ sourceLocale: 'de' });
  });

  it('reads the 1.1 manifest (an array of entries) as the namespace list', () => {
    expect(
      parse(`export default [
  { "namespace": "common", "sourceLocale": "en", "registry": "src/r.ts", "locales": [] },
  { "namespace": "quote", "sourceLocale": "en", "registry": "src/r.ts", "locales": ["de"] }
];`),
    ).toEqual({ namespaces: ['common', 'quote'], sourceLocale: 'en' });
  });

  it('leaves sourceLocale unset when 1.1 entries disagree', () => {
    expect(
      parse(`export default [
  { namespace: 'a', sourceLocale: 'en' },
  { namespace: 'b', sourceLocale: 'fr' },
];`),
    ).toEqual({ namespaces: ['a', 'b'] });
  });

  it('accepts entry objects inside namespaces', () => {
    expect(
      parse(
        `export default { namespaces: ['a', { namespace: 'b', locales: ['de'] }] };`,
      ),
    ).toEqual({ namespaces: ['a', 'b'] });
  });

  it.each([
    ['no default export', `export const x = {};`, /export default/],
    ['a non-object default', `export default 5;`, /object literal/],
    ['an unknown key', `export default { srcs: [] };`, /unknown key "srcs"/],
    ['a non-string src item', `export default { src: [1] };`, /"src"/],
    ['a variable src', `const g = 'x';\nexport default { src: g };`, /"src"/],
    [
      'a non-string sourceLocale',
      `export default { sourceLocale: 1 };`,
      /"sourceLocale"/,
    ],
    [
      'a non-array namespaces',
      `export default { namespaces: 'a' };`,
      /"namespaces"/,
    ],
    [
      'an entry with no name',
      `export default { namespaces: [{}] };`,
      /"namespace"/,
    ],
    ['a spread', `export default { ...base };`, /unsupported entry/],
  ])('rejects %s with the file name', (_, text, why) => {
    expect(() => parse(text)).toThrow(why);
    expect(() => parse(text)).toThrow(/c\.ts/);
  });
});

describe('pinNamespaces', () => {
  const ns = (namespace: string) => ({ namespace }) as DiscoveredNamespace;
  const found = [ns('a'), ns('b'), ns('c')];

  it('keeps everything when no list is given, without warnings', () => {
    const warn = vi.fn();
    expect(pinNamespaces(found, undefined, warn)).toBe(found);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the listed namespaces in discovery order and warns about the rest', () => {
    const warnings: string[] = [];
    const kept = pinNamespaces(found, ['c', 'a', 'x'], (m) => warnings.push(m));
    expect(kept.map((n) => n.namespace)).toEqual(['a', 'c']);
    expect(warnings).toHaveLength(2);
    expect(warnings.find((w) => w.includes('"b"'))).toContain('not listed');
    expect(warnings.find((w) => w.includes('"x"'))).toContain('not discovered');
  });

  it('an empty list keeps nothing', () => {
    expect(pinNamespaces(found, [], () => undefined)).toEqual([]);
  });
});
