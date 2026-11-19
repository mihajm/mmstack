import { Project } from 'ts-morph';
import {
  classifyUsage,
  keyLines,
  lintProject,
  type LintFinding,
  type LintRuleName,
} from './lint';

function withFiles(files: Record<string, string>): Project {
  const p = new Project({ useInMemoryFileSystem: true });
  for (const [name, content] of Object.entries(files))
    p.createSourceFile(name, content);
  return p;
}

const REG_A = `registerNamespace(() => import('./ns').then((m) => m.a.translation), {});`;

const lint = (p: Project, rules: LintRuleName[], ignoreCase?: boolean) =>
  lintProject(p, { rules, ignoreCase });

const keys = (findings: LintFinding[]) => findings.map((f) => f.key).sort();

describe('lint: default-exported namespace bound to a const', () => {
  const ns = `const a = createNamespace('a', {
  x: 'Save',
  // mmtranslate-disable-next-line duplicate
  y: 'Save',
});
export default a;`;

  it('maps key lines through the default-exported identifier', () => {
    const sf = withFiles({ '/ns.ts': ns }).getSourceFileOrThrow('/ns.ts');
    const lines = keyLines(sf, 'a', true);
    expect(lines.get('x')).toBe(2);
    expect(lines.get('y')).toBe(4);
  });

  it('honors disable-next-line and reports lines for that shape', () => {
    const p = withFiles({
      '/ns.ts': ns,
      '/reg.ts': `registerNamespace(() => import('./ns'), {});`,
    });
    expect(lint(p, ['duplicate']).findings).toEqual([]);
    const unused = lint(p, ['unused']).findings;
    expect(unused.map((f) => [f.key, f.line])).toEqual([
      ['x', 2],
      ['y', 4],
    ]);
  });

  it('maps key lines for an anonymous default export', () => {
    const sf = withFiles({
      '/ns.ts': `export default createNamespace('a', {\n  x: 'Save',\n});`,
    }).getSourceFileOrThrow('/ns.ts');
    expect(keyLines(sf, '', true).get('x')).toBe(2);
  });

  it('suppresses a duplicate inside an anonymous default export', () => {
    const p = withFiles({
      '/ns.ts': `export default createNamespace('a', {
  x: 'Save',
  // mmtranslate-disable-next-line duplicate
  y: 'Save',
});`,
      '/reg.ts': `registerNamespace(() => import('./ns'), {});`,
    });
    expect(lint(p, ['duplicate']).findings).toEqual([]);
  });
});

describe('classifyUsage: keys with $', () => {
  it.each([
    ['$count', 'x = t.$count;'],
    ['count$', 'x = t.count$;'],
    ['a.$b', 'x = t.a.$b;'],
  ])('%s is used by %s', (key, text) => {
    expect(classifyUsage(key, [text])).toBe('used');
  });

  it('a $-prefixed identifier is not usage of the bare key', () => {
    expect(classifyUsage('count', ['x = t.$count;'])).toBe('unused');
    expect(classifyUsage('count', ['x = t.count$;'])).toBe('unused');
  });

  it('computed access below a $ prefix is unknown', () => {
    expect(classifyUsage('$a.b', ['t.$a[k];'])).toBe('unknown');
  });
});

describe('classifyUsage: prefixes', () => {
  it('computed access on a deeper prefix is unknown', () => {
    expect(classifyUsage('detail.sub.save', ['t.detail.sub[k];'])).toBe(
      'unknown',
    );
  });

  it('a two-segment prefix passed whole without a leading dot is unknown', () => {
    expect(classifyUsage('detail.sub.save', ['render(detail.sub);'])).toBe(
      'unknown',
    );
  });

  it('a three-segment key with no matching text is unused', () => {
    expect(classifyUsage('a.b.c', ['x;'])).toBe('unused');
  });
});

