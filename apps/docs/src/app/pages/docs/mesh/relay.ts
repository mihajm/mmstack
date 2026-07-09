import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-mesh-relay',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="The relay"
      pkg="@mmstack/mesh-protocol"
      lead="A runtime-agnostic reference relay. It sequences operations, keeps a journal, retains per-path register state, answers a joining client with whatever it is missing, routes presence, and enforces an optional policy. It retains operations but never resolves them to a value: which write wins is client-configured policy, so a relay that picked a winner would seed late joiners into disagreement with everyone already in the room."
    >
      <docs-section title="Creating a relay" id="create">
        <p>
          <code>createRelay</code> takes an optional policy, a policy version,
          limits, and a journal size. <code>relay.connect(socket, ctx)</code>
          attaches one authenticated connection and returns
          <code>{{ '{' }} receive, disconnect {{ '}' }}</code>. The socket is
          anything with <code>send</code> and <code>close</code>, so the same
          relay drives a WebSocket server, a Durable Object, or an in-memory pair
          in a test. The relay never mints identity; your adapter supplies the
          principal.
        </p>
        <docs-code [code]="create" lang="ts" />
      </docs-section>

      <docs-section title="Joining" id="join">
        <p>
          When a client joins, the relay answers with one of three shapes:
          <code>up-to-date</code> when it already has the latest sequence,
          <code>delta</code> with just the envelopes it missed for a fast
          reconnect, or <code>snapshot</code> with the retained register state
          when it is too far behind for the journal to cover. The snapshot is
          register state, not a resolved value: the joiner folds it locally with
          its own policy and lands on the same value as everyone else. A deleted
          key whose tombstone has settled is dropped from the retained state, so
          a late joiner never resurrects it.
        </p>
      </docs-section>

      <docs-section title="Trust" id="trust">
        <p>
          Validation is a pure, versioned function, run the same way on the
          client and the relay. Because an honest client never emits an invalid
          op, any invalid op the relay sees is a broken or hostile peer, so the
          relay ejects that writer for the session.
          <code>pathPrefixAcl</code> grants write access by path prefix and can
          discriminate by principal.
        </p>
        <p>
          What the relay enforces is shape and path access: a well-formed
          envelope and a writer allowed to touch that path. It does not verify
          the precedence an op claims (its authority level) or that its citations
          are genuine, so a room that needs "only this role may override" enforces
          that in the policy, on a trusted <code>writer</code> that your adapter
          authenticates. Eject is scoped to that writer, which bans the principal
          across its connections rather than one device. Two clients connected
          directly over WebRTC skip the relay, so a peer-to-peer room is
          trust-full for authority: use it among clients that already trust each
          other, or route through the relay when they do not.
        </p>
        <docs-code [code]="policy" lang="ts" />
      </docs-section>

      <docs-section title="Persistence" id="persistence">
        <p>
          Rooms live in memory, and the relay exposes a seam rather than a
          storage engine. <code>onCommit</code> fires after every envelope is
          sequenced and retained, with the envelope and the room's current
          <code>{{ '{' }} seq, instance, registers, wm, schemaVersion {{ '}' }}</code>.
          The envelope is the persistence record: append it to a journal and
          checkpoint the register state as often as you like.
          <code>relay.hydrate</code> restores a persisted room before clients
          join and refuses once the room has state or members. Restoring the
          persisted <code>instance</code> lets returning clients keep their
          sequence watermark and catch up with a delta answer; omitting it falls
          back to a full snapshot, which is always safe.
        </p>
        <docs-code [code]="persistence" lang="ts" />
      </docs-section>

      <docs-section title="Adapters" id="adapters">
        <p>
          The relay is pure over injected sockets, so an adapter is a few lines
          of glue. A Cloudflare Durable Object maps naturally onto a room.
        </p>
        <docs-code [code]="adapter" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class MeshRelay {
  protected readonly create = `import { createRelay } from '@mmstack/mesh-protocol';

const relay = createRelay({
  policyVersion: 1,
  policy: myOpPolicy,
  limits: { maxOpsPerEnvelope: 1024, maxEnvelopesPerSecond: 50 },
  journalLimit: 1000,
});

const conn = relay.connect(
  { send: (m) => socket.send(JSON.stringify(m)), close: () => socket.close() },
  { writer: authenticatedUserId },
);`;

  protected readonly policy = `import { pathPrefixAcl } from '@mmstack/mesh-protocol';

const policy = pathPrefixAcl([
  { prefix: ['notes'], allow: () => true },
  { prefix: ['cases', '*', 'plan'], allow: (ctx) => ctx.kind !== 'agent' },
]);`;

  protected readonly persistence = `const relay = createRelay({
  onCommit: (room, env, state) => {
    journal.append(room, env); // your DB, KV, or DO storage
    if (state.seq % 100 === 0) checkpoints.put(room, state);
  },
});

// on boot, or inside a Durable Object's blockConcurrencyWhile
const saved = await checkpoints.get(roomName);
if (saved) {
  relay.hydrate(roomName, {
    ...saved, // seq, instance, registers, wm, schemaVersion
    journal: await journal.tail(roomName, saved.seq),
  });
}`;

  protected readonly adapter = `export class MeshRoom {
  relay = createRelay();
  async fetch(request: Request) {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const writer = await authenticate(request);
    const conn = this.relay.connect(
      { send: (m) => server.send(JSON.stringify(m)), close: () => server.close() },
      { writer },
    );
    server.addEventListener('message', (e) => conn.receive(JSON.parse(String(e.data))));
    server.addEventListener('close', () => conn.disconnect());
    return new Response(null, { status: 101, webSocket: client });
  }
}`;
}
