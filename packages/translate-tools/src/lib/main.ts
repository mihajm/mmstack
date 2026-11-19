import * as path from 'node:path';
import { flag, multiFlag } from './args';
import { runExport, runGenerateManifest, runImport } from './commands';
import { loadConfig } from './config';
import { formatLintReport, runLint, type LintRuleName } from './lint';

export const USAGE = `Usage: mmtranslate <command> [options]

Commands:
  export              Write nested JSON per namespace per locale (source + targets).
  import              Read translated JSON back into TypeScript createTranslation files,
                      registering any new locales.
  generate-manifest   Write mmtranslate.config.ts (globs, source locale, namespaces);
                      the other commands read it as their defaults.
  dupes               Report duplicate translations (same normalized source value under
                      different keys, within and across namespaces).
  unused              Report keys no scanned app source references (dynamic access is
                      conservatively skipped as "unknown, not unused").
  lint                Run all rules in one discovery pass; non-zero exit on findings.

Options:
  --src <glob>        Source glob to scan (repeatable). Default: the config's src, else
                      src/**/*.ts
  --out <dir|file>    Output dir (export) or manifest file (generate-manifest).
  --in <dir>          Input dir of translated JSON (import).
  --source-locale <l> Locale label for the default/source translation. Default: the
                      config's sourceLocale, else en (import falls back to the value
                      recorded at export time).
  --config <file>     Config file to read. Default: mmtranslate.config.ts if present.
  --force             import: overwrite an existing file when adding a new locale.
  --ignore-case       dupes/lint: compare values case-insensitively.
  --app-src <glob>    unused/lint: app-source glob for the usage scan (repeatable).
                      Default: the --src globs.
  --report json       dupes/unused/lint: machine-readable output.

Suppressing lint findings (rules: duplicate, unused; no names = all):
  /* mmtranslate-disable duplicate */            before the first statement: whole file
  // mmtranslate-disable-next-line duplicate     the line below the comment
`;

const LINT_COMMANDS = new Map<string, LintRuleName[]>([
  ['dupes', ['duplicate']],
  ['unused', ['unused']],
  ['lint', ['duplicate', 'unused']],
]);

/** Run one `mmtranslate` invocation (`argv` without the node and script entries) and return its
 * exit code. Output goes to the console. */
export function main(argv: readonly string[], cwd: string): number {
  try {
    return run([...argv], cwd);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

function run(argv: string[], cwd: string): number {
  const [command, ...rest] = argv;
  const loaded = loadConfig(cwd, flag(rest, 'config'));
  const config = loaded?.config ?? {};
  const srcGlobsArg = multiFlag(rest, 'src');
  const srcGlobs = srcGlobsArg.length
    ? srcGlobsArg
    : (config.src ?? ['src/**/*.ts']);
  const sourceLocale = flag(rest, 'source-locale') ?? config.sourceLocale;
  const namespaces = config.namespaces;

  if (command === 'export') {
    const outDir = path.resolve(cwd, flag(rest, 'out') ?? 'translations');
    const files = runExport({
      cwd,
      srcGlobs,
      outDir,
      sourceLocale,
      namespaces,
    });
    console.log(`Exported ${files.length} file(s) to ${outDir}`);
    return 0;
  }

  if (command === 'import') {
    const inDir = path.resolve(cwd, flag(rest, 'in') ?? 'translations');
    const force = rest.includes('--force');
    const report = runImport({
      cwd,
      srcGlobs,
      inDir,
      sourceLocale,
      force,
      namespaces,
    });
    for (const { file, reason } of report.skipped)
      console.warn(`⚠ skipped ${file}: ${reason}`);
    for (const { file, issues } of report.rejected) {
      console.error(`✗ ${file}`);
      for (const issue of issues)
        console.error(`   ${issue.key}: ${issue.message}`);
    }
    console.log(`Imported ${report.applied} locale file(s).`);
    return report.rejected.length ? 1 : 0;
  }

  if (command === 'generate-manifest') {
    const outFile = path.resolve(
      cwd,
      flag(rest, 'out') ?? 'mmtranslate.config.ts',
    );
    runGenerateManifest({ cwd, srcGlobs, outFile, sourceLocale });
    console.log(`Wrote manifest to ${outFile}`);
    return 0;
  }

  const rules = command === undefined ? undefined : LINT_COMMANDS.get(command);
  if (rules) {
    const appSrc = multiFlag(rest, 'app-src');
    const report = runLint({
      cwd,
      srcGlobs,
      rules,
      sourceLocale,
      namespaces,
      ignoreCase: rest.includes('--ignore-case'),
      appGlobs: appSrc.length ? appSrc : undefined,
      onWarn: (message) => console.warn(`⚠ ${message}`),
    });
    if (flag(rest, 'report') === 'json')
      console.log(JSON.stringify(report, null, 2));
    else console.log(formatLintReport(report));
    return report.findings.length ? 1 : 0;
  }

  console.error(USAGE);
  return command ? 1 : 0;
}
