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

The default is last-writer-wins on a leaf, which drops one side of a true clash on the same field.
For a field where losing a write matters, set `preserve` on its path and resolve the `Conflicted`
value in the UI.

## Interop with other CRDTs

A merge policy is a plain function, so one path can hold another CRDT and merge through that
library. This is the path for rich text or a list where order matters, which this package does not
model itself. Store the encoded document state at the path, and let the policy merge two states:

```ts
import * as Y from 'yjs';
import type { MergeFn } from '@mmstack/primitives';

// the value at `doc` is a base64-encoded Y.Doc state. Use your own base64 helpers,
// since a JSON transport cannot carry a raw Uint8Array.
const yjsDoc: MergeFn = (_ancestor, mine, theirs) => {
  const merged = new Y.Doc();
  Y.applyUpdate(merged, fromBase64(mine as string));
  Y.applyUpdate(merged, fromBase64(theirs as string));
  return toBase64(Y.encodeStateAsUpdate(merged));
};

meshSync(store, {
  room, writer, transport,
  policies: [{ path: 'doc', merge: yjsDoc }],
});
```

A concurrent edit runs the merge, so two people typing at once combine into one document with no
lost characters. A sequential edit already contains the earlier one, so it is taken whole.

The state travels as one value, so the wire cost grows with the document. For a large document, keep
the `Y.Doc` as an opaque leaf your store does not diff, and sync it with the library's own
incremental updates over the same transport. This package syncs the rest of the app state, the
library syncs the document, and the two stay independent.

## Offline and durable outbox

Writes made while disconnected are held locally and sent on reconnect. That queue lives in memory
by default, so a full reload loses any write the room never acknowledged. Pass `outbox` to persist
it:

```ts
import * as idbKeyval from 'idb-keyval';

meshSync(board, {
  room: 'board-42',
  writer: currentUserId,
  transport,
  outbox: { key: 'board-42', store: idbKeyval },
});
```

`store` is any `AsyncStore` (`get`, `set`, `del`), the same interface `persist` takes. On boot the
client restores the saved queue, adopts the origin it used before the reload, and resends the
unacknowledged writes when it reconnects. Those offline edits then rebase onto whatever the room
moved to while the tab was gone. The queue is saved on a 300ms debounce; set `debounceMs` to change
it, or `0` to write on every change.

One origin is driven by one tab at a time. `crossTab` sets what a second tab on the same key does:

- `'queue'` (default) takes a Web Lock on the key. The second tab waits, with `status()` reading
  `'connecting'`, until the first tab closes, then takes over. Exactly one durable writer holds the
  key at a time.
- `'off'` skips the lock. Use it when you coordinate ownership yourself, for example a distinct key
  per tab, or leader election over `tabSync`.

When the Web Locks API is unavailable, `'queue'` logs a development warning and runs without the
lock.

The outbox persists your unacknowledged writes, not a full snapshot. For a meshed store, use it in
place of wrapping the store in `persist`. The two race on boot, and the outbox is the one that
rebases offline edits onto the room. `persist` stays the tool for a store that is only ever local. A
cold offline boot shows the store's initial value plus your restored writes until a welcome arrives.
If you also need to read the last room state while fully offline, assemble it as a base first, below.

## Assemble a base before connecting

Pass `whenReady` to hold the connection until a local base is in place. `meshSync` awaits it before
it connects and before it restores the outbox, so a store filled from another source is ready when
the room welcome arrives and rebases your pending writes on top. The status reads `connecting` while
it waits, so a boundary shows the store as pending.

```ts
meshSync(graph, {
  room: 'graph-7',
  writer: currentUserId,
  transport,
  outbox: { key: 'graph-7', store: idbKeyval },
  whenReady: () => baseReady, // a promise that resolves once the base is filled
});
```

This is the boot order for a worker-owned, meshed, persisted graph. The worker hydrates the base, the
outbox restores this device's offline writes, then the room welcome supersedes the base and rebases
those writes on top. Each source runs in turn instead of racing, so the result does not depend on
which one happened to finish first. A rejected `whenReady` is treated as ready, so a base that fails
to load never holds the connection open.

## Multiple tabs

