import { defineConfig } from 'vitest/config';

// The real Worker in the browser specs is served as source by Vite, outside the Angular build,
// so its workspace imports resolve through the tsconfig paths.
export default defineConfig({
  resolve: { tsconfigPaths: true },
});
