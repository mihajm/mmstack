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
      lead="A runtime-agnostic reference relay. It sequences operations, keeps a journal, compacts a snapshot, answers a joining client with whatever it is missing, routes presence, and enforces an optional policy. It never merges, validates schemas, or holds application logic."
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
          reconnect, or <code>snapshot</code> with the full root when it is too
          far behind for the journal to cover. Deletes fold into the snapshot, so
          a late joiner never resurrects a removed key.
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
        <docs-code [code]="policy" lang="ts" />
      </docs-section>

      <docs-section title="Persistence" id="persistence">
        <p>
          Rooms live in memory, and the relay exposes a seam rather than a
          storage engine. <code>onCommit</code> fires after every envelope is
          sequenced and folded, with the envelope and the room's current
          <code>{{ '{' }} seq, epoch, root {{ '}' }}</code>. The envelope is the
          persistence record: append it to a journal and checkpoint the root as
          often as you like. <code>relay.hydrate</code> restores a persisted
          room before clients join and refuses once the room has state or
          members. Restoring the persisted <code>epoch</code> lets returning
          clients keep their sequence watermark and catch up with a delta
          answer; omitting it falls back to a full snapshot, which is always
          safe.
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
    ...saved, // seq, epoch, root
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
