import nx from '@nx/eslint-plugin';
const jsoncParser = await import('jsonc-eslint-parser');

/**
 * Factory that returns ESLint flat-config entries for an Angular project.
 * Covers directive/component selector rules and tsconfig-scoped type checking.
 *
 * @param {object}          [options]
 * @param {string|string[]} [options.prefix]           - Shorthand: sets both directive and component prefix
 * @param {string|string[]} [options.directivePrefix]  - Prefix(es) for directive selectors (camelCase); overrides prefix
 * @param {string|string[]} [options.componentPrefix]  - Prefix(es) for component selectors (kebab-case); overrides prefix
 * @param {string}          [options.tsconfig]         - Glob path to the project's tsconfig(s)
 * @param {object}          [options.additionalRules]  - Extra rule overrides merged in last
 * @returns {import('eslint').Linter.Config[]}
 */
export function ngProjectConfig({
  prefix = 'mm',
  directivePrefix = prefix,
  componentPrefix = prefix,
  tsconfig,
  additionalRules = {},
} = {}) {
  return [
    {
      files: ['**/*.json'],
      rules: {
        '@nx/dependency-checks': [
          'error',
          {
            ignoredFiles: [
              '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
              '{projectRoot}/**/*.spec.ts',
              '{projectRoot}/**/*.test.ts',
            ],
          },
        ],
      },
      languageOptions: {
        parser: jsoncParser,
      },
    },
    ...nx.configs['flat/angular'],
    ...nx.configs['flat/angular-template'],
    {
      files: ['**/*.ts'],
      ...(tsconfig
        ? {
            languageOptions: {
              parserOptions: {
                project: tsconfig,
              },
            },
          }
        : {}),
      rules: {
        '@angular-eslint/directive-selector': [
          'error',
          {
            type: 'attribute',
            prefix: directivePrefix,
            style: 'camelCase',
          },
        ],
        '@angular-eslint/component-selector': [
          'error',
          {
            type: 'element',
            prefix: componentPrefix,
            style: 'kebab-case',
          },
        ],
        ...additionalRules,
      },
    },
    {
      files: ['**/*.html'],
      rules: {},
    },
  ];
}
