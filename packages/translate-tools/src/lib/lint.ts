import { Node, ts, type Project, type SourceFile } from 'ts-morph';
import { buildProject, type ProjectOptions } from './commands';
import { discoverFromProject, type DiscoveredNamespace } from './discover';
import { leafEntries } from './nested';

export type LintRuleName = 'duplicate' | 'unused';
export const LINT_RULES: readonly LintRuleName[] = ['duplicate', 'unused'];

export type LintFinding = {
  rule: LintRuleName;
  namespace: string;
  /** Dotted key path within the namespace. */
  key: string;
  file: string;
  line?: number;
  message: string;
  /** Grouping id — for `duplicate`, the normalized value shared by the group. */
  group?: string;
};

export type LintReport = {
  findings: LintFinding[];
  /** Suppression-comment problems (unknown rule names, misplaced file-level disables). */
  warnings: string[];
  /** `unused`'s conservative bucket: dynamic/whole-subtree access made these unresolvable. */
  unknownKeys: { namespace: string; key: string }[];
};

// ---- suppression comments ----------------------------------------------------------------
//
// Two modes, same principle as eslint:
//  - file-wide:  a comment containing `mmtranslate-disable [rules]` BEFORE the first statement
//  - next-line:  `mmtranslate-disable-next-line [rules]` suppresses findings located on the
//                line directly below the comment
// No rule names = all rules. Comments are found with the TypeScript scanner, so a marker
// inside a translation STRING can never suppress anything.

export type SuppressionIndex = {
  isSuppressed(file: string, line: number | undefined, rule: LintRuleName): boolean;
  warnings: string[];
};

const MARKER = /mmtranslate-disable(-next-line)?\b([^\n*]*)/;

export function buildSuppressions(files: SourceFile[]): SuppressionIndex {
  const fileWide = new Map<string, Set<string>>();
  const nextLine = new Map<string, Map<number, Set<string>>>();
  const warnings: string[] = [];

  const parseRules = (raw: string, where: string): Set<string> => {
    const names = raw.split(/[,\s]+/).filter(Boolean);
    if (!names.length) return new Set(['*']);
    const out = new Set<string>();
    for (const name of names) {
      if ((LINT_RULES as readonly string[]).includes(name)) out.add(name);
      else
        warnings.push(
          `${where}: unknown rule "${name}" in suppression comment (known: ${LINT_RULES.join(', ')}) — ignored`,
        );
    }
    return out;
  };

  for (const sf of files) {
    const filePath = sf.getFilePath();
    const text = sf.getFullText();
    const firstStatementStart = sf.getStatements()[0]?.getStart() ?? text.length;

    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, undefined, text);
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        const comment = scanner.getTokenText();
        const match = MARKER.exec(comment);
        if (match) {
          const start = scanner.getTokenStart();
          const line = sf.getLineAndColumnAtPos(start).line;
          const where = `${filePath}:${line}`;
          const rules = parseRules(match[2] ?? '', where);
          if (match[1]) {
            // -next-line
            let perLine = nextLine.get(filePath);
            if (!perLine) nextLine.set(filePath, (perLine = new Map()));
            const endLine = sf.getLineAndColumnAtPos(start + comment.length).line;
            const target = endLine + 1;
            const set = perLine.get(target) ?? new Set<string>();
            for (const r of rules) set.add(r);
            perLine.set(target, set);
          } else if (start < firstStatementStart) {
            const set = fileWide.get(filePath) ?? new Set<string>();
            for (const r of rules) set.add(r);
            fileWide.set(filePath, set);
          } else {
            warnings.push(
              `${where}: "mmtranslate-disable" only works before the first statement (file-wide) — use "mmtranslate-disable-next-line" here`,
            );
          }
        }
      }
      token = scanner.scan();
    }
  }

  const has = (set: Set<string> | undefined, rule: LintRuleName) =>
    !!set && (set.has('*') || set.has(rule));

  return {
    warnings,
    isSuppressed: (file, line, rule) =>
      has(fileWide.get(file), rule) ||
      (line !== undefined && has(nextLine.get(file)?.get(line), rule)),
  };
}

// ---- key locations -------------------------------------------------------------------------

/**
 * Dotted key → line of its definition in the module's translation object literal (the object
 * argument of `createNamespace`/`createMergedNamespace`/`createTranslation`). Keys the walk
 * can't attribute simply have no line — file-wide suppression still covers them.
 */
