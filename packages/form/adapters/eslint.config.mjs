import baseConfig from '../../../eslint.config.mjs';
import { ngProjectConfig } from '../../../eslint-ng.config.mjs';

export default [
  ...baseConfig,
  ...ngProjectConfig({ prefix: 'mm' }),
];
