import { Project } from 'ts-morph';
import { codegenTranslationFile } from './codegen';
import { discoverFromProject } from './discover';
import { addLocaleLoader, findRegisterNamespaceCalls } from './registry';

function withFiles(files: Record<string, string>): Project {
  const p = new Project({ useInMemoryFileSystem: true });
  for (const [name, content] of Object.entries(files))
    p.createSourceFile(name, content);
  return p;
}

const NAMESPACES = `
  export const common = createNamespace('common', {
    save: 'Save',
    items: '{count, plural, one {# item} other {# items}}',
  });
  export const quote = common.createMergedNamespace('quote', {
    title: 'Quotes',
    by: 'by {author}',
  });
  export const quoteSl = quote.createTranslation('sl-SI', {
    title: 'Citati',
    by: 'avtor {author}',
  });
`;

const REGISTRY = `
  registerNamespace(() => import('./namespaces').then((m) => m.common.translation), {});
  registerNamespace(
    () => import('./namespaces').then((m) => m.quote.translation),
    { 'sl-SI': () => import('./namespaces').then((m) => m.quoteSl) },
  );
  registerRemoteNamespace('cms', () => fetch('/x').then((r) => r.json()), {});
`;

describe('discoverFromProject', () => {
  it('discovers a standalone and a merged namespace, ignoring registerRemoteNamespace', () => {
    const result = discoverFromProject(
      withFiles({ '/namespaces.ts': NAMESPACES, '/registry.ts': REGISTRY }),
      { sourceLocale: 'en' },
    );

    expect(result.map((n) => n.namespace).sort()).toEqual(['common', 'quote']);

    // eslint-disable-next-line  @typescript-eslint/no-non-null-assertion
    const quote = result.find((n) => n.namespace === 'quote')!;
    // merged namespace exports ONLY its own keys (no common.* leakage)
    expect(quote.source.translation).toEqual({
      title: 'Quotes',
      by: 'by {author}',
    });
    expect(quote.locales).toHaveLength(1);
    expect(quote.locales[0]).toMatchObject({
      locale: 'sl-SI',
      translation: { title: 'Citati', by: 'avtor {author}' },
    });

    // eslint-disable-next-line  @typescript-eslint/no-non-null-assertion
    const common = result.find((n) => n.namespace === 'common')!;
    expect(common.locales).toHaveLength(0); // default-only registry
    expect(common.source.translation).toEqual({
      save: 'Save',
      items: '{count, plural, one {# item} other {# items}}',
    });
  });

  it('warns and skips when a loader module/export cannot be resolved', () => {
    const warnings: string[] = [];
    const result = discoverFromProject(
      withFiles({
        '/registry.ts': `registerNamespace(() => import('./missing').then((m) => m.gone.translation), {});`,
      }),
      { onWarn: (m) => warnings.push(m) },
    );
    expect(result).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  describe('loader-shape parity with @mmstack/translate', () => {
    it('resolves the `() => import(x)` shorthand via an (anonymous) default export', () => {
      const r = discoverFromProject(
        withFiles({
          '/q.ts': `export default createNamespace('quote', { title: 'Quotes' });`,
          '/registry.ts': `registerNamespace(() => import('./q'), {});`,
        }),
        { sourceLocale: 'en' },
      );
      expect(r).toHaveLength(1);
      expect(r[0]?.namespace).toBe('quote');
      expect(r[0]?.source.isDefaultExport).toBe(true);
      expect(r[0]?.source.exportName).toBe('quote'); // derived from the namespace name
      expect(r[0]?.source.translation).toEqual({ title: 'Quotes' });
    });

    it('resolves `.then((m) => m.default)` to the default-exported binding', () => {
      const r = discoverFromProject(
        withFiles({
          '/q.ts': `const quote = createNamespace('quote', { title: 'Quotes' });\nexport default quote;`,
          '/registry.ts': `registerNamespace(() => import('./q').then((m) => m.default), {});`,
        }),
        { sourceLocale: 'en' },
      );
      expect(r[0]?.source.isDefaultExport).toBe(true);
      expect(r[0]?.source.exportName).toBe('quote');
    });

    it('resolves the shorthand via a named `translation` export', () => {
      const r = discoverFromProject(
        withFiles({
          '/q.ts': `export const translation = createNamespace('quote', { title: 'Quotes' });`,
          '/registry.ts': `registerNamespace(() => import('./q'), {});`,
        }),
        { sourceLocale: 'en' },
      );
      expect(r[0]?.namespace).toBe('quote');
      expect(r[0]?.source.isDefaultExport).toBe(false);
      expect(r[0]?.source.exportName).toBe('translation');
    });
  });

  it('round-trips: codegen a new locale + register it + re-discover yields the same tree', () => {
    const p = withFiles({
      '/namespaces.ts': NAMESPACES,
      '/registry.ts': REGISTRY,
    });
    const de = { title: 'Zitate', by: 'von {author}' };

    p.createSourceFile(
      '/quote.de.ts',
      codegenTranslationFile({
        namespaceVar: 'quote',
        exportName: 'quoteDe',
        locale: 'de',
        importPath: './namespaces',
        translation: de,
      }),
    );
    // eslint-disable-next-line  @typescript-eslint/no-non-null-assertion
    const quoteCall = findRegisterNamespaceCalls(
      p.getSourceFileOrThrow('/registry.ts'),
    ).find((c) => c.getText().includes('m.quote.translation'))!;
    addLocaleLoader(quoteCall, 'de', './quote.de', 'quoteDe');

    // eslint-disable-next-line  @typescript-eslint/no-non-null-assertion
    const quote = discoverFromProject(p, { sourceLocale: 'en' }).find(
      (n) => n.namespace === 'quote',
    )!;
    expect(quote.locales.map((l) => l.locale).sort()).toEqual(['de', 'sl-SI']);
    expect(quote.locales.find((l) => l.locale === 'de')?.translation).toEqual(
      de,
    );
  });
});
