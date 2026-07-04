# @mmstack/mesh

> **Experimental.** The API may still change and this package is not yet battle-tested in production. Pin a version and expect some churn.

Multiplayer for `@mmstack/primitives` signal stores. `meshSync(store, ...)` replicates a store
across clients through a relay, and a synced store reads exactly like a local one: synchronous,
no new nullability, no callbacks in your components. Connection state surfaces through a status
signal and the transition scope, never as an exception from a read.

```bash
npm install @mmstack/mesh @mmstack/mesh-protocol
```

The relay is [`@mmstack/mesh-protocol`](https://www.npmjs.com/package/@mmstack/mesh-protocol),
which has no dependencies and runs on Node, Bun, or a Durable Object. You bring your own socket
and your own auth.

## meshSync

```ts
import { store } from '@mmstack/primitives';
import { meshSync, webSocketTransport } from '@mmstack/mesh';

const board = store<Board>(initialBoard());

const mesh = meshSync(board, {
  room: 'board-42',
  writer: currentUserId,          // an opaque principal id, never a display name
  transport: webSocketTransport('wss://sync.example.com'),
});
```

Write to `board` like any store. Local changes emit to the relay, remote changes fold in, and
both sides converge. `mesh.status()` is `'connecting' | 'live' | 'reconnecting' | 'ejected'`,
and `mesh.peers()` is the current presence roster. When you provide `register: 'track'`, the
store also participates in transition scopes, so a reconnect shows up as `pending` to a
`<mm-suspense>` boundary without any wiring.

Reconnection is automatic, with exponential backoff. On reconnect the client resumes from a
delta when possible, and re-applies any writes made while offline on top of whatever the room
moved to in the meantime. A relay restart is detected through a room epoch, so a stale sequence
number never corrupts state.

## Conflict resolution

By default the latest write to a path wins, decided by a hybrid logical clock so every peer
agrees. Because resolution is per path, two people editing different fields of the same record
merge cleanly. When you need something other than last-writer-wins, attach a policy per path:

```ts
import { keyedArray, preserve } from '@mmstack/primitives';

meshSync(board, {
  room: 'board-42',
  writer: currentUserId,
  transport,
  policies: [
    // reconcile a list by item identity, so concurrent edits to different todos both survive
    { path: 'todos', merge: keyedArray((t) => t.id) },
    // keep both sides of a clashing edit as data instead of dropping one
    { path: 'title', merge: preserve },
  ],
});
```

`preserve` turns a clash into a `Conflicted` value holding both sides, so nothing is silently
lost and a resolution is just a later write. See `@mmstack/primitives` for the full set of
merge policies; they are the same ones the store uses for forks and tabs.

## Presence

```ts
mesh.setPresence({ cursor: [x, y], section: 'pricing' });

// in a component
const others = mesh.peers(); // [{ writer, origin, data }, ...]
```

Presence is an ephemeral side channel. It is never persisted, never conflicts, and drops
automatically when a peer leaves. The payload is yours to shape: cursors, selection, "who is
here", or an agent's current activity.

## Trust

Pass a `policy` and (when your policy reads claims) a `ctx`, and the client validates each write
before it hits the wire, matching the relay's own check. An honest client never emits an op the
relay would reject, so the tripwire only ever fires on a broken or hostile peer.

```ts
meshSync(store, {
  room,
  writer,
  transport,
  policy: myOpPolicy,
  ctx: { kind: 'human', claims: { role: 'editor' } },
});
```

## Transports

- `webSocketTransport(url)` for a relay over WebSocket.
- `directTransport(relay, ctx)` connects straight to an in-process `createRelay`, with no
  network. It is the backbone of the tests, and useful for a single-process demo or an
  SSR-side room.

A transport is a small interface (`send`, `onMessage`, `onClose`, `close`), so wiring a custom
one is a few lines.

## Peer to peer

`webRtcMesh` runs the same convergence over WebRTC data channels, using the relay only for
signaling and membership. Peers exchange watermarks when a channel opens and catch each other
up pairwise. It takes an injectable connector, defaulting to a `RTCPeerConnection` adapter with
perfect-negotiation handling built in.

```ts
import { webRtcMesh, webSocketTransport } from '@mmstack/mesh';

const mesh = webRtcMesh(store, {
  room: 'call-7',
  writer: currentUserId,
  signaling: webSocketTransport('wss://sync.example.com'), // data flows peer to peer
});
```
