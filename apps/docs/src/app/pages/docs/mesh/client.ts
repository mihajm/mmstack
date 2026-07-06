import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-mesh-client',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="The client"
      pkg="@mmstack/mesh"
      lead="meshSync gives you a status signal, a presence roster, per-path merge policies, automatic reconnection with rebase, and a peer-to-peer variant. The store stays a plain store the whole time."
    >
      <docs-section title="Status and registration" id="status">
        <p>
          <code>mesh.status()</code> is
          <code>'connecting' | 'live' | 'reconnecting' | 'ejected'</code>.
          Reconnection is automatic with exponential backoff. On reconnect the
          client resumes from a delta when it can, and re-applies any writes made
          while offline on top of whatever the room moved to. A relay restart is
          detected through a room epoch, so a stale sequence number never
          corrupts state. With <code>register: 'track'</code> the store also joins
          the nearest
          <a mmLink="/docs/primitives/transitions">transition scope</a>, so a
          reconnect shows up as <code>pending</code> to a boundary.
        </p>
        <docs-code [code]="status" lang="ts" />
      </docs-section>

      <docs-section title="Conflict policies" id="policies">
        <p>
          The default is last-writer-wins, decided by a hybrid logical clock.
          Attach a
          <a mmLink="/docs/primitives/sync">merge policy</a> per path for
          anything else: reconcile a list by item identity with
          <code>keyedArray</code>, or keep both sides of a clash as data with
          <code>preserve</code>. A custom merge can also wrap another CRDT such as
          Yjs for rich text. The package README has the pattern.
        </p>
        <docs-code [code]="policies" lang="ts" />
      </docs-section>

      <docs-section title="Offline and durable outbox" id="outbox">
        <p>
          Writes made while disconnected are held locally and sent on reconnect.
          That queue lives in memory by default, so a reload loses any write the
          room never acknowledged. Pass <code>outbox</code> to persist it to any
          <code>AsyncStore</code>, the same interface <code>persist</code> takes.
          On boot the client restores the queue, adopts the origin it used
          before, and resends the unacknowledged writes, which then rebase onto
          whatever the room moved to.
        </p>
        <p>
          One origin is driven by one tab at a time.
          <code>crossTab: 'queue'</code> (the default) takes a Web Lock on the
          key, so a second tab on the same key waits with <code>status()</code>
          reading <code>'connecting'</code> until the first tab closes. Use
          <code>'off'</code> to coordinate ownership yourself.
        </p>
        <p>
          The outbox persists your unacknowledged writes, not a full snapshot. For
          a meshed store, use it in place of wrapping the store in
          <code>persist</code>. The two race on boot, and the outbox is the one
          that rebases offline edits onto the room.
        </p>
        <docs-code [code]="outbox" lang="ts" />
      </docs-section>

      <docs-section title="Assemble a base before connecting" id="whenReady">
        <p>
          Pass <code>whenReady</code> to hold the connection until a local base is
          in place. <code>meshSync</code> awaits it before it connects and before
          it restores the outbox, so a store filled from another source is ready
          when the room welcome arrives and rebases your pending writes on top.
          This is the boot order for a worker-owned, meshed, persisted graph: the
          worker hydrates the base, the outbox restores this device's offline
          writes, then the room welcome supersedes the base and rebases those
          writes. Each source runs in turn instead of racing.
        </p>
        <docs-code [code]="whenReady" lang="ts" />
      </docs-section>

      <docs-section title="Multiple tabs" id="tabs">
        <p>
          Run <a mmLink="/docs/primitives/sync">tabSync</a> and
          <code>meshSync</code> on the same store to share it across a user's tabs
          while one connection carries it to the room. The outbox lock elects the
          leader, so only one tab holds the relay connection and the others share
          state over <code>tabSync</code>. A write in any tab reaches the room
          through the leader, and a room write reaches every tab through
          <code>tabSync</code>. When the leader closes, another tab takes over and
          adopts the persisted origin. Each layer is a separate reader on the
          store's op stream, so a follower's <code>meshSync</code> stays idle until
          it holds the lock and never opens a second connection.
        </p>
        <docs-code [code]="tabs" lang="ts" />
      </docs-section>

      <docs-section title="Presence" id="presence">
        <p>
          An ephemeral side channel. Never persisted, never conflicts, drops when
          a peer leaves. Shape the payload however you like: cursors, selection,
          who is here, or an agent's current activity.
        </p>
        <docs-code [code]="presence" lang="ts" />
      </docs-section>

      <docs-section title="Trust" id="trust">
        <p>
          Pass a <code>policy</code> (and a <code>ctx</code> when it reads
          claims) and the client validates each write before it hits the wire,
          matching the relay's own check. An honest client never emits an op the
          relay would reject, so the tripwire only fires on a broken or hostile
          peer, and an agent can be given a narrower write surface than a human.
        </p>
        <docs-code [code]="trust" lang="ts" />
      </docs-section>

      <docs-section title="Agents" id="agents">
        <p>
          An agent acts under the same protocol as a person. Give it a fork of
          the synced store and its writes stay off the room until a person
          approves: <code>ops()</code> is the staged change as data,
          <code>commit()</code> merges it onto the synced store, and
          <code>discard()</code> drops it. The fork reconciles as the base moves,
          so a proposal stays current while a person reviews it.
        </p>
        <docs-code [code]="agentBranch" lang="ts" />
        <p>
          An agent can also join the room directly, scoped by the relay ACL
          through its <code>ctx</code> and <code>policy</code>. A live agent
          inherits the same conflict rules as everyone else, so a fast agent can
          win a last-writer-wins race on a shared field. Reach for the branch when
          a write should be seen before it lands.
        </p>
        <docs-code [code]="agentPeer" lang="ts" />
        <p>
          See <a mmLink="/docs/mesh/agents">Agents</a> for when to use each and
          how attribution works.
        </p>
      </docs-section>

      <docs-section title="Peer to peer" id="p2p">
        <p>
          <code>webRtcMesh</code> runs the same convergence over WebRTC data
          channels, using the relay only for signaling and membership. Peers
          exchange watermarks when a channel opens and catch each other up
          pairwise. It takes an injectable connector, defaulting to an
          <code>RTCPeerConnection</code> adapter with perfect-negotiation handling
          built in.
        </p>
        <docs-code [code]="p2p" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class MeshClient {
  protected readonly status = `const mesh = meshSync(board, {
  room: 'board-42',
  writer: currentUserId,
  transport: webSocketTransport('wss://sync.example.com'),
  register: 'track', // a reconnect surfaces as pending to a <mm-suspense> boundary
});

mesh.status(); // 'connecting' | 'live' | 'reconnecting' | 'ejected'`;

  protected readonly policies = `import { keyedArray, preserve } from '@mmstack/primitives';

meshSync(board, {
  room, writer, transport,
  policies: [
    { path: 'todos', merge: keyedArray((t) => t.id) },
    { path: 'title', merge: preserve },
  ],
});`;

  protected readonly outbox = `import * as idbKeyval from 'idb-keyval';

meshSync(board, {
  room, writer, transport,
  outbox: { key: 'board-42', store: idbKeyval }, // survives a reload
});`;

  protected readonly whenReady = `meshSync(graph, {
  room, writer, transport,
  outbox: { key: 'graph-7', store: idbKeyval },
  whenReady: () => baseReady, // resolves once the base is filled
});`;

  protected readonly tabs = `import { store, tabSync } from '@mmstack/primitives';
import { meshSync, webSocketTransport } from '@mmstack/mesh';

const board = store<Board>(initialBoard());
tabSync(board, { id: 'board-42' }); // share across this user's tabs
meshSync(board, {
  room: 'board-42',
  writer: currentUserId,
  transport: webSocketTransport('wss://sync.example.com'),
  outbox: { key: 'board-42', store: idbKeyval }, // one tab leads the connection
});`;

  protected readonly presence = `mesh.setPresence({ cursor: [x, y], section: 'pricing' });

const others = mesh.peers(); // [{ writer, origin, data }, ...]`;

  protected readonly agentBranch = `import { forkStore } from '@mmstack/primitives';

const proposal = forkStore(board); // the agent's branch, off the room
runAgent(proposal.store);          // it writes here

proposal.ops();      // StoreOp[] for the reviewer to see
proposal.commit();   // approve: merges onto board, which syncs
// proposal.discard(); // reject: drops the staged writes`;

  protected readonly agentPeer = `meshSync(board, {
  room, writer: agentId, transport,
  ctx: { kind: 'agent', claims: { scope: 'pricing' } },
  policy: pricingScopeOnly,
});`;

  protected readonly trust = `meshSync(store, {
  room, writer, transport,
  policy: myOpPolicy,
  ctx: { kind: 'human', claims: { role: 'editor' } },
});`;

  protected readonly p2p = `import { webRtcMesh, webSocketTransport } from '@mmstack/mesh';

const mesh = webRtcMesh(store, {
  room: 'call-7',
  writer: currentUserId,
  signaling: webSocketTransport('wss://sync.example.com'), // data flows peer to peer
});`;
}
