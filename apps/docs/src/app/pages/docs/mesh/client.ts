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
          <code>preserve</code>.
        </p>
        <docs-code [code]="policies" lang="ts" />
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

  protected readonly presence = `mesh.setPresence({ cursor: [x, y], section: 'pricing' });

const others = mesh.peers(); // [{ writer, origin, data }, ...]`;

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
