// @ts-check
// Stryker test runner for projects tested through `@nx/angular:unit-test`.
//
// It is the stock `@stryker-mutator/vitest-runner` with `init()` and `dispose()` replaced: instead of
// creating its own Vitest, it starts the project's `test` target in-process (watch mode, so the instance
// stays alive) and takes over the Vitest instance the Angular builder creates. One Angular build per
// Stryker worker then serves every mutant, and the specs run exactly as `nx test` runs them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const WORKSPACE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workspaceRequire = createRequire(path.join(WORKSPACE, 'package.json'));
const runnerDir = path.dirname(
  workspaceRequire.resolve('@stryker-mutator/vitest-runner/package.json'),
);
const runnerRequire = createRequire(path.join(runnerDir, 'package.json'));
const importFile = (/** @type {string} */ file) =>
  import(pathToFileURL(file).href);

// The runner class is not in the package's exports map, and the startup filter below lives in an
// internal Vitest field. Both are pinned: a version bump has to re-verify this file.
const PINNED = { '@stryker-mutator/vitest-runner': '10.1.1', vitest: /^5\./ };
const runnerVersion = workspaceRequire(
  '@stryker-mutator/vitest-runner/package.json',
).version;
const vitestVersion = workspaceRequire('vitest/package.json').version;
if (
  runnerVersion !== PINNED['@stryker-mutator/vitest-runner'] ||
  !PINNED.vitest.test(vitestVersion)
) {
  throw new Error(
    `tools/stryker/angular-runner.mjs was verified against @stryker-mutator/vitest-runner 10.1.1 and vitest 5.x, ` +
      `found ${runnerVersion} and ${vitestVersion}. Re-verify the runner internals before bumping.`,
  );
}

const { VitestTestRunner } = await importFile(
  path.join(runnerDir, 'dist/src/vitest-test-runner.js'),
);
const { VITEST_MODERN_TEST_NAME_SEPARATOR } = await importFile(
  path.join(runnerDir, 'dist/src/test-helpers.js'),
);
const { declareFactoryPlugin, PluginKind, commonTokens, tokens } =
  await importFile(runnerRequire.resolve('@stryker-mutator/api/plugin'));
const { INSTRUMENTER_CONSTANTS } = await importFile(
  runnerRequire.resolve('@stryker-mutator/api/core'),
);

const RUNNER_CONFIG = fileURLToPath(
  new URL('./angular-runner-config.mjs', import.meta.url),
);
const STRYKER_SETUP = path.join(runnerDir, 'dist/src/stryker-setup.js');
// A test name nothing matches: the builder's own first run (it runs the whole suite before handing
// over in watch mode) then runs nothing.
const NO_INITIAL_RUN = '^__stryker_no_initial_run__$';
const BRIDGE = Symbol.for('mmstack.stryker.angularVitest');

class AngularVitestRunner extends VitestTestRunner {
  /** @type {AsyncIterator<{ success: boolean }> | undefined} */
  #builder;

  async init() {
    process.env.NODE_ENV = 'test';
    process.env.VITEST = '1';
    process.env.NX_DAEMON = 'false';
    const setup = fs
      .readFileSync(STRYKER_SETUP, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('//# sourceMappingURL'))
      .join('\n');
    fs.writeFileSync(this.localSetupFile, setup);

    const { project, include } = this.options.angularVitest ?? {};
    if (!project) throw new Error('angularVitest.project is required');

    const started = Date.now();
    const nx = workspaceRequire('nx/src/devkit-exports');
    const root = process.cwd();
    const projectGraph = await nx.createProjectGraphAsync({
      exitOnError: false,
    });
    const context = {
      root,
      cwd: root,
      isVerbose: false,
      projectName: project,
      targetName: 'test',
      projectGraph,
      projectsConfigurations:
        nx.readProjectsConfigurationFromProjectGraph(projectGraph),
      nxJsonConfiguration: workspaceRequire('nx/src/config/nx-json').readNxJson(
        root,
      ),
    };

    let vitest;
    /** @type {any} */ (globalThis)[BRIDGE] = (/** @type {any} */ instance) => {
      vitest = instance;
    };
    const overrides = {
      watch: true,
      runnerConfig: RUNNER_CONFIG,
      filter: NO_INITIAL_RUN,
    };
    if (include?.length) Object.assign(overrides, { include });
    this.#builder = await nx.runExecutor(
      { project, target: 'test' },
      overrides,
      context,
    );
    const first = await this.#builder.next();
    if (!vitest || !first.value?.success) {
      throw new Error(
        `The Angular unit-test builder did not start for "${project}" (success=${first.value?.success}). ` +
          `Run with --logLevel trace to see the build output.`,
      );
    }
    this.log.info(
      `${project}: Angular build ready in ${Date.now() - started} ms`,
    );

    this.ctx = vitest;
    // The builder's `filter` sits in configOverride, which is merged over every project's config on every
    // run and would otherwise beat the per-run test filter of the stock runner.
    delete this.ctx.configOverride.testNamePattern;
    this.ctx.config.testNamePattern = undefined;
    this.ctx.config.bail = this.options.disableBail ? 0 : 1;
    this.ctx.config.maxConcurrency = 1;
    this.ctx.provide('globalNamespace', this.globalNamespace);
    this.ctx.provide('isGreaterThanVitest4Point1', true);
    this.ctx.provide('testNameSeparator', VITEST_MODERN_TEST_NAME_SEPARATOR);
    this.ctx.projects.forEach((/** @type {any} */ p) => {
      p.config.setupFiles = [this.localSetupFile, ...p.config.setupFiles];
    });
  }

  /** The dry run happens once, on one runner: give it the machine instead of a single fork. */
  async dryRun(/** @type {any} */ options) {
    const workers = Math.max(1, os.availableParallelism() - 2);
    this.ctx.projects.forEach(
      (/** @type {any} */ p) => (p.config.maxWorkers = workers),
    );
    try {
      return await super.dryRun(options);
    } finally {
      this.ctx.projects.forEach(
        (/** @type {any} */ p) => (p.config.maxWorkers = 1),
      );
    }
  }

  async dispose() {
    try {
      await this.ctx?.close();
    } catch {
      // the builder closes it again on return
    }
    try {
      await this.#builder?.return?.(undefined);
    } catch {
      // the worker process is going away either way
    }
    fs.rmSync(this.localSetupFile, { force: true });
  }
}

/** @param {any} injector */
function createAngularVitestRunner(injector) {
  return injector
    .provideValue('globalNamespace', INSTRUMENTER_CONSTANTS.NAMESPACE)
    .injectClass(AngularVitestRunner);
}
createAngularVitestRunner.inject = tokens(commonTokens.injector);

export const strykerPlugins = [
  declareFactoryPlugin(
    PluginKind.TestRunner,
    'angular-vitest',
    createAngularVitestRunner,
  ),
];

export const strykerValidationSchema = {
  $schema: 'http://json-schema.org/draft-07/schema',
  type: 'object',
  properties: {
    angularVitest: {
      description: 'Options for the angular-vitest test runner.',
      type: 'object',
      properties: {
        project: {
          description: 'The nx project whose `test` target runs the specs.',
          type: 'string',
        },
        include: {
          description:
            'Overrides the test target include (relative to the project source root).',
          type: 'array',
          items: { type: 'string' },
        },
      },
      additionalProperties: false,
    },
  },
};
