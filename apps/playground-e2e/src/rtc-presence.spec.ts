/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { expect, test } from '@playwright/test';

// Two real browser peers sharing pointer positions over a lossy RTCPeerConnection data channel.
// The unit suite runs rtcPresence over an in-memory channel hub; this is where real SDP/ICE/DTLS
// runs, and where a closed tab has to take its dot with it.

const RELAY = `http://127.0.0.1:${process.env['RELAY_PORT'] || '4301'}`;

// WebRTC over loopback is fast but not perfectly deterministic; allow a retry.
test.describe.configure({ retries: 2 });

test.describe('rtcPresence over a real RTCPeerConnection', () => {
  // loopback ICE needs the Chromium launch flags in playwright.config.ts
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');

  test('a pointer moved in one tab shows as a dot in the other, and goes with the tab', async ({
    context,
  }) => {
    const alice = await context.newPage();
    const bob = await context.newPage();
    // alice joins first so bob's welcome already lists her (deterministic negotiation roles)
    await alice.goto('/rtc-presence?writer=alice');
    await expect(alice.getByTestId('status')).toHaveText('live');
    await bob.goto('/rtc-presence?writer=bob');
    await expect(bob.getByTestId('status')).toHaveText('live');

    await expect(alice.getByTestId('peers')).toHaveText('1', {
      timeout: 20_000,
    });
    await expect(bob.getByTestId('peers')).toHaveText('1', { timeout: 20_000 });

    const pad = alice.getByTestId('pad');
    const box = (await pad.boundingBox())!;
    await alice.mouse.move(box.x + 40, box.y + 40);
    await alice.mouse.move(box.x + 120, box.y + 90, { steps: 5 });

    const dot = bob.getByTestId('dot-alice');
    await expect(dot).toBeVisible({ timeout: 15_000 });
    await expect(dot).toHaveCSS('left', '120px');
    await expect(dot).toHaveCSS('top', '90px');

    // the relay carried signaling for this room, never a presence or op frame
    const stats = (await (await fetch(`${RELAY}/stats`)).json()) as Record<
      string,
      { hello: number; env: number; presence: number; signal: number }
    >;
    expect(stats['rtc-presence-e2e']?.signal).toBeGreaterThan(0);
    expect(stats['rtc-presence-e2e']?.presence ?? 0).toBe(0);
    expect(stats['rtc-presence-e2e']?.env ?? 0).toBe(0);

    await alice.close();
    await expect(bob.getByTestId('dot-alice')).toHaveCount(0, {
      timeout: 15_000,
    });

    await bob.close();
  });

  test('a link closed under one side is rebuilt, and pointers flow again', async ({
    context,
  }) => {
    test.setTimeout(180_000);
    // every RTCPeerConnection the page makes, so the test can close them behind the links' back
    const track = () => {
      const Native = window.RTCPeerConnection;
      const pcs: RTCPeerConnection[] = [];
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
      window.RTCPeerConnection = class extends Native {
        constructor(...args: ConstructorParameters<typeof Native>) {
          super(...args);
          pcs.push(this);
        }
      };
    };
    type Tracked = Window & { __pcs: RTCPeerConnection[] };
    const alice = await context.newPage();
    const bob = await context.newPage();
    await alice.addInitScript(track);
    await bob.addInitScript(track);
    await alice.goto('/rtc-presence?writer=alice');
    await expect(alice.getByTestId('status')).toHaveText('live');
    await bob.goto('/rtc-presence?writer=bob');
    await expect(bob.getByTestId('status')).toHaveText('live');
    await expect(alice.getByTestId('peers')).toHaveText('1', {
      timeout: 20_000,
    });
    await expect(bob.getByTestId('peers')).toHaveText('1', { timeout: 20_000 });

    const pad = alice.getByTestId('pad');
    const box = (await pad.boundingBox())!;
    await alice.mouse.move(box.x + 40, box.y + 40);
    await alice.mouse.move(box.x + 120, box.y + 90, { steps: 5 });
    const dot = bob.getByTestId('dot-alice');
    await expect(dot).toHaveCSS('left', '120px', { timeout: 15_000 });

    const built = (page: typeof alice) =>
      page.evaluate(() => (window as unknown as Tracked).__pcs.length);
    const before = { alice: await built(alice), bob: await built(bob) };
    const started = Date.now();
    await alice.evaluate(() =>
      (window as unknown as Tracked).__pcs.forEach((pc) => pc.close()),
    );

    // alice's connector may hear nothing from its own close(); bob sees ICE consent expire,
    // restarts ICE once, gives up, rebuilds, and his announce makes alice rebuild her end
    await expect
      .poll(() => built(bob), { timeout: 90_000 })
      .toBeGreaterThan(before.bob);
    await expect
      .poll(() => built(alice), { timeout: 90_000 })
      .toBeGreaterThan(before.alice);
    await expect(bob.getByTestId('peers')).toHaveText('1', { timeout: 90_000 });
    await expect(alice.getByTestId('peers')).toHaveText('1', {
      timeout: 90_000,
    });
    const recoveredMs = Date.now() - started;
    test.info().annotations.push({
      type: 'recovery',
      description: `${recoveredMs} ms`,
    });
    console.log(`[rtc-presence e2e] link recovered in ${recoveredMs} ms`);

    await alice.mouse.move(box.x + 200, box.y + 150, { steps: 5 });
    await expect(dot).toHaveCSS('left', '200px', { timeout: 15_000 });
    await expect(dot).toHaveCSS('top', '150px');

    await alice.close();
    await bob.close();
  });
});
