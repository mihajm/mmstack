// @ts-check
// Passed to the Angular unit-test builder as `runnerConfig` by angular-runner.mjs. The builder adds these
// plugins to its own project, so `configureVitest` sees the Vitest instance the builder created.
const BRIDGE = Symbol.for('mmstack.stryker.angularVitest');

export default {
  // Instrumented code (coverage counters in every branch) runs hot property specs several times slower
  // than `nx test`; Stryker's own mutant timeout still catches mutants that never finish.
  test: { maxWorkers: 1, testTimeout: 30_000, hookTimeout: 30_000 },
  plugins: [
    {
      name: 'mmstack-stryker-bridge',
      configureVitest(/** @type {{ vitest: unknown }} */ { vitest }) {
        /** @type {any} */ (globalThis)[BRIDGE]?.(vitest);
      },
    },
  ],
};
