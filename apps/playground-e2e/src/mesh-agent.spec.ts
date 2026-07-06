import { expect, test } from '@playwright/test';

// "An agent is a user, just a narrower one", proven end to end: a human and an agent
// share a room over the real relay, which enforces a path ACL. The agent's in-scope write
// replicates; its out-of-scope write trips the relay and ejects it, and the human never sees it.

test.describe('agent as a peer, scoped by the relay ACL', () => {
  test('in-scope agent write replicates; out-of-scope write ejects the agent', async ({
    context,
  }) => {
    const human = await context.newPage();
    const agent = await context.newPage();
    await human.goto('/mesh-agent?writer=human-1&kind=human');
    await expect(human.getByTestId('status')).toHaveText('live');
    await agent.goto('/mesh-agent?writer=agent-1&kind=agent');
    await expect(agent.getByTestId('status')).toHaveText('live');

    // in scope: the agent writes its own subtree → the human sees it replicate
    await agent.getByTestId('write-note').click();
    await expect(human.getByTestId('note')).toHaveText('note-by-agent-1');

    // out of scope: the agent writes a human-only path → the relay tripwire ejects it
    await agent.getByTestId('write-title').click();
    await expect(agent.getByTestId('status')).toHaveText('ejected');

    // the forbidden write never reached the room: the human's title is untouched
    await expect(human.getByTestId('title')).toHaveText('shared');

    // and a human write is unaffected by the ACL
    await human.getByTestId('write-note').click();
    await expect(human.getByTestId('note')).toHaveText('note-by-human-1');

    await human.close();
    await agent.close();
  });
});
