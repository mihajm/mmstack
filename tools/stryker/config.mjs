// @ts-check
// Shared Stryker configuration, built per project by stryker.config.mjs from what the nx
// `mutate` / `mutate-report` executors pass in (see README.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '../..');
const rel = (/** @type {string} */ file) =>
  path.relative(WORKSPACE, file).split(path.sep).join('/');

/** Every run writes below `tmp/stryker/<run>/` (gitignored, ignored by nx). */
export const OUTPUT_ROOT = 'tmp/stryker';

const NOT_SOURCE = [
  '**/*.spec.ts',
  '**/*.test.ts',
  '**/*.d.ts',
  '**/test-setup.ts',
  '**/*.config.ts',
  '**/*.config.mts',
  '**/benchmarks/**',
  '**/node_modules/**',
];

/**
 * Tier "angular": the file needs the Angular runtime beyond signals (decorators, DI, render hooks, DOM
 * handles). Everything else is tier "logic". Mechanical on purpose: the same file always lands in the same tier.
 */
const ANGULAR_BOUND =
  /@(Component|Directive|Pipe|Injectable|NgModule)\(|\binject\(|\bInjectionToken\b|\bInjector\b|\bDestroyRef\b|\bafterNextRender\(|\bafterRenderEffect\(|\bElementRef\b|\bRenderer2\b|\bTestBed\b/;

/** @typedef {'all' | 'logic' | 'angular'} Tier */
export const TIERS = /** @type {const} */ (['all', 'logic', 'angular']);

/** @param {string} file workspace-relative path */
export function tierOf(file) {
  return ANGULAR_BOUND.test(fs.readFileSync(path.join(WORKSPACE, file), 'utf8'))
    ? 'angular'
    : 'logic';
}

/** @param {string} root workspace-relative project root */
export function sourceFiles(root) {
  return fs
    .globSync('**/*.ts', {
      cwd: path.join(WORKSPACE, root),
      exclude: (/** @type {string} */ f) =>
        NOT_SOURCE.some((g) => path.matchesGlob(f, g)),
    })
    .map((f) => rel(path.join(WORKSPACE, root, f)))
    .sort();
}

/** @param {string} project @param {Tier} tier */
export function runName(project, tier) {
  return tier === 'all' ? project : `${project}-${tier}`;
}

/** @param {string} run */
export function runDir(run) {
  return `${OUTPUT_ROOT}/${run}`;
}

/**
 * @param {{
 *   project: string;
 *   root: string;
 *   runner: 'angular' | 'vitest';
 *   vitestConfig?: string;
 *   exclude?: string[];
 * }} options
 * @returns {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export function defineStrykerConfig({
  project,
  root,
  runner,
  vitestConfig,
  exclude = [],
}) {
  const tier = /** @type {Tier} */ (process.env['STRYKER_TIER'] ?? 'all');
  if (!TIERS.includes(tier))
    throw new Error(
      `STRYKER_TIER must be one of ${TIERS.join(', ')}, got "${tier}"`,
    );
  const run = process.env['STRYKER_RUN'] ?? runName(project, tier);
  const out = runDir(run);

  const mutate = sourceFiles(root)
    .filter((f) => !exclude.some((g) => path.matchesGlob(f, g)))
    .filter((f) => tier === 'all' || tierOf(f) === tier);

  const runnerOptions =
    runner === 'angular'
      ? {
          testRunner: 'angular-vitest',
          plugins: [
            '@stryker-mutator/vitest-runner',
            path.join(HERE, 'angular-runner.mjs'),
            path.join(HERE, 'angular-ignorer.mjs'),
          ],
          ignorers: ['angular-static'],
          angularVitest: { project },
          // vitest sees the builder's bundles, never the .ts sources, so it cannot find related specs.
          // Per-test coverage narrows each mutant to the specs that reach it instead.
          vitest: { related: false },
        }
      : {
          testRunner: 'vitest',
          plugins: ['@stryker-mutator/vitest-runner'],
          vitest: { configFile: vitestConfig ?? `${root}/vite.config.ts` },
        };

  return {
    ...runnerOptions,
    coverageAnalysis: 'perTest',
    mutate,
    ignorePatterns: [
      'dist',
      'tmp',
      'out-tsc',
      'coverage',
      '.nx',
      '.angular',
      '.vitest',
      'test-results',
      'apps',
      'libs',
    ],
    reporters: ['html', 'json', 'clear-text', 'progress'],
    htmlReporter: { fileName: `${out}/index.html` },
    jsonReporter: { fileName: `${out}/mutation.json` },
    clearTextReporter: { logTests: false, allowEmojis: false },
    incrementalFile: `${out}/incremental.json`,
    tempDirName: `${out}/sandbox`,
    cleanTempDir: true,
    concurrency: 4,
    dryRunTimeoutMinutes: 15,
    // No floors yet: `break` per tier is set from measured results (S4).
    thresholds: { high: 80, low: 60, break: null },
  };
}
