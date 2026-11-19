import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseConfig } from './config';
import { main } from './main';

let dir: string;
let warnings: string[];
let errors: string[];

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const exists = (rel: string) => fs.existsSync(path.join(dir, rel));
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
const run = (...argv: string[]) => main(argv, dir);
const exported = (outDir = 'translations') =>
  fs
    .readdirSync(path.join(dir, outDir))
    .filter((f) => !f.startsWith('.'))
    .sort();

const NAMESPACES = `export const common = createNamespace('common', { save: 'Save' });
export const quote = createNamespace('quote', { title: 'Save' });`;
const REGISTRY = `registerNamespace(() => import('./namespaces').then((m) => m.common.translation), {});
registerNamespace(() => import('./namespaces').then((m) => m.quote.translation), {});`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmtranslate-config-'));
  write('lib/namespaces.ts', NAMESPACES);
  write('lib/registry.ts', REGISTRY);
  warnings = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
    warnings.push(String(m));
  });
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
    errors.push(String(m));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('generate-manifest writes a config the CLI reads back', () => {
  it('records the globs, source locale and namespace names', () => {
    run('generate-manifest', '--src', 'lib/**/*.ts', '--source-locale', 'fr');
    expect(parseConfig(read('mmtranslate.config.ts'), 'x')).toEqual({
      src: ['lib/**/*.ts'],
      sourceLocale: 'fr',
      namespaces: ['common', 'quote'],
    });
  });

  it('defaults the manifest source locale to en', () => {
    run('generate-manifest', '--src', 'lib/**/*.ts');
    expect(parseConfig(read('mmtranslate.config.ts'), 'x').sourceLocale).toBe(
      'en',
    );
  });

  it('writes src relative to a manifest in another directory', () => {
    run('generate-manifest', '--src', 'lib/**/*.ts', '--out', 'cfg/m.ts');
    expect(parseConfig(read('cfg/m.ts'), 'x').src).toEqual(['../lib/**/*.ts']);
  });

  it('later commands take --src and --source-locale from it', () => {
    run('generate-manifest', '--src', 'lib/**/*.ts', '--source-locale', 'fr');
    expect(run('export')).toBe(0);
    expect(exported()).toEqual(['common.fr.json', 'quote.fr.json']);
  });

  it('a flag wins over the config', () => {
    run('generate-manifest', '--src', 'lib/**/*.ts', '--source-locale', 'fr');
    run('export', '--source-locale', 'de');
    expect(exported()).toEqual(['common.de.json', 'quote.de.json']);
  });

  it('a namespace added after generation is skipped with a warning', () => {
    run('generate-manifest', '--src', 'lib/**/*.ts');
    fs.appendFileSync(
      path.join(dir, 'lib/namespaces.ts'),
      `\nexport const extra = createNamespace('extra', { a: 'A' });`,
    );
    fs.appendFileSync(
      path.join(dir, 'lib/registry.ts'),
      `\nregisterNamespace(() => import('./namespaces').then((m) => m.extra.translation), {});`,
    );
    run('export');
    expect(exported()).toEqual(['common.en.json', 'quote.en.json']);
    expect(warnings.some((w) => w.includes('"extra"'))).toBe(true);
  });

  it('re-running generate-manifest lists every discovered namespace again', () => {
    write(
      'mmtranslate.config.ts',
      `export default { src: ['lib/**/*.ts'], namespaces: [] };`,
    );
    run('generate-manifest');
    expect(parseConfig(read('mmtranslate.config.ts'), 'x').namespaces).toEqual([
      'common',
      'quote',
    ]);
  });
});

describe('the namespaces list', () => {
  beforeEach(() =>
    write(
      'mmtranslate.config.ts',
      `export default { src: ['lib/**/*.ts'], namespaces: ['quote'] };`,
    ),
  );

  it('limits export', () => {
    run('export');
    expect(exported()).toEqual(['quote.en.json']);
    expect(warnings.some((w) => w.includes('"common"'))).toBe(true);
  });

  it('limits import', () => {
    run('export', '--src', 'lib/**/*.ts');
    write('translations/common.de.json', JSON.stringify({ save: 'Speichern' }));
    write('translations/quote.de.json', JSON.stringify({ title: 'Zitate' }));
    expect(run('import')).toBe(0);
    expect(exists('lib/quote.de.ts')).toBe(true);
    expect(exists('lib/common.de.ts')).toBe(false);
  });

  it('limits lint, and the left-out files still do not count as usage', () => {
    write('lib/app.ts', `t.title;`);
    expect(run('dupes')).toBe(0);
    expect(run('unused')).toBe(0);
  });

  it('is not applied by generate-manifest', () => {
    run('generate-manifest');
    expect(read('mmtranslate.config.ts')).toContain('"common"');
  });
});

describe('finding the config', () => {
  it('reads --config from another path, resolving src against its directory', () => {
    write(
      'cfg/m.ts',
      `export default { src: ['../lib/**/*.ts'], sourceLocale: 'fr' };`,
    );
    run('export', '--config', 'cfg/m.ts');
    expect(exported()).toEqual(['common.fr.json', 'quote.fr.json']);
  });

  it('fails when the --config file is missing', () => {
    expect(run('export', '--config', 'nope.ts')).toBe(1);
    expect(errors.join('\n')).toContain('Config file not found');
  });

  it('fails on an invalid config and names it', () => {
    write('mmtranslate.config.ts', `export default { srcs: [] };`);
    expect(run('export')).toBe(1);
    expect(errors.join('\n')).toContain('mmtranslate.config.ts');
  });

  it('reads a 1.1 manifest as the namespace list', () => {
    write(
      'mmtranslate.config.ts',
      `export default [{ "namespace": "common", "sourceLocale": "en", "locales": [] }];`,
    );
    run('export', '--src', 'lib/**/*.ts');
    expect(exported()).toEqual(['common.en.json']);
  });

  it('without a config, the built-in defaults apply', () => {
    expect(run('export')).toBe(0);
    expect(exported()).toEqual([]);
  });
});
