import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runExport, runGenerateManifest, runImport } from './commands';

let dir: string;
let warnings: string[];
const srcGlobs = ['src/**/*.ts'];

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const exists = (rel: string) => fs.existsSync(path.join(dir, rel));

const NS = `export const quote = createNamespace('quote', { title: 'Quotes' });`;
const registry = (locales = '{}') =>
  `registerNamespace(() => import('./ns').then((m) => m.quote.translation), ${locales});`;
const DUPES = {
  'src/ns.ts': `export const a = createNamespace('dup', { x: 'A' });
export const b = createNamespace('dup', { y: 'B' });`,
  'src/reg.ts': `registerNamespace(() => import('./ns').then((m) => m.a.translation), {});
registerNamespace(() => import('./ns').then((m) => m.b.translation), {});`,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmtranslate-runners-'));
  write('src/ns.ts', NS);
  write('src/reg.ts', registry());
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
    warnings.push(String(m));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runExport', () => {
  it('labels the source en by default', () => {
    runExport({ cwd: dir, srcGlobs, outDir: path.join(dir, 'out') });
    expect(exists('out/quote.en.json')).toBe(true);
  });

  it('can run twice into the same directory and creates nested directories', () => {
    const outDir = path.join(dir, 'a/b/i18n');
    runExport({ cwd: dir, srcGlobs, outDir });
    expect(() => runExport({ cwd: dir, srcGlobs, outDir })).not.toThrow();
    expect(exists('a/b/i18n/quote.en.json')).toBe(true);
  });

  it('warns about a locale with a dot, which import cannot read back', () => {
    write(
      'src/ns.ts',
      `${NS}\nexport const quoteSl = quote.createTranslation('sl.SI', { title: 'Citati' });`,
    );
    write(
      'src/reg.ts',
      registry(`{ 'sl.SI': () => import('./ns').then((m) => m.quoteSl) }`),
    );
    runExport({ cwd: dir, srcGlobs, outDir: path.join(dir, 'out') });
    expect(warnings.some((w) => w.includes('sl.SI'))).toBe(true);
  });

  it('prints no warnings for a clean project', () => {
    runExport({ cwd: dir, srcGlobs, outDir: path.join(dir, 'out') });
    expect(warnings).toEqual([]);
  });

  it('names the duplicate namespace', () => {
    for (const [rel, text] of Object.entries(DUPES)) write(rel, text);
    expect(() =>
      runExport({ cwd: dir, srcGlobs, outDir: path.join(dir, 'out') }),
    ).toThrow(/Duplicate namespace.*dup/);
  });
});

describe('runImport', () => {
  it('fails on a duplicate namespace', () => {
    for (const [rel, text] of Object.entries(DUPES)) write(rel, text);
    fs.mkdirSync(path.join(dir, 'in'));
    expect(() =>
      runImport({ cwd: dir, srcGlobs, inDir: path.join(dir, 'in') }),
    ).toThrow(/Duplicate namespace/);
  });

  it('reports only .json files as skipped', () => {
    write('in/README.md', '# notes');
    write('in/.gitkeep', '');
    write('in/typo.json', '{}');
    const report = runImport({
      cwd: dir,
      srcGlobs,
      inDir: path.join(dir, 'in'),
    });
    expect(report.skipped.map((s) => s.file)).toEqual(['typo.json']);
  });
});

describe('runGenerateManifest', () => {
  const outFile = () => path.join(dir, 'mmtranslate.config.ts');

  it('fails on a duplicate namespace', () => {
    for (const [rel, text] of Object.entries(DUPES)) write(rel, text);
    expect(() =>
      runGenerateManifest({ cwd: dir, srcGlobs, outFile: outFile() }),
    ).toThrow(/Duplicate namespace/);
  });

  it('forwards discovery warnings', () => {
    write(
      'src/reg.ts',
      `${registry()}\nregisterNamespace(() => import('./missing').then((m) => m.x.translation), {});`,
    );
    runGenerateManifest({ cwd: dir, srcGlobs, outFile: outFile() });
    expect(warnings.some((w) => w.includes('./missing'))).toBe(true);
  });

  it('records the given source locale', () => {
    const content = runGenerateManifest({
      cwd: dir,
      srcGlobs,
      outFile: outFile(),
      sourceLocale: 'fr',
    });
    expect(content).toContain('"sourceLocale": "fr"');
  });
});
