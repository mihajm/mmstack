import { Project } from 'ts-morph';
import { applyImport, parseImportFileName, validateImport } from './commands';
import { discoverFromProject } from './discover';
import { validateMessage } from './icu';

function withFiles(files: Record<string, string>): Project {
  const p = new Project({ useInMemoryFileSystem: true });
  for (const [name, content] of Object.entries(files))
    p.createSourceFile(name, content);
  return p;
}

const only = (p: Project) => {
  const found = discoverFromProject(p, { onWarn: () => undefined });
  expect(found).toHaveLength(1);
  return found[0];
};

const Q = `export const q = createNamespace('quote', { title: 'Quotes' });`;
const DEFAULT = `() => import('./q').then((m) => m.q.translation)`;

describe('validateImport messages name what to fix', () => {
  it('carries the ICU parser error for an invalid message', () => {
    const bad = '{n, plural, one {x}';
    const parsed = validateMessage(bad);
    if (parsed.ok) throw new Error('expected invalid ICU');
    const [issue] = validateImport({ a: bad }, { a: 'x' });
    expect(issue?.key).toBe('a');
    expect(issue?.message).toContain(parsed.error);
  });

  it('names a dropped placeholder', () => {
    const [issue] = validateImport({ a: 'Hi' }, { a: 'Hi {name}' });
    expect(issue?.message).toContain('name');
  });

  it('names an added placeholder', () => {
    const [issue] = validateImport({ a: 'Hi {x}' }, { a: 'Hi' });
    expect(issue?.message).toContain('x');
  });
});

describe('parseImportFileName', () => {
  it.each(['quote.de.json.bak', 'quote.de.jsonc'])('rejects %s', (name) => {
    expect(parseImportFileName(name)).toBeNull();
  });
});

describe('applyImport: locales the registry declares but discovery could not read', () => {
  it.each([
    ['a shorthand entry', `{ de }`, Q],
    [
      'a createTranslation with a variable object',
      `{ de: () => import('./q').then((m) => m.qDe) }`,
      `${Q}\nconst o = { title: 'Zitate' };\nexport const qDe = q.createTranslation('de', o);`,
    ],
    [
      'an async loader',
      `{ de: async () => (await import('./q')).qDe }`,
      `${Q}\nexport const qDe = q.createTranslation('de', { title: 'Zitate' });`,
    ],
  ])('refuses to replace %s', (_, map, module) => {
    const p = withFiles({
      '/q.ts': module,
      '/r.ts': `registerNamespace(${DEFAULT}, ${map});`,
    });
    const registryBefore = p.getSourceFileOrThrow('/r.ts').getFullText();
    expect(() => applyImport(p, only(p), 'de', { title: 'Neu' })).toThrow(
      /"de".*could not be read/,
    );
    expect(p.getSourceFileOrThrow('/r.ts').getFullText()).toBe(registryBefore);
    expect(p.getSourceFile('/quote.de.ts')).toBeUndefined();
  });

  it('refuses a new locale when the locale map holds a spread', () => {
    const p = withFiles({
      '/q.ts': Q,
      '/r.ts': `const more = {};\nregisterNamespace(${DEFAULT}, { ...more });`,
    });
    expect(() => applyImport(p, only(p), 'de', { title: 'Neu' })).toThrow(
      /spread/,
    );
    expect(p.getSourceFile('/quote.de.ts')).toBeUndefined();
  });

  it('still adds an unrelated new locale next to a skipped one', () => {
    const p = withFiles({
      '/q.ts': Q,
      '/r.ts': `registerNamespace(${DEFAULT}, { fr });`,
    });
    expect(applyImport(p, only(p), 'de', { title: 'Neu' }).created).toBe(true);
  });
});

describe('applyImport: existing locale modules', () => {
  it('updates an anonymous default-export locale module in place', () => {
    const p = withFiles({
      '/q.ts': Q,
      '/q.de.ts': `import { q } from './q';\nexport default q.createTranslation('de', { title: 'Alt' });`,
      '/r.ts': `registerNamespace(${DEFAULT}, { de: () => import('./q.de') });`,
    });
    const result = applyImport(p, only(p), 'de', { title: 'Neu' });
    expect(result).toEqual({ created: false, filePath: '/q.de.ts' });
    expect(only(p).locales[0]?.translation).toEqual({ title: 'Neu' });
  });

  it('updates a locale module default-exported through a const', () => {
    const p = withFiles({
      '/q.ts': Q,
      '/q.de.ts': `import { q } from './q';\nconst de = q.createTranslation('de', { title: 'Alt' });\nexport default de;`,
      '/r.ts': `registerNamespace(${DEFAULT}, { de: () => import('./q.de') });`,
    });
    applyImport(p, only(p), 'de', { title: 'Neu' });
    expect(only(p).locales[0]?.translation).toEqual({ title: 'Neu' });
  });
});

describe('applyImport: new locale modules', () => {
  it('rejects a non-literal locale map before creating the module', () => {
    const p = withFiles({
      '/q.ts': Q,
      '/r.ts': `const loaders = {};\nregisterNamespace(${DEFAULT}, loaders);`,
    });
    const files = p.getSourceFiles().length;
    expect(() => applyImport(p, only(p), 'de', { title: 'Neu' })).toThrow(
      /object literal/,
    );
    expect(p.getSourceFiles()).toHaveLength(files);
  });

  it.each([
    ['/q.ts', '/r.ts', './q', './quote.de'],
    ['/ns/q.ts', '/r.ts', './ns/q', './ns/quote.de'],
    ['/my.tsx-lib/q.ts', '/r.ts', './my.tsx-lib/q', './my.tsx-lib/quote.de'],
    ['/a/q.ts', '/b/r.ts', '../a/q', '../a/quote.de'],
  ])(
    'source %s, registry %s registers %s',
    (source, registry, from, expected) => {
      const p = withFiles({
        [source]: Q,
        [registry]: `registerNamespace(() => import('${from}').then((m) => m.q.translation), {});`,
      });
      applyImport(p, only(p), 'de', { title: 'Neu' });
      expect(p.getSourceFileOrThrow(registry).getFullText()).toContain(
        `import(${JSON.stringify(expected)})`,
      );
    },
  );

  it('derives the export name from a namespace with non-identifier characters', () => {
    const p = withFiles({
      '/q.ts': `export const q = createNamespace('quote-list', { title: 'Quotes' });`,
      '/r.ts': `registerNamespace(${DEFAULT}, {});`,
    });
    applyImport(p, only(p), 'de', { title: 'Neu' });
    expect(p.getSourceFileOrThrow('/quote-list.de.ts').getFullText()).toContain(
      'export const quotelistDe =',
    );
    expect(p.getSourceFileOrThrow('/r.ts').getFullText()).toContain(
      'm.quotelistDe',
    );
  });
});
