import { Project } from 'ts-morph';
import {
  buildSuppressions,
  classifyUsage,
  formatLintReport,
  keyLines,
  lintProject,
  normalizeValue,
  type LintFinding,
} from './lint';

/** In-memory project mirroring the discovery fixtures: two namespaces + a registry. */
function project(files?: Record<string, string>): Project {
  const p = new Project({ useInMemoryFileSystem: true });
  p.createSourceFile(
    '/namespaces.ts',
    `export const common = createNamespace('common', {
       save: 'Save',
       cancel: 'Cancel',
     });
     export const quote = common.createMergedNamespace('quote', {
       save: 'Save',
       detail: { authorLabel: 'Author', save: '  Save ' },
     });`,
  );
  p.createSourceFile(
    '/registry.ts',
    `registerNamespace(() => import('./namespaces').then((m) => m.common.translation), {});
     registerNamespace(() => import('./namespaces').then((m) => m.quote.translation), {});`,
  );
  for (const [path, content] of Object.entries(files ?? {}))
    p.createSourceFile(path, content);
  return p;
}

const lint = (
  p: Project,
  rules: ('duplicate' | 'unused')[],
  ignoreCase = false,
) => lintProject(p, { rules, ignoreCase });

const keyOf = (f: LintFinding) => `${f.namespace}:${f.key}`;

describe('normalizeValue', () => {
  it('trims and collapses internal whitespace; case only under ignoreCase', () => {
    expect(normalizeValue('  Save \n now ', false)).toBe('Save now');
    expect(normalizeValue('SAVE', false)).toBe('SAVE');
    expect(normalizeValue('SAVE', true)).toBe('save');
  });
});

describe('keyLines', () => {
  it('maps dotted keys to their definition lines (nested included)', () => {
    const sf = project().getSourceFileOrThrow('/namespaces.ts');
    const lines = keyLines(sf, 'quote', false);
    expect(lines.get('save')).toBe(6);
    expect(lines.get('detail.authorLabel')).toBe(7);
    expect(lines.get('detail.save')).toBe(7);
  });
});

describe('dupes', () => {
  it('groups duplicates within AND across namespaces, normalized', () => {
    const report = lint(project(), ['duplicate']);
    // 'Save' appears as common:save, quote:save, and quote:detail.save ('  Save ' normalizes)
    const group = report.findings.filter((f) => f.group === 'Save');
    expect(group.map(keyOf).sort()).toEqual([
      'common:save',
      'quote:detail.save',
      'quote:save',
    ]);
    // 'Cancel' and 'Author' are singletons — never reported
    expect(report.findings.every((f) => f.group === 'Save')).toBe(true);
  });

  it('--ignore-case folds case variants into one group', () => {
    const p = new Project({ useInMemoryFileSystem: true });
    p.createSourceFile(
      '/ns.ts',
      `export const a = createNamespace('a', { x: 'Save', y: 'SAVE' });`,
    );
    p.createSourceFile(
      '/reg.ts',
      `registerNamespace(() => import('./ns').then((m) => m.a.translation), {});`,
    );
    expect(lint(p, ['duplicate']).findings).toEqual([]); // case differs
    expect(lint(p, ['duplicate'], true).findings.length).toBe(2);
  });
});

describe('suppressions', () => {
  it('disable-next-line removes the key; a group shrunk below 2 vanishes', () => {
    const p = new Project({ useInMemoryFileSystem: true });
    p.createSourceFile(
      '/ns.ts',
      `export const a = createNamespace('a', {
         x: 'Save',
         // mmtranslate-disable-next-line duplicate
         y: 'Save',
       });`,
    );
    p.createSourceFile(
      '/reg.ts',
      `registerNamespace(() => import('./ns').then((m) => m.a.translation), {});`,
    );
    expect(lint(p, ['duplicate']).findings).toEqual([]); // only x remains → group of 1
  });

  it('a file-top disable silences the whole file (all rules when unnamed)', () => {
    const p = new Project({ useInMemoryFileSystem: true });
    p.createSourceFile(
      '/ns.ts',
      `/* mmtranslate-disable */
       export const a = createNamespace('a', { x: 'Save', y: 'Save' });`,
    );
    p.createSourceFile(
      '/reg.ts',
      `registerNamespace(() => import('./ns').then((m) => m.a.translation), {});`,
    );
    const report = lint(p, ['duplicate', 'unused']);
    expect(report.findings).toEqual([]);
  });

  it('rule-scoped file disable only silences that rule', () => {
    const p = new Project({ useInMemoryFileSystem: true });
    p.createSourceFile(
      '/ns.ts',
      `// mmtranslate-disable duplicate
       export const a = createNamespace('a', { x: 'Save', y: 'Save' });`,
    );
    p.createSourceFile(
      '/reg.ts',
      `registerNamespace(() => import('./ns').then((m) => m.a.translation), {});`,
    );
    const report = lint(p, ['duplicate', 'unused']);
    expect(report.findings.filter((f) => f.rule === 'duplicate')).toEqual([]);
    expect(report.findings.filter((f) => f.rule === 'unused').length).toBe(2); // still on
  });

  it('warns on unknown rule names and on a mid-file bare disable', () => {
    const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile(
      '/x.ts',
      `// mmtranslate-disable-next-line duplicat
       const a = 1;
       // mmtranslate-disable
       const b = 2;`,
    );
    const idx = buildSuppressions([sf]);
    expect(idx.warnings.length).toBe(2);
    expect(idx.warnings[0]).toContain('unknown rule "duplicat"');
    expect(idx.warnings[1]).toContain('only works before the first statement');
  });

  it('a marker inside a translation STRING never suppresses (scanner, not regex)', () => {
    const p = new Project({ useInMemoryFileSystem: true });
    p.createSourceFile(
      '/ns.ts',
      `export const a = createNamespace('a', {
         x: 'mmtranslate-disable-next-line duplicate',
         y: 'Save',
         z: 'Save',
       });`,
    );
    p.createSourceFile(
      '/reg.ts',
      `registerNamespace(() => import('./ns').then((m) => m.a.translation), {});`,
    );
    expect(lint(p, ['duplicate']).findings.length).toBe(2); // y+z still reported
  });
});

