import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatLintReport, runLint, type LintFinding } from './lint';

const dup = (key: string, line?: number): LintFinding => ({
  rule: 'duplicate',
  namespace: 'quote',
  key,
  file: '/ns.ts',
  line,
  group: 'Save',
  message: 'duplicate value "Save" (2 keys share it)',
});
const unused = (key: string): LintFinding => ({
  rule: 'unused',
  namespace: 'common',
  key,
  file: '/ns.ts',
  line: 3,
  message: 'no usage found in the scanned app sources',
});
const report = (
  findings: LintFinding[],
  extra: { warnings?: string[]; unknown?: number } = {},
) =>
  formatLintReport({
    findings,
    warnings: extra.warnings ?? [],
    unknownKeys: Array.from({ length: extra.unknown ?? 0 }, (_, i) => ({
      namespace: 'n',
      key: `k${i}`,
    })),
  });

describe('formatLintReport', () => {
  it('is exactly "No findings." for an empty report', () => {
    expect(report([])).toBe('No findings.');
  });

  it('lists every member of a duplicate group with its location, and no unused section', () => {
    const lines = report([dup('save', 6), dup('confirm', 7)]).split('\n');
    expect(lines).toContain('   quote:save (/ns.ts:6)');
    expect(lines).toContain('   quote:confirm (/ns.ts:7)');
    expect(lines.some((l) => l.startsWith('✗ unused'))).toBe(false);
    expect(lines).toHaveLength(4);
  });

  it('prints a finding without a line as the bare file', () => {
    expect(report([dup('save'), dup('confirm')])).toContain(
      'quote:save (/ns.ts)\n',
    );
  });

  it('lists unused findings with no duplicate section', () => {
    const lines = report([unused('cancel'), unused('save')]).split('\n');
    expect(lines).toEqual([
      '✗ unused common:cancel (/ns.ts:3)',
      '✗ unused common:save (/ns.ts:3)',
      '2 finding(s).',
    ]);
  });

  it('prints suppression warnings', () => {
    expect(report([], { warnings: ['bad marker'] })).toContain('bad marker');
  });

  it('counts dynamically accessed keys only when there are some', () => {
    expect(report([], { unknown: 2 })).toContain('2 key(s)');
    expect(report([])).not.toContain('key(s)');
  });
});

describe('runLint (globs on disk)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmtranslate-lint-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'app'));
    fs.writeFileSync(
      path.join(dir, 'src/ns.ts'),
      `export const a = createNamespace('a', { x: 'X', y: 'Y' });`,
    );
    fs.writeFileSync(
      path.join(dir, 'src/reg.ts'),
      `registerNamespace(() => import('./ns').then((m) => m.a.translation), {});`,
    );
    fs.writeFileSync(path.join(dir, 'src/use.ts'), `t.x; t.y;`);
    fs.writeFileSync(path.join(dir, 'app/use.ts'), `t.x;`);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('scans the source globs for usage by default', () => {
    const r = runLint({
      cwd: dir,
      srcGlobs: ['src/**/*.ts'],
      rules: ['unused'],
    });
    expect(r.findings).toEqual([]);
  });

  it('scans only the app globs when given', () => {
    const r = runLint({
      cwd: dir,
      srcGlobs: ['src/**/*.ts'],
      appGlobs: ['app/**/*.ts'],
      rules: ['unused'],
    });
    expect(r.findings.map((f) => f.key)).toEqual(['y']);
  });

  it('forwards discovery warnings', () => {
    fs.appendFileSync(
      path.join(dir, 'src/reg.ts'),
      `\nregisterNamespace(() => import('./missing').then((m) => m.b.translation), {});`,
    );
    const warnings: string[] = [];
    runLint({
      cwd: dir,
      srcGlobs: ['src/**/*.ts'],
      rules: ['unused'],
      onWarn: (m) => warnings.push(m),
    });
    expect(warnings.some((w) => w.includes('./missing'))).toBe(true);
  });
});
