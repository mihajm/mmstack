import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-mesh-overview',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Mesh"
      experimental
      pkg="@mmstack/mesh"
      lead="Multiplayer for signal stores. meshSync replicates a store across clients through a relay, and a synced store reads exactly like a local one: synchronous, no new nullability, no callbacks in your components. Connection state surfaces through a status signal and the transition scope, never as an exception from a read."
    >
      <p>
        The relay is
        <a mmLink="/docs/primitives/sync">the op protocol</a> from
        <code>&#64;mmstack/primitives</code>, put on a wire. A client emits one
        small operation per change; the relay assigns each a sequence number and
        fans it out. The relay understands nothing about your data, so it stays a
        dumb pipe while the clients stay smart. Conflict resolution happens per
        path on the client, so two people editing different fields of one record
        never collide.
      </p>

      <docs-code [code]="install" lang="bash" />

      <docs-section title="Two packages" id="packages">
        <p>
          <code>&#64;mmstack/mesh-protocol</code> is the relay and the wire
          types. It has no dependencies and runs on Node, Bun, or a Cloudflare
          Durable Object, because it never touches a socket or a clock directly.
          You inject those and supply the authenticated principal.
          <code>&#64;mmstack/mesh</code> is the Angular client.
        </p>
      </docs-section>

      <docs-section title="Syncing a store" id="sync">
        <p>
          Write to the store like any other. Local changes emit to the relay,
          remote changes fold in, and both sides converge. See
          <a mmLink="/docs/mesh/client">the client</a> for conflict policies,
          presence, reconnection, and peer-to-peer.
        </p>
        <docs-code [code]="sync" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class MeshOverview {
  protected readonly install = `npm install @mmstack/mesh @mmstack/mesh-protocol`;

  protected readonly sync = `import { store } from '@mmstack/primitives';
import { meshSync, webSocketTransport } from '@mmstack/mesh';

const board = store<Board>(initialBoard());

const mesh = meshSync(board, {
  room: 'board-42',
  writer: currentUserId,          // an opaque principal id, never a display name
  transport: webSocketTransport('wss://sync.example.com'),
});

board.title.set('Renamed'); // replicates to every client in the room`;
}
