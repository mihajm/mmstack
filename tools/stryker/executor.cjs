// @ts-check
// nx executors `mutate` and `mutate-report`: run Stryker for one project with tools/stryker/stryker.config.mjs,
// from the workspace root, using the binary by path.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * @typedef {{
 *   runner?: 'angular' | 'vitest';
 *   exclude?: string[];
 *   tier?: 'all' | 'logic' | 'angular';
 *   run?: string;
 *   mutate?: string[];
 *   concurrency?: number;
 *   dryRunOnly?: boolean;
 *   incremental?: boolean;
 *   logLevel?: 'off' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
 *   listFiles?: boolean;
 * }} MutateOptions
 */

const load = (/** @type {string} */ file) =>
  import(pathToFileURL(path.join(__dirname, file)).href);

/**
 * @param {MutateOptions} options
 * @param {import('nx/src/devkit-exports').ExecutorContext} context
 * @param {boolean} report
 */
async function runStryker(options, context, report) {
  const root = context.root;
  const project = /** @type {string} */ (context.projectName);
  const projectRoot = context.projectsConfigurations.projects[project].root;
  const tier = options.tier ?? 'all';
  const config = await load('config.mjs');
  const run = options.run ?? config.runName(project, tier);
  const testExecutor =
    context.projectsConfigurations.projects[project].targets?.['test']
      ?.executor;
  const params = {
    project,
    root: projectRoot,
    runner:
      options.runner ??
      (testExecutor === '@nx/angular:unit-test' ? 'angular' : 'vitest'),
    exclude: options.exclude ?? [],
  };
  const configFile = path.join(__dirname, 'stryker.config.mjs');
  const env = {
    ...process.env,
    MMSTACK_STRYKER: JSON.stringify(params),
    STRYKER_TIER: tier,
    STRYKER_RUN: run,
    NX_DAEMON: 'false',
  };

  if (options.listFiles) {
    process.env.STRYKER_TIER = tier;
    const { mutate } = config.defineStrykerConfig(params);
    for (const file of mutate)
      console.log(`${config.tierOf(file).padEnd(8)} ${file}`);
    console.log(
      `\n${mutate.length} files, tier ${tier}, runner ${params.runner}`,
    );
    return { success: true };
  }

  const args = ['run', configFile];
  if (options.mutate?.length) args.push('--mutate', options.mutate.join(','));
  if (options.concurrency)
    args.push('--concurrency', String(options.concurrency));
  if (options.dryRunOnly) args.push('--dryRunOnly');
  if (options.incremental) args.push('--incremental');
  if (options.logLevel) args.push('--logLevel', options.logLevel);
  if (report) args.push('--reporters', 'html,json,progress');

  const outDir = path.join(root, config.runDir(run));
  const started = Date.now();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'node_modules/.bin/stryker'), args, {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
  const durationMs = Date.now() - started;

  if (report && !options.dryRunOnly) {
    if (!fs.existsSync(path.join(outDir, 'mutation.json'))) {
      console.error(
        `${project}: Stryker wrote no mutation.json to ${config.runDir(run)}`,
      );
      return { success: false };
    }
    let head = 'unknown';
    try {
      head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      if (
        execFileSync('git', ['status', '--porcelain'], {
          cwd: root,
          encoding: 'utf8',
        }).trim()
      )
        head += '+dirty';
    } catch {
      // not a git checkout
    }
    const { writeSummary, writeIndex } = await load('summary.mjs');
    const summary = writeSummary(outDir, {
      project,
      tier,
      run,
      head,
      durationMs,
      exitCode,
    });
    writeIndex(path.join(root, config.OUTPUT_ROOT));
    console.log(
      `\n${run}: score ${summary.score.total ?? 'n/a'} (covered ${summary.score.covered ?? 'n/a'}), ` +
        `${summary.counts.Survived} survived, ${summary.counts.NoCoverage} without coverage.\n` +
        `  ${path.relative(root, path.join(outDir, 'summary.md'))}\n  ${config.OUTPUT_ROOT}/summary.md`,
    );
  }
  return { success: exitCode === 0 };
}

/** @param {MutateOptions} options @param {any} context */
exports.mutate = (options, context) => runStryker(options, context, false);
/** @param {MutateOptions} options @param {any} context */
exports.mutateReport = (options, context) => runStryker(options, context, true);
