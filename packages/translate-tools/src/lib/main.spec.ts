import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from './main';

let dir: string;
let out: { log: string[]; warn: string[]; error: string[] };

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const exists = (rel: string) => fs.existsSync(path.join(dir, rel));
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
const run = (...argv: string[]) => main(argv, dir);
const stderr = () => [...out.warn, ...out.error].join('\n');

const namespaces = (quote = `title: 'Quotes', by: 'by {author}'`) =>
  `export const common = createNamespace('common', { save: 'Save', cancel: 'Cancel' });
export const quote = createNamespace('quote', { ${quote} });`;
const REGISTRY = `registerNamespace(() => import('./namespaces').then((m) => m.common.translation), {});
registerNamespace(() => import('./namespaces').then((m) => m.quote.translation), {});`;
const APP = `t.save; t.cancel; t.title; t.by;`;
const QUOTE_DE = { title: 'Zitate', by: 'von {author}' };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmtranslate-main-'));
  write('src/namespaces.ts', namespaces());
  write('src/registry.ts', REGISTRY);
  write('src/app.ts', APP);
  out = { log: [], warn: [], error: [] };
  for (const level of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      out[level].push(args.map(String).join(' '));
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('main: usage', () => {
  it('prints usage and exits 0 with no command', () => {
    expect(run()).toBe(0);
    expect(stderr()).toContain('Usage: mmtranslate');
  });

  it.each(['bogus', 'constructor', 'toString', '__proto__', 'valueOf'])(
    'prints usage and exits 1 for %s',
    (command) => {
      expect(run(command)).toBe(1);
      expect(stderr()).toContain('Usage: mmtranslate');
    },
  );

  it('exits 1 and names the flag when a value is missing', () => {
    expect(run('export', '--out')).toBe(1);
    expect(stderr()).toContain('Missing value for --out');
  });
});

describe('main: export', () => {
  it('writes to --out and exits 0', () => {
    expect(run('export', '--out', 'i18n')).toBe(0);
    expect(exists('i18n/common.en.json')).toBe(true);
    expect(exists('i18n/quote.en.json')).toBe(true);
  });

  it('defaults --out to translations', () => {
    expect(run('export')).toBe(0);
    expect(exists('translations/common.en.json')).toBe(true);
  });

  it('labels the source with --source-locale', () => {
    run('export', '--source-locale', 'fr');
    expect(exists('translations/common.fr.json')).toBe(true);
    expect(exists('translations/common.en.json')).toBe(false);
  });

  it('defaults --src to src/**/*.ts and honors --src', () => {
    fs.renameSync(path.join(dir, 'src'), path.join(dir, 'lib'));
    run('export', '--out', 'a');
    expect(fs.readdirSync(path.join(dir, 'a'))).toEqual([
      '.mmtranslate-meta.json',
    ]);
    run('export', '--out', 'b', '--src', 'lib/**/*.ts');
    expect(exists('b/quote.en.json')).toBe(true);
  });

  it('does not export on another command', () => {
    run('import');
    expect(exists('translations')).toBe(false);
  });
});

describe('main: import', () => {
  const exportWithDe = (de: object = QUOTE_DE) => {
    run('export');
    write('translations/quote.de.json', JSON.stringify(de));
  };

  it('defaults --in to translations and exits 0 on a clean import', () => {
    exportWithDe();
    expect(run('import')).toBe(0);
    expect(read('src/quote.de.ts')).toContain('createTranslation');
    expect(read('src/registry.ts')).toContain('import("./quote.de")');
  });

  it('reads --in', () => {
    run('export', '--out', 'i18n');
    write('i18n/quote.de.json', JSON.stringify(QUOTE_DE));
    expect(run('import', '--in', 'i18n')).toBe(0);
    expect(exists('src/quote.de.ts')).toBe(true);
  });

  it('exits 1 and reports a rejected file with its key, and a skipped one', () => {
    exportWithDe({ title: 'Zitate', by: 'von' });
    write('translations/qoute.de.json', '{}');
    expect(run('import')).toBe(1);
    expect(stderr()).toContain('quote.de.json');
    expect(stderr()).toContain('by');
    expect(stderr()).toContain('qoute.de.json');
    expect(exists('src/quote.de.ts')).toBe(false);
  });

  it('overwrites an unregistered module only with --force', () => {
    exportWithDe();
    write('src/quote.de.ts', `export const hand = 1;`);
    expect(run('import')).toBe(1);
    expect(read('src/quote.de.ts')).toContain('hand');
    expect(run('import', '--force')).toBe(0);
    expect(read('src/quote.de.ts')).toContain('createTranslation');
  });
});

describe('main: generate-manifest', () => {
  it('writes mmtranslate.config.ts by default, or --out', () => {
    expect(run('generate-manifest')).toBe(0);
    expect(read('mmtranslate.config.ts')).toContain('"common"');
    expect(run('generate-manifest', '--out', 'x.ts')).toBe(0);
    expect(read('x.ts')).toContain('"quote"');
  });
});

describe('main: dupes / unused / lint', () => {
  it.each(['dupes', 'unused', 'lint'])(
    '%s exits 0 on a clean project',
    (cmd) => {
      expect(run(cmd)).toBe(0);
      expect(out.log.join('\n')).toContain('No findings.');
    },
  );

  it.each(['dupes', 'lint'])('%s exits 1 on a duplicate value', (cmd) => {
    write('src/namespaces.ts', namespaces(`title: 'Save', by: 'by {author}'`));
    expect(run(cmd)).toBe(1);
  });

  it('unused does not run the duplicate rule', () => {
    write('src/namespaces.ts', namespaces(`title: 'Save', by: 'by {author}'`));
    expect(run('unused')).toBe(0);
  });

  it.each(['unused', 'lint'])('%s exits 1 on an unreferenced key', (cmd) => {
    write('src/app.ts', `t.save; t.cancel; t.title;`);
    expect(run(cmd)).toBe(1);
  });

  it('dupes does not run the unused rule', () => {
    write('src/app.ts', ``);
    expect(run('dupes')).toBe(0);
  });

  it('--app-src scans the given app sources for usage', () => {
    fs.rmSync(path.join(dir, 'src/app.ts'));
    write('app/main.ts', APP);
    expect(run('unused')).toBe(1);
    expect(run('unused', '--app-src', 'app/**/*.ts')).toBe(0);
  });

  it('--ignore-case folds case', () => {
    write('src/namespaces.ts', namespaces(`title: 'save', by: 'by {author}'`));
    expect(run('dupes')).toBe(0);
    expect(run('dupes', '--ignore-case')).toBe(1);
  });

  it('--report json prints the report as JSON', () => {
    write('src/namespaces.ts', namespaces(`title: 'Save', by: 'by {author}'`));
    run('dupes', '--report', 'json');
    const report = JSON.parse(out.log.join('\n'));
    expect(report.findings).toHaveLength(2);
  });

  it('prints a human report without --report json', () => {
    write('src/namespaces.ts', namespaces(`title: 'Save', by: 'by {author}'`));
    run('dupes');
    const text = out.log.join('\n');
    expect(text).toContain('common:save');
    expect(() => JSON.parse(text)).toThrow();
  });

  it('prints discovery warnings to stderr', () => {
    fs.appendFileSync(
      path.join(dir, 'src/registry.ts'),
      `\nregisterNamespace(() => import('./missing').then((m) => m.x.translation), {});`,
    );
    run('lint');
    expect(stderr()).toContain('./missing');
  });
});
