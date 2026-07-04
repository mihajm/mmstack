import { expect, test } from '@playwright/test';

// Two real browser peers converging over an actual RTCPeerConnection data channel. The unit
// suite runs webRtcMesh over a fake channel hub; this is the only place real SDP/ICE/DTLS runs
// and where we prove the state travels peer-to-peer, not through the relay.

const RELAY = `http://127.0.0.1:${process.env['RELAY_PORT'] || '4301'}`;

// WebRTC over loopback is fast but not perfectly deterministic; allow a retry.
test.describe.configure({ retries: 2 });

test.describe('webRtcMesh over a real RTCPeerConnection', () => {
  test('two peers open a data channel, converge both ways, and the relay only signals', async ({
    context,
  }) => {
    const alice = await context.newPage();
    const bob = await context.newPage();
    // register alice in the room first, so bob's welcome already lists her and the
    // deterministic perfect-negotiation roles resolve without a join race
    await alice.goto('/webrtc?writer=alice');
    await expect(alice.getByTestId('status')).toHaveText('live');
    await bob.goto('/webrtc?writer=bob');
    await expect(bob.getByTestId('status')).toHaveText('live');

    // a data channel only opens after real offer/answer + ICE + DTLS succeed → peers == 1
    await expect(alice.getByTestId('peers')).toHaveText('1', { timeout: 20_000 });
    await expect(bob.getByTestId('peers')).toHaveText('1', { timeout: 20_000 });
    await expect(alice.getByTestId('status')).toHaveText('live');

    // write on alice → replicates to bob over the peer-to-peer channel
    await alice.getByTestId('text-input').fill('hello P2P');
    await alice.getByTestId('save').click();
    await expect(bob.getByTestId('text')).toHaveText('hello P2P', {
      timeout: 15_000,
    });

    // and the other direction
    await bob.getByTestId('text-input').fill('hi from bob');
    await bob.getByTestId('save').click();
    await expect(alice.getByTestId('text')).toHaveText('hi from bob', {
      timeout: 15_000,
    });

    // the relay carried signaling frames but never an op envelope for this room:
    // the state genuinely flowed peer-to-peer
    const stats = (await (await fetch(`${RELAY}/stats`)).json()) as Record<
      string,
      { hello: number; env: number; presence: number; signal: number }
    >;
    expect(stats['webrtc-e2e']?.signal).toBeGreaterThan(0);
    expect(stats['webrtc-e2e']?.env ?? 0).toBe(0);

    await alice.close();
    await bob.close();
  });
});
