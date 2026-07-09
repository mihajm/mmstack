import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-mesh-agents',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Agents"
      pkg="@mmstack/mesh"
      lead="An agent writes through the same protocol as a person: the same envelopes, attribution, and ACLs. How much authority you give it is the choice. Review its work on a branch, or let it write to the room directly under a scoped policy."
    >
      <docs-section title="Review a branch" id="branch">
        <p>
          An agent's write is a sample that can be wrong, so the safe default is
          to keep it behind a person's approval. <code>mesh.fork()</code> gives
          the agent a <a mmLink="/docs/primitives/store">fork</a> of the synced
          store. Its writes stay on the fork, off the room. <code>ops()</code> is
          the staged change as data, ready to render for a reviewer.
          <code>commit()</code> emits it to the room; <code>discard()</code> drops
          it.
        </p>
        <docs-code [code]="branch" lang="ts" />
        <p>
          The commit cites what the fork observed when it forked, so an edit that
          lands on the room while a person reviews stays a concurrent value the
          merge policy decides, never silently overwritten by the approval. Call
          <code>rebase()</code> to re-observe the room first when you want the
          proposal to apply on top of the latest instead. The reviewer reads and
          writes normal store values, and the agent never touches the room
          directly. This is the fit for a write that should be seen before it
          lands.
        </p>
      </docs-section>

      <docs-section title="Write as a peer" id="peer">
        <p>
          A trusted, in-scope agent can join the room directly. Give it a narrower
          <code>ctx</code> and a <code>policy</code>, and the relay ejects any
          write outside its scope, the same
          <a mmLink="/docs/mesh/client">tripwire</a> that guards a human peer.
        </p>
        <docs-code [code]="peer" lang="ts" />
        <p>
          A live agent inherits the same conflict rules as everyone else. An agent
          writes faster than a person, so on a shared field it can win a
          last-writer-wins race often. The relay rate-limits throughput, which is
          not the same as fairness on a contested value. Reach for the branch when
          a field carries real weight.
        </p>
      </docs-section>

      <docs-section title="Attribution and identity" id="attribution">
        <p>
          An agent's <code>writer</code> is an opaque id, the same shape a person
          gets. Natural identity never enters the envelope. Keep the mapping from
          id to identity in your own table. For an agent you keep that mapping for
          accountability. For a person you can sever it to satisfy an erasure
          request, and the journal stays intact and anonymous because the write
          history never held the identity.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class MeshAgents {
  protected readonly branch = `import { store } from '@mmstack/primitives';
import { meshSync } from '@mmstack/mesh';

const board = store<Board>(initialBoard());
const mesh = meshSync(board, { room: 'board-42', writer: userId, transport });

const proposal = mesh.fork(); // the agent's branch, off the room
runAgent(proposal.store);     // it writes here

proposal.ops();      // StoreOp[] for the reviewer to see
proposal.commit();   // approve: emits as concurrent writes; a mid-review room edit is never steamrolled
// proposal.rebase();  // re-observe the room, then commit on top
// proposal.discard(); // reject: drops the staged writes`;

  protected readonly peer = `meshSync(board, {
  room: 'board-42',
  writer: agentId,
  transport,
  ctx: { kind: 'agent', claims: { scope: 'pricing' } },
  policy: pricingScopeOnly, // the relay ejects a write outside 'pricing'
});`;
}
