import { workspaceRoot } from '@nx/devkit';
import { defineConfig, devices } from '@playwright/test';

// Own port by default: 4200 is routinely occupied by other dev servers (e.g. studio),
// and Playwright's reuseExistingServer can't tell a foreign app from the playground.
const baseURL = process.env['BASE_URL'] || 'http://localhost:4300';
const port = new URL(baseURL).port || '80';

/**
 * E2E coverage for the playground app — real-browser behavior that jsdom unit
 * tests can't simulate: `@mmstack/dnd` drags (pointer + native HTML5) and
 * `@mmstack/resource` mutation persistence (real IndexedDB + offline emulation).
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
    command: `npx nx run playground:serve --port=${port}`,
    url: baseURL,
    reuseExistingServer: !process.env['CI'],
    cwd: workspaceRoot,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
