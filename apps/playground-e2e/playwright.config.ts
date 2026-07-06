import { workspaceRoot } from '@nx/devkit';
import { defineConfig, devices } from '@playwright/test';

// Own port by default: 4200 is routinely occupied by other dev servers (e.g. studio),
// and Playwright's reuseExistingServer can't tell a foreign app from the playground.
const baseURL = process.env['BASE_URL'] || 'http://localhost:4300';
const port = new URL(baseURL).port || '80';

// Real @mmstack/mesh-protocol relay over `ws`, for the WebRTC signaling and agent-as-peer
// e2e. Built first because the workspace package resolves via tsconfig paths, not Node.
const relayPort = process.env['RELAY_PORT'] || '4301';

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
  webServer: [
    {
      command: `npx nx run playground:serve --port=${port}`,
      url: baseURL,
      reuseExistingServer: !process.env['CI'],
      cwd: workspaceRoot,
      timeout: 120_000,
    },
    {
      command: `npx nx build mesh-protocol && RELAY_PORT=${relayPort} node apps/playground-e2e/src/support/relay-server.mjs`,
      url: `http://127.0.0.1:${relayPort}`,
      reuseExistingServer: !process.env['CI'],
      cwd: workspaceRoot,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Expose real loopback ICE candidates: headless Chromium can't resolve the mDNS
        // `.local` names it uses to hide local IPs, which makes loopback WebRTC flaky.
        launchOptions: {
          args: [
            '--disable-features=WebRtcHideLocalIpsWithMdns',
            '--force-webrtc-ip-handling-policy=default',
          ],
        },
      },
    },
    {
      // Safari coverage for the interaction engines. CDP-based perf guards and
      // the WebRTC/mesh suites (loopback ICE needs the Chromium launch flags)
      // stay Chromium-only.
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testIgnore: [
        '**/pointer-sortable-perf.spec.ts',
        '**/pointer-edge-perf.spec.ts',
        '**/webrtc.spec.ts',
        '**/mesh-agent.spec.ts',
        '**/worker-mesh.spec.ts',
        // setOffline emulation and multi-tab Web Lock handover timing are not
        // reliable under Playwright's WebKit driver (the lib is not Safari-bound)
        '**/persistence.spec.ts',
      ],
    },
  ],
});