export function keyLines(
  sf: SourceFile,
  exportName: string,
  isDefaultExport: boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  const init = isDefaultExport
    ? sf.getExportAssignment((a) => !a.isExportEquals())?.getExpression()
    : sf.getVariableDeclaration(exportName)?.getInitializer();
  if (!init || !Node.isCallExpression(init)) return out;
  const obj = init.getArguments().find(Node.isObjectLiteralExpression);
  if (!obj) return out;

  const walk = (o: Node, prefix: string): void => {
    if (!Node.isObjectLiteralExpression(o)) return;
    for (const prop of o.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const nameNode = prop.getNameNode();
      const key =
        Node.isStringLiteral(nameNode) ||
        Node.isNoSubstitutionTemplateLiteral(nameNode)
          ? nameNode.getLiteralText()
          : Node.isIdentifier(nameNode)
            ? nameNode.getText()
            : null;
      if (key === null) continue;
      const full = prefix ? `${prefix}.${key}` : key;
      const value = prop.getInitializer();
      if (value && Node.isObjectLiteralExpression(value)) walk(value, full);
      else out.set(full, prop.getStartLineNumber());
    }
  };
  walk(obj, '');
  return out;
}

// ---- rule: duplicate -----------------------------------------------------------------------

export function normalizeValue(value: string, ignoreCase: boolean): string {
  const collapsed = value.trim().replace(/\s+/g, ' ');
  return ignoreCase ? collapsed.toLowerCase() : collapsed;
}

type SourceEntry = {
  namespace: string;
  key: string;
  value: string;
  file: string;
  line?: number;
};

/** Every leaf of every namespace's SOURCE translation, with its definition location. */
function sourceEntries(
  namespaces: DiscoveredNamespace[],
  project: Project,
): SourceEntry[] {
  const out: SourceEntry[] = [];
  for (const ns of namespaces) {
    const sf = project.getSourceFile(ns.source.moduleFilePath);
    const lines = sf
      ? keyLines(sf, ns.source.exportName, ns.source.isDefaultExport)
      : new Map<string, number>();
    for (const [key, value] of leafEntries(ns.source.translation))
      out.push({
        namespace: ns.namespace,
        key,
        value,
        file: ns.source.moduleFilePath,
        line: lines.get(key),
      });
  }
  return out;
}

/**
 * Same normalized source-locale value under different keys — within and across namespaces.
 * Suppressed keys leave their group before the ≥2 check, so suppressing all-but-one member
 * silences the group.
 */
export function findDuplicates(
  entries: SourceEntry[],
  suppressions: SuppressionIndex,
  ignoreCase: boolean,
): LintFinding[] {
  const groups = new Map<string, SourceEntry[]>();
  for (const entry of entries) {
    if (suppressions.isSuppressed(entry.file, entry.line, 'duplicate')) continue;
    const norm = normalizeValue(entry.value, ignoreCase);
    if (!norm) continue; // empty values are a different rule's business
    const group = groups.get(norm) ?? [];
    group.push(entry);
    groups.set(norm, group);
  }

  const findings: LintFinding[] = [];
  for (const [norm, members] of groups) {
    if (members.length < 2) continue;
    for (const m of members)
      findings.push({
        rule: 'duplicate',
        namespace: m.namespace,
        key: m.key,
        file: m.file,
        line: m.line,
        group: norm,
        message: `duplicate value "${members[0].value}" (${members.length} keys share it)`,
      });
  }
  return findings;
}

// ---- rule: unused --------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `a.b.c` as a whitespace-tolerant member chain — also matches the dotted string `'a.b.c'`. */
function chainRe(segments: string[]): RegExp {
  return new RegExp(`\\b${segments.map(escapeRe).join('\\s*\\.\\s*')}\\b`);
}

export type UsageVerdict = 'used' | 'unknown' | 'unused';

/**
 * Conservative usage classification of one key against app sources:
 * - any `a.b.c` chain (or `'a.b.c'` string) match → `used`;
 * - a PREFIX of the key followed by a computed access (`a.b[`), or a prefix used as a bare
 *   expression (subtree passed around whole — for a single-segment prefix only when reached
 *   via a member access, `t.detail`, so an unrelated `detail` identifier doesn't count),
 *   → `unknown` — dynamic access means "not provably unused";
 * - otherwise `unused`.
 * Both error directions are deliberately QUIET: a coincidental identifier chain counts as
 * used, dynamic access counts as unknown — a linter people trust under-reports.
 */
