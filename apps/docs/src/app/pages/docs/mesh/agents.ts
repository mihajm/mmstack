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
      lead="An agent writes through the same protocol as a person: the same envelopes, attribution, and ACLs. agentSeat gives it a seat anywhere JavaScript runs, and how much authority you give it is the choice. Review its work on a branch, or let it write to the room directly under a scoped policy."
    >
      <docs-section title="A seat at the table" id="seat">
        <p>
          <code>agentSeat</code> is a headless room peer: no Angular injector, no
          browser APIs, so it runs in the Node service that hosts your model
          loop. It holds a live replica of the room document as a normal signal
          store, writes with the same attribution as any peer, and reconnects and
          rebases exactly like the browser client, because both are shells over
          one session implementation.
        </p>
        <docs-code [code]="seat" lang="ts" />
        <p>
          One seat is one identity. For several agents in one room, a drafting
          assistant and an adversarial reviewer say, open a seat per agent and
          scope each with the relay policy. Roles are a policy question, not an
          API one.
        </p>
      </docs-section>

      <docs-section title="Review a branch" id="branch">
        <p>
          An agent's write is a sample that can be wrong, so the safe default is
          to keep it behind a person's approval. <code>seat.fork()</code> (and
          <code>mesh.fork()</code> in the browser) gives the agent a
          <a mmLink="/docs/primitives/store">fork</a> of the synced store. Its
          writes stay on the fork, off the room. <code>ops()</code> is the
          staged change as data, ready to render for a reviewer.
          <code>commit()</code> emits it to the room; <code>discard()</code>
          drops it.
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

      <docs-section title="Feed the model diffs, not the world" id="context">
        <p>
          Resending the whole document every turn wastes the context window and
          defeats provider prompt caching. The seat splits room state into a
          cacheable base and an append-only tail.
          <code>stableSnapshot()</code> returns the document stamped with the
          relay sequence number it is provably the fold of, or
          <code>null</code> while one of the seat's own writes is still in
          flight. A non-null result is byte-stable for its seq: any replica at
          that seq holds exactly this document, which is what makes it safe to
          cache. <code>changes</code> then delivers everything after that seq in
          order, and <code>describeOp</code> turns each op into a line of plain
          English for the model.
        </p>
        <docs-code [code]="context" lang="ts" />
        <p>
          When to refresh the base is your policy: message velocity, suffix
          length, context size. The one rule is the <code>resync</code> event. A
          seat that rejoins past the relay's retention re-establishes state from
          a snapshot, the missed changes are not replayable, and the accumulated
          tail no longer extends the stream. Drop it and take a fresh base. The
          seat carries no model code and no provider dependency; its reads and
          writes are plain JSON-shaped functions that wrap directly into a tool
          definition for the AI SDK of your choice.
        </p>
      </docs-section>

      <docs-section title="Write as a peer" id="peer">
        <p>
          A trusted, in-scope agent can write to the room directly. Give it a
          narrower <code>ctx</code> and a <code>policy</code>, and the relay
          ejects any write outside its scope, the same
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
  protected readonly seat = `import { agentSeat, describeOp, webSocketTransport } from '@mmstack/mesh';

const seat = agentSeat(initialBoard(), {
  room: 'board-42',
  writer: agentId, // an opaque principal id, like any peer's
  transport: webSocketTransport('wss://sync.example.com'),
  ctx: { kind: 'agent' },
});

seat.snapshot();                       // the current document, plain data
seat.setAtPath('tasks.t1.done', true); // dot paths, the shape a tool call produces
seat.setPresence({ name: 'Scribe', kind: 'agent' });`;

  protected readonly branch = `const proposal = seat.fork(); // the agent's branch, off the room
setAtPath(proposal.store, 'plan.endDate', '2026-10-11'); // it writes here

proposal.ops();      // StoreOp[] for the reviewer to see
proposal.commit();   // approve: emits as concurrent writes; a mid-review room edit is never steamrolled
// proposal.rebase();  // re-observe the room, then commit on top
// proposal.discard(); // reject: drops the staged writes`;

  protected readonly context = `let base = seat.stableSnapshot(); // { seq, doc } | null while a write is in flight
const sinceBase: string[] = [];

seat.changes((e) => {
  if (e.kind === 'change') {
    sinceBase.push(...e.ops.map((op) => describeOp(op, e.writer)));
  } else {
    base = null;          // 'resync': the tail no longer extends the stream
    sinceBase.length = 0; // rebuild from a fresh base
  }
});

// per model turn: cached prefix + appended suffix, refresh on your own cadence
const prompt = { doc: base?.doc, activity: sinceBase };`;

  protected readonly peer = `agentSeat(initialBoard(), {
  room: 'board-42',
  writer: agentId,
  transport,
  ctx: { kind: 'agent', claims: { scope: 'pricing' } },
  policy: pricingScopeOnly, // the relay ejects a write outside 'pricing'
  onEject: (reason) => log.warn('agent ejected', reason),
});`;
}
