import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: 'esm',
  platform: 'node',
  dts: true,
  clean: true,
  outDir: '../../dist/packages/translate-tools',
  tsconfig: 'tsconfig.lib.json',
});
