// @ts-check
// The one Stryker config. The nx `mutate` / `mutate-report` executors pass the project through
// MMSTACK_STRYKER; run Stryker through them, not directly.
import { defineStrykerConfig } from './config.mjs';

const project = process.env['MMSTACK_STRYKER'];
if (!project) {
  throw new Error('Run mutation tests through nx: nx run <project>:mutate');
}

export default defineStrykerConfig(JSON.parse(project));