export function classifyUsage(key: string, appTexts: string[]): UsageVerdict {
  const segments = key.split('.');
  const used = chainRe(segments);
  if (appTexts.some((t) => used.test(t))) return 'used';

  for (let i = segments.length - 1; i >= 1; i--) {
    const prefix = segments.slice(0, i);
    const chain = prefix.map(escapeRe).join('\\s*\\.\\s*');
    const computed = new RegExp(`\\b${chain}\\s*\\[`);
    if (appTexts.some((t) => computed.test(t))) return 'unknown';
    // subtree passed as a value: the prefix chain NOT followed by a deeper member access;
    // a lone identifier needs the leading `.` as evidence it's this tree at all
    const bare =
      prefix.length >= 2
        ? new RegExp(`\\b${chain}\\b(?!\\s*[.[\\w])`)
        : new RegExp(`\\.\\s*${chain}\\b(?!\\s*[.[\\w])`);
    if (appTexts.some((t) => bare.test(t))) return 'unknown';
  }
  return 'unused';
}

// ---- runner --------------------------------------------------------------------------------

export type LintRunOptions = {
  rules: LintRuleName[];
  sourceLocale?: string;
  ignoreCase?: boolean;
  onWarn?: (message: string) => void;
};

export type LintOptions = ProjectOptions &
  LintRunOptions & {
    /** App-source globs for the `unused` scan. Defaults to `srcGlobs`. */
    appGlobs?: string[];
  };

export function runLint(opts: LintOptions): LintReport {
  return lintProject(
    buildProject(opts),
    opts,
    opts.appGlobs
      ? buildProject({ cwd: opts.cwd, srcGlobs: opts.appGlobs })
      : undefined,
  );
}

/** The project-level runner (also the test seam — `runLint` is its fs-glob wrapper). */
export function lintProject(
  project: Project,
  opts: LintRunOptions,
  appProject?: Project,
): LintReport {
  const namespaces = discoverFromProject(project, {
    sourceLocale: opts.sourceLocale ?? 'en',
    onWarn: opts.onWarn,
  });

  const definitionFiles = new Set<string>();
  for (const ns of namespaces) {
    definitionFiles.add(ns.registryFilePath);
    definitionFiles.add(ns.source.moduleFilePath);
    for (const locale of ns.locales) definitionFiles.add(locale.moduleFilePath);
  }

  const suppressionFiles = namespaces
    .map((ns) => project.getSourceFile(ns.source.moduleFilePath))
    .filter((sf): sf is SourceFile => !!sf);
  const suppressions = buildSuppressions(suppressionFiles);

  const entries = sourceEntries(namespaces, project);
  const findings: LintFinding[] = [];
  const unknownKeys: LintReport['unknownKeys'] = [];

  if (opts.rules.includes('duplicate'))
    findings.push(
      ...findDuplicates(entries, suppressions, opts.ignoreCase ?? false),
    );

  if (opts.rules.includes('unused')) {
    // definition/locale/registry files must not count as usage — a key always "appears"
    // where it's defined
    const appTexts = (appProject ?? project)
      .getSourceFiles()
      .filter((sf) => !definitionFiles.has(sf.getFilePath()))
      .map((sf) => sf.getFullText());

    for (const entry of entries) {
      if (suppressions.isSuppressed(entry.file, entry.line, 'unused')) continue;
      const verdict = classifyUsage(entry.key, appTexts);
      if (verdict === 'unknown')
        unknownKeys.push({ namespace: entry.namespace, key: entry.key });
      else if (verdict === 'unused')
        findings.push({
          rule: 'unused',
          namespace: entry.namespace,
          key: entry.key,
          file: entry.file,
          line: entry.line,
          message: 'no usage found in the scanned app sources',
        });
    }
  }

  return { findings, warnings: suppressions.warnings, unknownKeys };
}

// ---- report formatting ---------------------------------------------------------------------

export function formatLintReport(report: LintReport): string {
  const lines: string[] = [];
  const loc = (f: LintFinding) => `${f.file}${f.line ? `:${f.line}` : ''}`;

  const dupes = report.findings.filter((f) => f.rule === 'duplicate');
  const byGroup = new Map<string, LintFinding[]>();
  for (const f of dupes) {
    const g = byGroup.get(f.group ?? '') ?? [];
    g.push(f);
    byGroup.set(f.group ?? '', g);
  }
  for (const members of byGroup.values()) {
    lines.push(`✗ duplicate (${members.length}): ${members[0].message}`);
    for (const m of members) lines.push(`   ${m.namespace}:${m.key} (${loc(m)})`);
  }

  for (const f of report.findings.filter((f) => f.rule === 'unused'))
    lines.push(`✗ unused ${f.namespace}:${f.key} (${loc(f)})`);

  for (const w of report.warnings) lines.push(`⚠ ${w}`);
  if (report.unknownKeys.length)
    lines.push(
      `ℹ ${report.unknownKeys.length} key(s) accessed dynamically — skipped by \`unused\` (unknown, not unused)`,
    );

  lines.push(
    report.findings.length
      ? `${report.findings.length} finding(s).`
      : 'No findings.',
  );
  return lines.join('\n');
}
