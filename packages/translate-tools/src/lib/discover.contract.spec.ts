import { Project } from 'ts-morph';
import { discoverFromProject } from './discover';

function withFiles(files: Record<string, string>): Project {
  const p = new Project({ useInMemoryFileSystem: true });
  for (const [name, content] of Object.entries(files))
    p.createSourceFile(name, content);
  return p;
}

function discover(files: Record<string, string>) {
  const warnings: string[] = [];
  const result = discoverFromProject(withFiles(files), {
    onWarn: (m) => warnings.push(m),
  });
  return { result, warnings };
}

const Q = `export const q = createNamespace('quote', { title: 'Quotes' });
export const qDe = q.createTranslation('de', { title: 'Zitate' });
export const qFr = q.createTranslation('fr', { title: 'Citations' });`;

const loader = (accessor: string, from = './q') =>
  `() => import('${from}').then((m) => m.${accessor})`;

const VALID_OTHER = `registerNamespace(() => import('./other').then((m) => m.o.translation), {});`;
const OTHER = `export const o = createNamespace('other', { a: 'A' });`;

describe('discoverFromProject: defaults', () => {
  it('labels the source locale `en` when no option is given', () => {
    const { result } = discover({
      '/q.ts': Q,
      '/r.ts': `registerNamespace(${loader('q.translation')}, {});`,
    });
    expect(result[0]?.source.locale).toBe('en');
  });

  it('accepts a single-argument registerNamespace (no locale map)', () => {
    const { result } = discover({
      '/q.ts': Q,
      '/r.ts': `registerNamespace(${loader('q.translation')});`,
    });
    expect(result.map((n) => [n.namespace, n.locales])).toEqual([
      ['quote', []],
    ]);
  });

  it('accepts a locale map held in a variable (no locales read)', () => {
    const { result } = discover({
      '/q.ts': Q,
      '/r.ts': `const locales = {};\nregisterNamespace(${loader('q.translation')}, locales);`,
    });
    expect(result.map((n) => [n.namespace, n.locales])).toEqual([
      ['quote', []],
    ]);
  });

  it('resolves a directory import through index.ts', () => {
    const { result } = discover({
      '/quote/index.ts': Q,
      '/r.ts': `registerNamespace(${loader('q.translation', './quote')}, {});`,
    });
    expect(result.map((n) => n.namespace)).toEqual(['quote']);
  });

  it('accepts the module-object loader `.then((m) => m)` as the shorthand', () => {
    const { result, warnings } = discover({
      '/q.ts': `export default createNamespace('quote', { title: 'Quotes' });`,
      '/q.de.ts': `import q from './q';\nexport const translation = q.createTranslation('de', { title: 'Zitate' });`,
      '/r.ts': `registerNamespace(() => import('./q').then((m) => m), {
  de: () => import('./q.de').then((mod) => mod),
});`,
    });
    expect(warnings).toEqual([]);
    expect(result[0]?.namespace).toBe('quote');
    expect(result[0]?.locales.map((l) => [l.locale, l.translation])).toEqual([
      ['de', { title: 'Zitate' }],
    ]);
  });

  it('derives a valid identifier for an anonymous default export starting with a digit', () => {
    const { result } = discover({
      '/q.ts': `export default createNamespace('2fa', { code: 'Code' });`,
      '/r.ts': `registerNamespace(() => import('./q'), {});`,
    });
    expect(result[0]?.source.exportName).toBe('ns2fa');
  });
});

describe('discoverFromProject: unsupported default loaders are skipped with a warning', () => {
  it.each([
    ['an async loader', `async () => (await import('./q')).q`, Q],
    ['a missing export', loader('gone.translation'), Q],
    ['a createTranslation export', loader('qDe'), Q],
    [
      'a plain-object export',
      loader('q.translation'),
      `export const q = { title: 'x' };`,
    ],
    [
      'a shorthand into a module with no default or translation export',
      `() => import('./q')`,
      `export const q = createNamespace('quote', { title: 'Quotes' });`,
    ],
    [
      'a shorthand into a default-exported object literal',
      `() => import('./q')`,
      `export default { title: 'x' };`,
    ],
    [
      'a namespace with a variable translation',
      loader('q.translation'),
      `const base = { title: 'x' };\nexport const q = createNamespace('quote', base);`,
    ],
    [
      'a namespace with a variable name',
      loader('q.translation'),
      `const NAME = 'quote';\nexport const q = createNamespace(NAME, { title: 'x' });`,
    ],
  ])('%s', (_, defaultLoader, module) => {
    const { result, warnings } = discover({
      '/q.ts': module,
      '/other.ts': OTHER,
      '/r.ts': `registerNamespace(${defaultLoader}, {});\n${VALID_OTHER}`,
    });
    expect(result.map((n) => n.namespace)).toEqual(['other']);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('discoverFromProject: locale entries that cannot be read', () => {
  const run = (map: string, module = Q) =>
    discover({
      '/q.ts': module,
      '/r.ts': `registerNamespace(${loader('q.translation')}, ${map});`,
    });

  it('keeps readable locales next to an async one, and records the skipped name', () => {
    const { result, warnings } = run(
      `{ de: async () => (await import('./q')).qDe, fr: ${loader('qFr')} }`,
    );
    expect(result[0]?.locales.map((l) => l.locale)).toEqual(['fr']);
    expect(result[0]?.skippedLocales).toEqual(['de']);
    expect(warnings.some((w) => w.includes('"de"'))).toBe(true);
  });

  it('keeps readable locales next to one pointing at a missing module', () => {
    const { result, warnings } = run(
      `{ de: ${loader('qDe', './missing')}, fr: ${loader('qFr')} }`,
    );
    expect(result[0]?.locales.map((l) => l.locale)).toEqual(['fr']);
    expect(result[0]?.skippedLocales).toEqual(['de']);
    expect(warnings.some((w) => w.includes('./missing'))).toBe(true);
  });

  it('warns on a spread and still reads the entries next to it', () => {
    const { result, warnings } = run(`{ ...more, de: ${loader('qDe')} }`);
    expect(result[0]?.locales.map((l) => l.locale)).toEqual(['de']);
    expect(result[0]?.hasLocaleSpread).toBe(true);
    expect(warnings.some((w) => w.includes('more'))).toBe(true);
  });

  it('warns on a shorthand entry and records it as skipped', () => {
    const { result, warnings } = run(`{ fr, de: ${loader('qDe')} }`);
    expect(result[0]?.locales.map((l) => l.locale)).toEqual(['de']);
    expect(result[0]?.skippedLocales).toEqual(['fr']);
    expect(warnings.some((w) => w.includes('"fr"'))).toBe(true);
  });

  it('warns on a createTranslation with a variable object and records it as skipped', () => {
    const { result, warnings } = run(
      `{ de: ${loader('qDe')} }`,
      `export const q = createNamespace('quote', { title: 'Quotes' });
const o = { title: 'Zitate' };
export const qDe = q.createTranslation('de', o);`,
    );
    expect(result[0]?.locales).toEqual([]);
    expect(result[0]?.skippedLocales).toEqual(['de']);
    expect(warnings.some((w) => w.includes('/q.ts'))).toBe(true);
  });

  it('leaves both fields off when every entry is read', () => {
    const { result, warnings } = run(`{ de: ${loader('qDe')} }`);
    expect(warnings).toEqual([]);
    expect(result[0]).not.toHaveProperty('skippedLocales');
    expect(result[0]).not.toHaveProperty('hasLocaleSpread');
  });
});
