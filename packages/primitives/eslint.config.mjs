import baseConfig from '../../eslint.config.mjs';
import { ngProjectConfig } from '../../eslint-ng.config.mjs';

export default [
  ...baseConfig,
  ...ngProjectConfig({ prefix: 'mm' }),
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
            // spec-side property generators, excluded from the library build
            '{projectRoot}/core/src/lib/semantics/testing/**',
          ],
        },
      ],
    },
  },
];
