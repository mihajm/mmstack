import { expect, test } from '@playwright/test';

// The durable outbox's cross-tab single-writer lock (`crossTab: 'queue'`), proven end to end in a
// real browser with the real Web Locks API. Two tabs of the same origin share one `outbox.key`:
// the first owns the lock and is `live`; the second WAITS (`connecting`) until the first closes,
// then acquires the lock and goes live. Exactly one durable writer per key at a time.

test.describe('durable outbox — cross-tab single-writer lock', () => {
  test('a second tab on the same key waits, then takes over when the first closes', async ({
    context,
  }) => {
    const room = `outbox-${Date.now()}`;
    const key = `outbox-key-${Date.now()}`;
    const url = (writer: string) =>
      `/mesh-outbox?writer=${writer}&room=${room}&key=${key}`;

    const t1 = await context.newPage();
    await t1.goto(url('tab-1'));
    await expect(t1.getByTestId('status')).toHaveText('live'); // owns the lock

    const t2 = await context.newPage();
    await t2.goto(url('tab-2'));
    // contends for the same lock → must wait, never going live while t1 holds it
    await expect(t2.getByTestId('status')).toHaveText('connecting');
    await t2.waitForTimeout(600);
    await expect(t2.getByTestId('status')).toHaveText('connecting'); // still waiting

    // t1 closes → the Web Lock releases → t2 acquires and goes live
    await t1.close();
    await expect(t2.getByTestId('status')).toHaveText('live');

    await t2.close();
  });
});
