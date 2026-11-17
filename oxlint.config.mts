import { defineConfig } from 'oxlint';

/**
 * Workspace-wide lint config: oxlint's correctness defaults (type-aware, via oxlint-tsgolint)
 * plus Nx project boundaries.
 */
export default defineConfig({
  plugins: ['eslint', 'typescript', 'oxc'],
  jsPlugins: ['@nx/oxlint/boundaries-plugin'],
  categories: { correctness: 'error' },
  options: {
    typeAware: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: 'error',
    respectEslintDisableDirectives: false,
  },
  ignorePatterns: ['**/dist', '**/coverage', '**/.angular', 'tmp'],
  rules: {
    '@nx/enforce-module-boundaries': [
      'error',
      {
        enforceBuildableLibDependency: true,
        allow: ['^.*/oxlint\\.config\\.mts$'],
        depConstraints: [
          // @mmstack/mesh and @mmstack/worker must never import each other: a client is ONE
          // origin, and composition (worker + mesh + persist as readers of one store) lives on
          // the main thread. The mesh must not learn about the worker, nor the reverse.
          {
            sourceTag: 'scope:mesh',
            notDependOnLibsWithTags: ['scope:worker'],
          },
          {
            sourceTag: 'scope:worker',
            notDependOnLibsWithTags: ['scope:mesh'],
          },
          { sourceTag: '*', onlyDependOnLibsWithTags: ['*'] },
        ],
      },
    ],
    'no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    'typescript/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],

    // Type-aware defaults that fight deliberate patterns here:
    // APIs are closure objects typed with method syntax, so destructuring them is safe
    'typescript/unbound-method': 'off',
    // generic `${value}` / String(value) labels and keys are intentional
    'typescript/restrict-template-expressions': 'off',
    'typescript/no-base-to-string': 'off',
    // canonicalization relies on the default code-unit sort
    'typescript/require-array-sort-compare': 'off',
    // `Key | '*'`-style unions document intent even when one member absorbs another
    'typescript/no-redundant-type-constituents': 'off',
    // spreading strings and plain closure objects is intentional
    'typescript/no-misused-spread': 'off',
  },
  overrides: [
    {
      // awaiting a non-thenable still yields a microtask, which async tests rely on
      files: ['**/*.spec.ts'],
      rules: { 'typescript/await-thenable': 'off' },
    },
  ],
});
