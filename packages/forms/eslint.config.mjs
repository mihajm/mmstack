import { ngProjectConfig } from '../../eslint-ng.config.mjs';
import baseConfig from '../../eslint.config.mjs';

export default [...baseConfig, ...ngProjectConfig({ prefix: 'mm' })];
