#!/usr/bin/env node
import * as path from 'node:path';
import { flag, multiFlag } from './lib/args';
import {
  runExport,
  runGenerateManifest,
  runImport,
} from './lib/commands';

const USAGE = `Usage: mmtranslate <command> [options]

Commands:
  export              Write nested JSON per namespace per locale (source + targets).
  import              Read translated JSON back into TypeScript createTranslation files,
                      registering any new locales.
  generate-manifest   Write a config listing the discovered namespaces/registries.

Options:
  --src <glob>        Source glob to scan (repeatable). Default: src/**/*.ts
  --out <dir|file>    Output dir (export) or manifest file (generate-manifest).
  --in <dir>          Input dir of translated JSON (import).
  --source-locale <l> Locale label for the default/source translation. Default: en
                      (import falls back to the value recorded at export time).
  --force             import: overwrite an existing file when adding a new locale.
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

  console.error(USAGE);
  process.exitCode = command ? 1 : 0;
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
