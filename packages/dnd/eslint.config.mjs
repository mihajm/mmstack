import { ngProjectConfig } from '../../eslint-ng.config.mjs';
import baseConfig from '../../eslint.config.mjs';

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
          ],
          ignoredDependencies: [
            '@atlaskit/pragmatic-drag-and-drop-hitbox',
            '@atlaskit/pragmatic-drag-and-drop-auto-scroll',
            '@atlaskit/pragmatic-drag-and-drop-flourish',
            '@atlaskit/pragmatic-drag-and-drop-live-region',
          ],
        },
      ],
    },
  },
];
