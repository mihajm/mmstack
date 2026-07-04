import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runExport, runGenerateManifest, runImport } from './lib/commands';

describe('cli runners (ephemeral fs, multi-namespace)', () => {
  let dir: string;
  const globs = ['src/**/*.ts'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmtranslate-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

    fs.writeFileSync(
      path.join(dir, 'src/namespaces.ts'),
      `import { createNamespace, withParams } from '@mmstack/translate';

       export const common = createNamespace('common', {
         save: 'Save',
         cancel: 'Cancel',
         items: '{count, plural, one {# item} other {# items}}',
         greeting: withParams<{ name: string }>(
           '{count, plural, one {Hi {name}} other {Hi {name} (+{count})}}',
         ),
       });

       export const quote = common.createMergedNamespace('quote', {
         title: 'Quotes',
         by: 'by {author}',
         status: '{state, select, draft {Draft} published {Published} other {Unknown}}',
       });

       export const settings = createNamespace('settings', {
         theme: { label: 'Theme', dark: 'Dark', light: 'Light' },
       });`,
    );

    fs.writeFileSync(
      path.join(dir, 'src/registry.ts'),
      `import { registerNamespace } from '@mmstack/translate';
       registerNamespace(() => import('./namespaces').then((m) => m.common.translation), {});
       registerNamespace(() => import('./namespaces').then((m) => m.quote.translation), {});
       registerNamespace(() => import('./namespaces').then((m) => m.settings.translation), {});`,
    );
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const readJson = (out: string, name: string) =>
    JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));

  it('exports each namespace independently (merge un-merged) with full ICU + withParams', () => {
    const out = path.join(dir, 'i18n');
    const files = runExport({
      cwd: dir,
      srcGlobs: globs,
      outDir: out,
      sourceLocale: 'en',
    });

    expect(files.map((f) => f.fileName).sort()).toEqual([
      'common.en.json',
      'quote.en.json',
      'settings.en.json',
    ]);

    expect(readJson(out, 'quote.en.json')).toEqual({
      title: 'Quotes',
      by: 'by {author}',
      status:
        '{state, select, draft {Draft} published {Published} other {Unknown}}',
    });

    expect(readJson(out, 'common.en.json')).toEqual({
      save: 'Save',
      cancel: 'Cancel',
      items: '{count, plural, one {# item} other {# items}}',
      greeting: '{count, plural, one {Hi {name}} other {Hi {name} (+{count})}}',
    });

    expect(readJson(out, 'settings.en.json')).toEqual({
      theme: { label: 'Theme', dark: 'Dark', light: 'Light' },
    });
  });

  it('imports a new locale for every namespace, registers loaders, and re-exports identically', () => {
    const out = path.join(dir, 'i18n');
    runExport({ cwd: dir, srcGlobs: globs, outDir: out, sourceLocale: 'en' });

    const de = {
      common: {
        save: 'Speichern',
        cancel: 'Abbrechen',
        items: '{count, plural, one {# Element} other {# Elemente}}',
        greeting:
          '{count, plural, one {Hi {name}} other {Hi {name} (+{count})}}',
      },
      quote: {
        title: 'Zitate',
        by: 'von {author}',
        status:
          '{state, select, draft {Entwurf} published {Veröffentlicht} other {Unbekannt}}',
      },
      settings: { theme: { label: 'Thema', dark: 'Dunkel', light: 'Hell' } },
    };
    for (const [ns, tree] of Object.entries(de))
      fs.writeFileSync(path.join(out, `${ns}.de.json`), JSON.stringify(tree));

    const report = runImport({
      cwd: dir,
      srcGlobs: globs,
      inDir: out,
      sourceLocale: 'en',
    });
    expect(report.rejected).toEqual([]);
    expect(report.applied).toBe(3);

    for (const ns of ['common', 'quote', 'settings']) {
      expect(fs.existsSync(path.join(dir, `src/${ns}.de.ts`))).toBe(true);
    }
    const registry = fs.readFileSync(path.join(dir, 'src/registry.ts'), 'utf8');
    expect(registry).toContain('m.commonDe');
    expect(registry).toContain('m.quoteDe');
    expect(registry).toContain('m.settingsDe');

    const out2 = path.join(dir, 'i18n2');
    const files2 = runExport({
      cwd: dir,
      srcGlobs: globs,
      outDir: out2,
      sourceLocale: 'en',
    });
    expect(
      files2
        .map((f) => f.fileName)
        .filter((n) => n.endsWith('.de.json'))
        .sort(),
    ).toEqual(['common.de.json', 'quote.de.json', 'settings.de.json']);
    expect(readJson(out2, 'common.de.json')).toEqual(de.common);
    expect(readJson(out2, 'quote.de.json')).toEqual(de.quote);
    expect(readJson(out2, 'settings.de.json')).toEqual(de.settings);
  });

  it('rejects a translation that drops a placeholder and writes nothing', () => {
    const out = path.join(dir, 'i18n');
    runExport({ cwd: dir, srcGlobs: globs, outDir: out, sourceLocale: 'en' });

    fs.writeFileSync(
      path.join(out, 'quote.de.json'),
      JSON.stringify({
        title: 'Zitate',
        by: 'von',
        status: '{state, select, other {x}}',
      }),
    );

    const report = runImport({
      cwd: dir,
      srcGlobs: globs,
      inDir: out,
      sourceLocale: 'en',
    });
    expect(report.applied).toBe(0);
    expect(report.rejected[0]?.file).toBe('quote.de.json');
    expect(report.rejected[0]?.issues.some((i) => i.key === 'by')).toBe(true);
    expect(fs.existsSync(path.join(dir, 'src/quote.de.ts'))).toBe(false);
  });

  it('applies valid files and rejects invalid ones in the same run', () => {
    const out = path.join(dir, 'i18n');
    runExport({ cwd: dir, srcGlobs: globs, outDir: out, sourceLocale: 'en' });
    fs.writeFileSync(
      path.join(out, 'common.de.json'),
      JSON.stringify({
        save: 'Speichern',
        cancel: 'Abbrechen',
        items: '{count, plural, one {# Element} other {# Elemente}}',
        greeting:
          '{count, plural, one {Hi {name}} other {Hi {name} (+{count})}}',
      }),
    );
    fs.writeFileSync(
      path.join(out, 'quote.de.json'),
      JSON.stringify({
        title: 'Zitate',
        by: 'von',
        status: '{state, select, other {x}}',
      }),
    );

    const report = runImport({
      cwd: dir,
      srcGlobs: globs,
      inDir: out,
      sourceLocale: 'en',
    });
    expect(report.applied).toBe(1);
    expect(report.rejected.map((r) => r.file)).toEqual(['quote.de.json']);
    expect(fs.existsSync(path.join(dir, 'src/common.de.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'src/quote.de.ts'))).toBe(false);
  });

  it('re-importing an existing locale updates it in place (idempotent, no duplicate file)', () => {
    const out = path.join(dir, 'i18n');
    runExport({ cwd: dir, srcGlobs: globs, outDir: out, sourceLocale: 'en' });

    const write = (greeting: string) =>
      fs.writeFileSync(
        path.join(out, 'common.de.json'),
        JSON.stringify({
          save: 'Speichern',
          cancel: 'Abbrechen',
          items: '{count, plural, one {# Element} other {# Elemente}}',
          greeting,
        }),
      );

    write('{count, plural, one {Hi {name}} other {Hi {name} (+{count})}}');
    expect(
      runImport({ cwd: dir, srcGlobs: globs, inDir: out, sourceLocale: 'en' })
        .applied,
    ).toBe(1);

    write(
      '{count, plural, one {Hallo {name}} other {Hallo {name} (+{count})}}',
    );
    expect(
      runImport({ cwd: dir, srcGlobs: globs, inDir: out, sourceLocale: 'en' })
        .applied,
    ).toBe(1);

    const reExported = path.join(dir, 'i18n2');
    runExport({
      cwd: dir,
      srcGlobs: globs,
      outDir: reExported,
      sourceLocale: 'en',
    });
    expect(readJson(reExported, 'common.de.json').greeting).toContain(
      'Hallo {name}',
    );

    const registry = fs.readFileSync(path.join(dir, 'src/registry.ts'), 'utf8');
    expect(registry.match(/m\.commonDe/g)?.length).toBe(1);
  });

  it('rejects a malformed-JSON file per-file and still applies the valid ones', () => {
    const out = path.join(dir, 'i18n');
    runExport({ cwd: dir, srcGlobs: globs, outDir: out, sourceLocale: 'en' });
    fs.writeFileSync(
      path.join(out, 'common.de.json'),
      JSON.stringify({
        save: 'Speichern',
        cancel: 'Abbrechen',
        items: '{count, plural, one {# Element} other {# Elemente}}',
        greeting:
          '{count, plural, one {Hi {name}} other {Hi {name} (+{count})}}',
      }),
    );
    fs.writeFileSync(path.join(out, 'quote.de.json'), '{ not valid json ');

    const report = runImport({
      cwd: dir,
      srcGlobs: globs,
      inDir: out,
      sourceLocale: 'en',
    });
    expect(report.applied).toBe(1);
    expect(report.rejected.map((r) => r.file)).toEqual(['quote.de.json']);
    expect(report.rejected[0]?.issues[0]?.key).toBe('(parse)');
    expect(fs.existsSync(path.join(dir, 'src/common.de.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'src/quote.de.ts'))).toBe(false);
  });

  it('rejects a translation that omits a source key', () => {
    const out = path.join(dir, 'i18n');
    runExport({ cwd: dir, srcGlobs: globs, outDir: out, sourceLocale: 'en' });
    fs.writeFileSync(
      path.join(out, 'quote.de.json'),
      JSON.stringify({ title: 'Zitate', by: 'von {author}' }),
    );

    const report = runImport({
      cwd: dir,
      srcGlobs: globs,
      inDir: out,
      sourceLocale: 'en',
    });
    expect(report.applied).toBe(0);
    expect(
      report.rejected[0]?.issues.some(
        (i) => i.key === 'status' && i.message === 'missing key',
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(dir, 'src/quote.de.ts'))).toBe(false);
  });

  it('throws on a duplicate namespace name', () => {
    fs.writeFileSync(
      path.join(dir, 'src/namespaces.ts'),
      `import { createNamespace } from '@mmstack/translate';
       export const a = createNamespace('dup', { x: 'A' });
       export const b = createNamespace('dup', { y: 'B' });`,
    );
    fs.writeFileSync(
      path.join(dir, 'src/registry.ts'),
      `import { registerNamespace } from '@mmstack/translate';
       registerNamespace(() => import('./namespaces').then((m) => m.a.translation), {});
       registerNamespace(() => import('./namespaces').then((m) => m.b.translation), {});`,
    );
    expect(() =>
      runExport({
        cwd: dir,
        srcGlobs: globs,
        outDir: path.join(dir, 'i18n'),
        sourceLocale: 'en',
      }),
    ).toThrow(/Duplicate namespace/);
  });

  it('rejects (per-file) before clobbering an existing file, unless --force is passed', () => {
    const out = path.join(dir, 'i18n');
    runExport({ cwd: dir, srcGlobs: globs, outDir: out, sourceLocale: 'en' });
    fs.writeFileSync(
      path.join(out, 'quote.de.json'),
      JSON.stringify({
        title: 'Zitate',
        by: 'von {author}',
        status: '{state, select, other {x}}',
      }),
    );
    fs.writeFileSync(
      path.join(out, 'settings.de.json'),
      JSON.stringify({ theme: { label: 'Thema', dark: 'Dunkel', light: 'Hell' } }),
    );
    // A stale, unregistered module already sits at quote's target path.
    fs.writeFileSync(
      path.join(dir, 'src/quote.de.ts'),
      `export const hand = 'do not lose me';`,
    );

    const first = runImport({
      cwd: dir,
      srcGlobs: globs,
      inDir: out,
      sourceLocale: 'en',
    });
    expect(first.applied).toBe(1);
    expect(first.rejected).toEqual([
      {
        file: 'quote.de.json',
        issues: [
          { key: '(apply)', message: expect.stringContaining('already exists') },
        ],
      },
    ]);
    expect(fs.readFileSync(path.join(dir, 'src/quote.de.ts'), 'utf8')).toContain(
      'do not lose me',
    );

    const forced = runImport({
      cwd: dir,
      srcGlobs: globs,
      inDir: out,
      sourceLocale: 'en',
      force: true,
    });
    expect(forced.rejected).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'src/quote.de.ts'), 'utf8')).toContain(
      'createTranslation',
    );
  });

  it('reports unknown-namespace and stray-dot json files as skipped (typo guard)', () => {
    const out = path.join(dir, 'i18n');
    runExport({ cwd: dir, srcGlobs: globs, outDir: out, sourceLocale: 'en' });
    fs.writeFileSync(path.join(out, 'qoute.de.json'), JSON.stringify({ title: 'x' }));
    fs.writeFileSync(path.join(out, 'quote.sl.si.json'), JSON.stringify({ title: 'x' }));

    const report = runImport({
      cwd: dir,
      srcGlobs: globs,
      inDir: out,
      sourceLocale: 'en',
    });
    expect(report.applied).toBe(0);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { file: 'qoute.de.json', reason: expect.stringContaining('no namespace "qoute"') },
        { file: 'quote.sl.si.json', reason: expect.stringContaining('<namespace>.<locale>.json') },
      ]),
    );
    expect(report.skipped.some((s) => s.file.includes('mmtranslate-meta'))).toBe(false);
  });

  it('rejects a translation with a key the source does not have (would not compile)', () => {
    const out = path.join(dir, 'i18n');
    runExport({ cwd: dir, srcGlobs: globs, outDir: out, sourceLocale: 'en' });
    fs.writeFileSync(
      path.join(out, 'quote.de.json'),
      JSON.stringify({
        title: 'Zitate',
        by: 'von {author}',
        status: '{state, select, draft {Entwurf} published {Ok} other {x}}',
        subtitle: 'Untertitel',
      }),
    );

    const report = runImport({
      cwd: dir,
      srcGlobs: globs,
      inDir: out,
      sourceLocale: 'en',
    });
    expect(report.applied).toBe(0);
    expect(
      report.rejected[0]?.issues.some(
        (i) => i.key === 'subtitle' && i.message.includes('unknown key'),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(dir, 'src/quote.de.ts'))).toBe(false);
  });

  it('round-trips a non-en source locale via the sidecar (no bogus source-as-target import)', () => {
    const out = path.join(dir, 'i18n');
    runExport({ cwd: dir, srcGlobs: globs, outDir: out, sourceLocale: 'fr' });
    expect(fs.existsSync(path.join(out, 'quote.fr.json'))).toBe(true);

    fs.writeFileSync(
      path.join(out, 'quote.de.json'),
      JSON.stringify({
        title: 'Zitate',
        by: 'von {author}',
        status: '{state, select, other {x}}',
      }),
    );

    const report = runImport({ cwd: dir, srcGlobs: globs, inDir: out });
    expect(report.applied).toBe(1);
    expect(report.rejected).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'src/quote.fr.ts'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'src/quote.de.ts'))).toBe(true);
  });

  it('round-trips a default-export namespace declared with the `() => import(x)` shorthand', () => {
    fs.writeFileSync(
      path.join(dir, 'src/namespaces.ts'),
      `import { createNamespace } from '@mmstack/translate';
       const quote = createNamespace('quote', { title: 'Quotes', by: 'by {author}' });
       export default quote;`,
    );
    fs.writeFileSync(
      path.join(dir, 'src/registry.ts'),
      `import { registerNamespace } from '@mmstack/translate';
       registerNamespace(() => import('./namespaces'), {});`,
    );

    const out = path.join(dir, 'i18n');
    const files = runExport({
      cwd: dir,
      srcGlobs: globs,
      outDir: out,
      sourceLocale: 'en',
    });
    expect(files.map((f) => f.fileName)).toEqual(['quote.en.json']);

    fs.writeFileSync(
      path.join(out, 'quote.de.json'),
      JSON.stringify({ title: 'Zitate', by: 'von {author}' }),
    );
    const report = runImport({
      cwd: dir,
      srcGlobs: globs,
      inDir: out,
      sourceLocale: 'en',
    });
    expect(report.applied).toBe(1);

    const gen = fs.readFileSync(path.join(dir, 'src/quote.de.ts'), 'utf8');
    expect(gen).toContain('import quote from "./namespaces"');
    expect(gen).toContain('quote.createTranslation');
    expect(
      fs.readFileSync(path.join(dir, 'src/registry.ts'), 'utf8'),
    ).toContain('m.quoteDe');
  });

  it('surfaces discovery warnings (a broken loader is skipped, not silently dropped)', () => {
    fs.appendFileSync(
      path.join(dir, 'src/registry.ts'),
      `\nregisterNamespace(() => import('./missing').then((m) => m.gone.translation), {});`,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const files = runExport({
        cwd: dir,
        srcGlobs: globs,
        outDir: path.join(dir, 'i18n'),
        sourceLocale: 'en',
      });
      expect(files).toHaveLength(3);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('generate-manifest lists the discovered namespaces', () => {
    const outFile = path.join(dir, 'mmtranslate.config.ts');
    const content = runGenerateManifest({
      cwd: dir,
      srcGlobs: globs,
      outFile,
      sourceLocale: 'en',
    });
    expect(fs.existsSync(outFile)).toBe(true);
    for (const ns of ['common', 'quote', 'settings'])
      expect(content).toContain(`"${ns}"`);
  });
});