describe('suppression comments', () => {
  const ns = (body: string) => withFiles({ '/ns.ts': body, '/reg.ts': REG_A });

  it('disable-next-line unused silences that key without warnings', () => {
    const report = lint(
      ns(`export const a = createNamespace('a', {
  // mmtranslate-disable-next-line unused
  x: 'X',
  y: 'Y',
});`),
      ['unused'],
    );
    expect(keys(report.findings)).toEqual(['y']);
    expect(report.warnings).toEqual([]);
  });

  it('a rule-scoped file disable of unused silences only unused', () => {
    const report = lint(
      ns(`// mmtranslate-disable unused
export const a = createNamespace('a', { x: 'Save', y: 'Save' });`),
      ['duplicate', 'unused'],
    );
    expect(report.findings.map((f) => f.rule)).toEqual([
      'duplicate',
      'duplicate',
    ]);
  });

  it('a marker text inside a string with a valid rule never suppresses', () => {
    const report = lint(
      ns(`export const a = createNamespace('a', {
  x: '// mmtranslate-disable-next-line duplicate please',
  y: 'Save',
  z: 'Save',
});`),
      ['duplicate'],
    );
    expect(keys(report.findings)).toEqual(['y', 'z']);
  });

  it('an ordinary comment is ignored', () => {
    const report = lint(
      ns(`// header comment
export const a = createNamespace('a', { x: 'X' });`),
      ['duplicate'],
    );
    expect(report).toEqual({ findings: [], warnings: [], unknownKeys: [] });
  });

  it('every disable-next-line in a file applies', () => {
    const report = lint(
      ns(`export const a = createNamespace('a', {
  x: 'Save',
  // mmtranslate-disable-next-line duplicate
  y: 'Save',
  p: 'Open',
  // mmtranslate-disable-next-line duplicate
  q: 'Open',
});`),
      ['duplicate'],
    );
    expect(report.findings).toEqual([]);
  });

  it('applies to the line below the comment only', () => {
    const report = lint(
      ns(`export const a = createNamespace('a', {
  x: 'Save',
  // mmtranslate-disable-next-line duplicate
  y: 'Save',
  z: 'Save',
});`),
      ['duplicate'],
    );
    expect(keys(report.findings)).toEqual(['x', 'z']);
  });

  it('works above a quoted key', () => {
    const p = ns(`export const a = createNamespace('a', {
  x: 'Save',
  // mmtranslate-disable-next-line duplicate
  'y-z': 'Save',
});`);
    expect(lint(p, ['duplicate']).findings).toEqual([]);
    expect(
      keyLines(p.getSourceFileOrThrow('/ns.ts'), 'a', false).get('y-z'),
    ).toBe(4);
  });
});

describe('duplicate rule', () => {
  it('empty and whitespace-only values are never duplicates', () => {
    const p = withFiles({
      '/ns.ts': `export const a = createNamespace('a', { x: '', y: '', z: '  ' });`,
      '/reg.ts': REG_A,
    });
    expect(lint(p, ['duplicate']).findings).toEqual([]);
  });

  it('compares case-sensitively unless ignoreCase is set', () => {
    const p = withFiles({
      '/ns.ts': `export const a = createNamespace('a', { x: 'Save', y: 'SAVE' });`,
      '/reg.ts': REG_A,
    });
    expect(lintProject(p, { rules: ['duplicate'] }).findings).toEqual([]);
    expect(lint(p, ['duplicate'], true).findings).toHaveLength(2);
  });
});

describe('unused rule: definition files never count as usage', () => {
  const NS = `export const a = createNamespace('a', { title: 'T', cancel: 'C' });
export const aDe = a.createTranslation('de', { title: 'Titel', cancel: 'Abbrechen' });`;

  it('ignores a locale module that repeats every key', () => {
    const p = withFiles({
      '/ns.ts': `export const a = createNamespace('a', { title: 'T', cancel: 'C' });`,
      '/de.ts': `export const aDe = a.createTranslation('de', { title: 'Titel', cancel: 'Abbrechen' });`,
      '/reg.ts': `registerNamespace(() => import('./ns').then((m) => m.a.translation), {
  de: () => import('./de').then((m) => m.aDe),
});`,
    });
    expect(keys(lint(p, ['unused']).findings)).toEqual(['cancel', 'title']);
  });

  it('ignores the registry file even when it mentions a key', () => {
    const p = withFiles({
      '/ns.ts': NS,
      '/reg.ts': `${REG_A}\nconst probe = t.cancel;`,
    });
    expect(keys(lint(p, ['unused']).findings)).toEqual(['cancel', 'title']);
  });
});