describe('classifyUsage', () => {
  it('member chains and dotted strings count as used', () => {
    expect(classifyUsage('detail.save', ['btn.label = t.detail.save;'])).toBe(
      'used',
    );
    expect(classifyUsage('detail.save', [`translate('detail.save')`])).toBe(
      'used',
    );
    expect(
      classifyUsage('detail.save', ['const x = t\n  .detail\n  .save;']),
    ).toBe('used'); // whitespace-tolerant
  });

  it('computed access on a prefix → unknown, not unused', () => {
    expect(classifyUsage('detail.save', ['const m = t.detail[key];'])).toBe(
      'unknown',
    );
    expect(classifyUsage('detail.save', ['const m = detail[key];'])).toBe(
      'unknown',
    );
  });

  it('a ≥2-segment prefix passed around whole → unknown', () => {
    expect(
      classifyUsage('detail.save', ['render(t.detail);']), // subtree as a value
    ).toBe('unknown');
  });

  it('nothing matching → unused (single identifiers alone do not rescue)', () => {
    expect(classifyUsage('detail.save', ['const detail = 1;'])).toBe('unused');
    expect(classifyUsage('detail.save', [])).toBe('unused');
  });
});

describe('unused (end to end over a project)', () => {
  it('definition/registry files never count as usage; app files do', () => {
    const withApp = project({
      '/app.ts': `console.log(t.save); console.log(q.detail.authorLabel);`,
    });
    const report = lint(withApp, ['unused']);
    const unused = report.findings.map(keyOf).sort();
    // common:save + quote:save are matched by `t.save`; detail.authorLabel by the chain;
    // cancel + detail.save have no usage anywhere
    expect(unused).toEqual(['common:cancel', 'quote:detail.save']);
  });

  it('with NO app usage at all, every key is unused (definitions excluded)', () => {
    const report = lint(project(), ['unused']);
    expect(report.findings.length).toBe(5);
  });

  it('dynamic access floats keys into unknownKeys instead of findings', () => {
    const withApp = project({
      '/app.ts': `for (const k of keys) console.log(t.detail[k]); t.save; t.cancel;`,
    });
    const report = lint(withApp, ['unused']);
    expect(report.findings.map(keyOf)).toEqual([]); // nothing confidently unused
    expect(report.unknownKeys.map((u) => `${u.namespace}:${u.key}`).sort()).toEqual(
      ['quote:detail.authorLabel', 'quote:detail.save'],
    );
  });
});

describe('lint (merged) + report', () => {
  it('runs all rules in one pass and formats a grouped human report', () => {
    const withApp = project({ '/app.ts': `t.detail.authorLabel;` });
    const report = lint(withApp, ['duplicate', 'unused']);
    expect(report.findings.some((f) => f.rule === 'duplicate')).toBe(true);
    expect(report.findings.some((f) => f.rule === 'unused')).toBe(true);

    const text = formatLintReport(report);
    expect(text).toContain('✗ duplicate (3)');
    expect(text).toContain('common:save (/namespaces.ts:2)');
    expect(text).toContain('✗ unused common:cancel');
    expect(text).toMatch(/\d+ finding\(s\)\./);
  });

  it('reports "No findings." when clean', () => {
    const p = new Project({ useInMemoryFileSystem: true });
    p.createSourceFile(
      '/ns.ts',
      `export const a = createNamespace('a', { x: 'Hello' });`,
    );
    p.createSourceFile(
      '/reg.ts',
      `registerNamespace(() => import('./ns').then((m) => m.a.translation), {});`,
    );
    p.createSourceFile('/app.ts', `t.x;`);
    const report = lint(p, ['duplicate', 'unused']);
    expect(report.findings).toEqual([]);
    expect(formatLintReport(report)).toContain('No findings.');
  });
});
