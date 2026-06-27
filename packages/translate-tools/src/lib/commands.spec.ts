/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Project } from 'ts-morph';
import {
  applyImport,
  parseImportFileName,
  planExport,
  validateImport,
} from './commands';
import { discoverFromProject } from './discover';

function project(): Project {
  const p = new Project({ useInMemoryFileSystem: true });
  p.createSourceFile(
    '/namespaces.ts',
    `export const common = createNamespace('common', { save: 'Save' });
     export const quote = common.createMergedNamespace('quote', {
       greeting: 'Hello {name}',
       detail: { authorLabel: 'Author' },
     });
     export const quoteSl = quote.createTranslation('sl-SI', {
       greeting: 'Zdravo {name}',
       detail: { authorLabel: 'Avtor' },
     });`,
  );
  p.createSourceFile(
    '/registry.ts',
    `registerNamespace(() => import('./namespaces').then((m) => m.common.translation), {});
     registerNamespace(
       () => import('./namespaces').then((m) => m.quote.translation),
       { 'sl-SI': () => import('./namespaces').then((m) => m.quoteSl) },
     );`,
  );
  return p;
}

const quoteNs = (p: Project) =>
  discoverFromProject(p, { sourceLocale: 'en' }).find(
    (n) => n.namespace === 'quote',
  )!;

describe('parseImportFileName', () => {
  it('parses namespace + locale (including dashed locales)', () => {
    expect(parseImportFileName('quote.en.json')).toEqual({
      namespace: 'quote',
      locale: 'en',
    });
    expect(parseImportFileName('common.sl-SI.json')).toEqual({
      namespace: 'common',
      locale: 'sl-SI',
    });
  });

  it('returns null for non-matching names', () => {
    expect(parseImportFileName('quote.json')).toBeNull();
    expect(parseImportFileName('quote.en.txt')).toBeNull();
    expect(parseImportFileName('readme.md')).toBeNull();
  });

  it('rejects a stray-dot name instead of folding it into the locale', () => {
    expect(parseImportFileName('quote.sl.si.json')).toBeNull();
    expect(parseImportFileName('.mmtranslate-meta.json')).toBeNull();
  });
});

describe('planExport', () => {
  it('emits source + target files, each namespace independent', () => {
    const files = planExport(
      discoverFromProject(project(), { sourceLocale: 'en' }),
    );
    expect(files.map((f) => f.fileName).sort()).toEqual([
      'common.en.json',
      'quote.en.json',
      'quote.sl-SI.json',
    ]);
    expect(
      JSON.parse(files.find((f) => f.fileName === 'quote.en.json')!.content),
    ).toEqual({
      greeting: 'Hello {name}',
      detail: { authorLabel: 'Author' },
    });
  });
});

describe('validateImport', () => {
  const source = {
    greeting: 'Hello {name}',
    detail: { authorLabel: 'Author' },
  };

  it('passes a valid, placeholder-matching translation', () => {
    expect(
      validateImport(
        { greeting: 'Hallo {name}', detail: { authorLabel: 'Autor' } },
        source,
      ),
    ).toEqual([]);
  });

  it('collects multiple issues (invalid ICU + dropped placeholder)', () => {
    const issues = validateImport(
      { greeting: 'Hallo', detail: { authorLabel: '{n, plural, one {x}' } },
      source,
    );
    expect(issues.map((i) => i.key).sort()).toEqual([
      'detail.authorLabel',
      'greeting',
    ]);
  });

  it('does not flag parity for an extra key absent from the source (when all source keys present)', () => {
    expect(
      validateImport(
        { greeting: 'Hallo {name}', detail: { authorLabel: 'Autor' }, extra: 'Hi {x}' },
        source,
      ),
    ).toEqual([]); // extra key carries valid ICU and no source counterpart → no issue
  });

  it('reports a source key missing from the translation', () => {
    const issues = validateImport({ greeting: 'Hallo {name}' }, source);
    expect(issues).toEqual([
      { key: 'detail.authorLabel', message: 'missing key' },
    ]);
  });

  it('reports a clean issue (not a throw) when the SOURCE message is invalid ICU', () => {
    expect(() =>
      validateImport({ greeting: 'Hallo {name}' }, { greeting: '{n, plural, one {x}' }),
    ).not.toThrow();
    const issues = validateImport(
      { greeting: 'Hallo {name}' },
      { greeting: '{n, plural, one {x}' },
    );
    expect(issues[0]?.key).toBe('greeting');
    expect(issues[0]?.message).toContain('source message is invalid ICU');
  });
});

describe('applyImport', () => {
  it('updates an existing locale in place', () => {
    const p = project();
    const res = applyImport(p, quoteNs(p), 'sl-SI', {
      greeting: 'Pozdravljen {name}',
      detail: { authorLabel: 'Avtor' },
    });
    expect(res.created).toBe(false);
    expect(
      quoteNs(p).locales.find((l) => l.locale === 'sl-SI')?.translation[
        'greeting'
      ],
    ).toBe('Pozdravljen {name}');
  });

  it('creates a new locale for a MERGED namespace and registers it (dashed locale → PascalCase id)', () => {
    const p = project();
    const fr = {
      greeting: 'Bonjour {name}',
      detail: { authorLabel: 'Auteur' },
    };
    const res = applyImport(p, quoteNs(p), 'fr-CA', fr);

    expect(res.created).toBe(true);
    // exportName derives from source export + PascalCased locale: quote + FrCa
    expect(p.getSourceFileOrThrow(res.filePath).getFullText()).toContain(
      'quoteFrCa',
    );
    expect(p.getSourceFileOrThrow('/registry.ts').getFullText()).toContain(
      'm.quoteFrCa',
    );
    expect(
      quoteNs(p).locales.find((l) => l.locale === 'fr-CA')?.translation,
    ).toEqual(fr);
  });

  it('throws when a locale collides with an existing one on the same identifier', () => {
    const p = project();
    // `sl-SI` is already registered → `sl_SI` PascalCases to the same `SlSi`
    expect(() =>
      applyImport(p, quoteNs(p), 'sl_SI', { greeting: 'x {name}', detail: { authorLabel: 'A' } }),
    ).toThrow(/collides/);
  });

  it('throws when a locale has no characters to form an identifier', () => {
    const p = project();
    expect(() =>
      applyImport(p, quoteNs(p), '--', { greeting: 'x {name}', detail: { authorLabel: 'A' } }),
    ).toThrow(/identifier/);
  });

  it('throws (rather than picking the wrong call) when the registry call cannot be located', () => {
    const p = project();
    const ns = { ...quoteNs(p), registryCallIndex: 99 };
    expect(() =>
      applyImport(p, ns, 'de', { greeting: 'x {name}', detail: { authorLabel: 'A' } }),
    ).toThrow(/Could not locate the registerNamespace call/);
  });
});