Run `tabSync` and `meshSync` on the same store to share it across a user's tabs while one connection
carries it to the room. The outbox lock elects the leader, so only one tab holds the relay
connection and the others share state over `tabSync`. A write in any tab reaches the room through the
leader, and a room write reaches every tab through `tabSync`. When the leader tab closes, another
tab acquires the lock and takes over, adopting the persisted origin.

```ts
import { store, tabSync } from '@mmstack/primitives';
import { meshSync, webSocketTransport } from '@mmstack/mesh';

const board = store<Board>(initialBoard());
tabSync(board, { id: 'board-42' }); // share across this user's tabs
meshSync(board, {
  room: 'board-42',
  writer: currentUserId,
  transport: webSocketTransport('wss://sync.example.com'),
  outbox: { key: 'board-42', store: idbKeyval }, // crossTab:'queue' elects one leader
});
```

Each layer is a separate reader on the store's op stream, so they compose without knowing about each
other. A follower tab's `meshSync` stays idle until it holds the lock, so it never opens a second
connection. `tabSync` also takes a `bus` if you want to route over a channel other than the default
`BroadcastChannel`.

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

## Agents

An agent acts under the same protocol as a person: the same envelopes, attribution, ACLs, and undo.
There are two ways to give it write access, for two levels of trust.

### Review a branch

Give the agent a fork of the synced store. Its writes stay on the fork, so nothing reaches the room
until a person approves. `ops()` is the staged change as data, ready to render for review. `commit()`
applies it onto the synced store, which then emits to the room. `discard()` drops it.

```ts
import { forkStore } from '@mmstack/primitives';

const board = store<Board>(initialBoard());
meshSync(board, { room: 'board-42', writer: userId, transport });

const proposal = forkStore(board); // the agent's isolated branch, off the room
runAgent(proposal.store);          // it writes here

const changes = proposal.ops();    // StoreOp[] for the reviewer to see
proposal.commit();                 // approve: merges onto board, which syncs
// proposal.discard();             // reject: drops the staged writes
```

The fork reconciles as the base moves, so a proposal stays current while a person looks at it. The
reviewer reads and writes normal store values, and the agent never touches the room directly. This
is the fit when a write should be seen before it lands.

### Write as a peer

An agent can also join the room directly, scoped by the relay ACL. Give it a narrower `ctx` and a
`policy`, and the relay ejects any write outside its scope (see [Trust](#trust)).

```ts
meshSync(board, {
  room: 'board-42',
  writer: agentId,
  transport,
  ctx: { kind: 'agent', claims: { scope: 'pricing' } },
  policy: pricingScopeOnly,
});
```

A live agent inherits the same conflict rules as everyone else, so a fast agent can win a
last-writer-wins race on a shared field. Reach for the branch when a write should be reviewed, or
when the field carries real weight.

## Health

`meshSync` returns a `health` signal alongside `status`. It composes the connection state and any
reject reason into one value you can render:

```ts
const mesh = meshSync(store, { room, writer, transport });
// mesh.health() -> { status, reason?, lastSyncedAt? }
```

`status` is one of `live`, `offline`, `outdated`, `ejected`, or `degraded`. The useful distinction
is `outdated` versus `ejected`. A versioned reject (the client's `proto`, `policyVersion`, or
`schemaVersion` is behind the room) reports `outdated` with the reason, so you can show an update or
reload prompt instead of a dead connection. A policy tripwire reports `ejected`. `degraded` is the
slot for local problems such as a full storage quota or a dead worker; those are your own signals to
fold in, since `meshSync` only owns the connection side.

## Schema versions

The data shape a room holds is a third version axis next to `proto` and `policyVersion`. Additive
changes need no version at all: new fields fold in, and a client ignores fields it does not render.
For a breaking change, pass `schemaVersion` and migrate through the log.

```ts
meshSync(store, { room, writer, transport, schemaVersion: 2 });
```

A migration is an envelope: a privileged writer (run from your deploy) emits a root set carrying the
new `schemaVersion`. The relay bumps the room's schema and its epoch, so every watermark dies and
clients re-hydrate into the new shape. A client older than the room is rejected with reason
`schema`, and a client already connected when the migration lands stops applying and reports
`outdated`. Because the migration rides the log, a compacted snapshot and `relay.hydrate` are
post-migration by construction, and journal replay stays correct forever.

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
