import { workspaceRoot } from '@nx/devkit';
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env['BASE_URL'] || 'http://localhost:4200';

/**
 * E2E coverage for `@mmstack/dnd` via the playground app — real-browser drags
 * (pointer + native HTML5) that jsdom unit tests can't simulate.
 */
export default defineConfig({
  testDir: './src',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: { baseURL, trace: 'on-first-retry' },
  webServer: {
    command: 'npx nx run playground:serve',
    url: baseURL,
    reuseExistingServer: !process.env['CI'],
    cwd: workspaceRoot,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
