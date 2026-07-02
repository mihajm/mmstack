#!/usr/bin/env node
import * as path from 'node:path';
import { flag, multiFlag } from './lib/args';
import {
  runExport,
  runGenerateManifest,
  runImport,
} from './lib/commands';
import {
  formatLintReport,
  runLint,
  type LintRuleName,
} from './lib/lint';

const USAGE = `Usage: mmtranslate <command> [options]

Commands:
  export              Write nested JSON per namespace per locale (source + targets).
  import              Read translated JSON back into TypeScript createTranslation files,
                      registering any new locales.
  generate-manifest   Write a config listing the discovered namespaces/registries.
  dupes               Report duplicate translations (same normalized source value under
                      different keys, within and across namespaces).
  unused              Report keys no scanned app source references (dynamic access is
                      conservatively skipped as "unknown, not unused").
  lint                Run all rules in one discovery pass; non-zero exit on findings.

Options:
  --src <glob>        Source glob to scan (repeatable). Default: src/**/*.ts
  --out <dir|file>    Output dir (export) or manifest file (generate-manifest).
  --in <dir>          Input dir of translated JSON (import).
  --source-locale <l> Locale label for the default/source translation. Default: en
                      (import falls back to the value recorded at export time).
  --force             import: overwrite an existing file when adding a new locale.
  --ignore-case       dupes/lint: compare values case-insensitively.
  --app-src <glob>    unused/lint: app-source glob for the usage scan (repeatable).
                      Default: the --src globs.
  --report json       dupes/unused/lint: machine-readable output.

Suppressing lint findings (rules: duplicate, unused; no names = all):
  /* mmtranslate-disable duplicate */            before the first statement: whole file
  // mmtranslate-disable-next-line duplicate     the line below the comment
`;

function main(): void {
  const [, , command, ...rest] = process.argv;
  const cwd = process.cwd();
  const srcGlobsArg = multiFlag(rest, 'src');
  const srcGlobs = srcGlobsArg.length ? srcGlobsArg : ['src/**/*.ts'];
  const sourceLocale = flag(rest, 'source-locale');

  if (command === 'export') {
    const outDir = path.resolve(cwd, flag(rest, 'out') ?? 'translations');
    const files = runExport({ cwd, srcGlobs, outDir, sourceLocale });
    console.log(`Exported ${files.length} file(s) to ${outDir}`);
    return;
  }

  if (command === 'import') {
    const inDir = path.resolve(cwd, flag(rest, 'in') ?? 'translations');
    const force = rest.includes('--force');
    const report = runImport({ cwd, srcGlobs, inDir, sourceLocale, force });
    for (const { file, reason } of report.skipped)
      console.warn(`⚠ skipped ${file}: ${reason}`);
    for (const { file, issues } of report.rejected) {
      console.error(`✗ ${file}`);
      for (const issue of issues) console.error(`   ${issue.key}: ${issue.message}`);
    }
    console.log(`Imported ${report.applied} locale file(s).`);
    if (report.rejected.length) process.exitCode = 1;
    return;
  }

  if (command === 'generate-manifest') {
    const outFile = path.resolve(cwd, flag(rest, 'out') ?? 'mmtranslate.config.ts');
    runGenerateManifest({ cwd, srcGlobs, outFile, sourceLocale });
    console.log(`Wrote manifest to ${outFile}`);
    return;
  }

  const LINT_COMMANDS: Record<string, LintRuleName[]> = {
    dupes: ['duplicate'],
    unused: ['unused'],
    lint: ['duplicate', 'unused'],
  };
  const rules = LINT_COMMANDS[command ?? ''];
  if (rules) {
    const appSrc = multiFlag(rest, 'app-src');
    const report = runLint({
      cwd,
      srcGlobs,
      rules,
      sourceLocale,
      ignoreCase: rest.includes('--ignore-case'),
      appGlobs: appSrc.length ? appSrc : undefined,
      onWarn: (message) => console.warn(`⚠ ${message}`),
    });
    if (flag(rest, 'report') === 'json')
      console.log(JSON.stringify(report, null, 2));
    else console.log(formatLintReport(report));
    if (report.findings.length) process.exitCode = 1;
    return;
  }

  console.error(USAGE);
  process.exitCode = command ? 1 : 0;
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
