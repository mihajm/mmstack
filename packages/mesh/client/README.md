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
  writer: currentUserId, // an opaque principal id, never a display name
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
moved to in the meantime. A relay restart is detected through a room instance nonce, so a stale
sequence number never corrupts state.

`mesh.origin()` is `null` until the session sends hello, then reflects the origin that hello
used. It stays stable across socket reconnects and follows the current op engine when a session
is rebuilt; an outbox restore publishes the new boot's origin, not the origins of replayed writes.
The last announced origin remains available after close. `mesh.members()` lists other relay
origins, including peers that have never published presence. It is empty before welcome and
while disconnected, and updates on welcomes, joins, and departures.

Peer links can share the session's connection directly, without wrapping its transport:

```ts
const origin = mesh.origin();
if (origin !== null && mesh.status() === 'live') {
  const links = peerLinks({
    room: 'board-42',
    origin,
    signaling: mesh.signaling,
  });
}
```

Create links in an injection context (or pass their `injector` option). In a reactive consumer,
create them once per origin and close the previous links if that origin changes. The signaling
port follows socket reconnects without sending a second hello. It buffers up to 256 early
signaling frames for its first listener, clears stale frames on welcome or disconnect, and
retires peer links only when the session ends: a socket drop leaves them up, and the next welcome
says who is still there. Closing the links leaves the mesh session open.

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

`preserve` turns a clash into a `Conflicted` value holding every side that clashed, not just two,
so nothing is silently lost and a resolution is just a later write. See `@mmstack/primitives` for
the full set of merge policies; they are the same ones the store uses for forks and tabs.

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
  room,
  writer,
  transport,
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
client restores the saved queue and resends the unacknowledged writes when it reconnects, each under
the origin it was recorded with. New writes go out under a fresh origin: every boot mints its own. Those offline edits then rebase onto whatever the room
moved to while the tab was gone. The queue is saved on a 300ms debounce; set `debounceMs` to change
it, or `0` to write on every change.

The saved queue is a single-writer slot, and a Web Lock on the key elects its writer. `crossTab` sets
what a second tab on the same key does:

- `'queue'` (default): the second tab waits, with `status()` reading `'waiting'`, until the first
  tab closes, then takes over.
- `'ephemeral'`: the second tab is live at once on its own origin. It never reads or writes the saved
  queue, so its unacknowledged writes are lost if it closes before the room acknowledges them. When
  the lock is free, it takes the lock and behaves like `'queue'`.
- `'off'` skips the lock. Use it when you coordinate ownership yourself, for example a distinct key
  per tab, or leader election over `tabSync`.

When the Web Locks API is unavailable, `'queue'` and `'ephemeral'` log a development warning and run
without the lock, as the owner of the saved queue.

The outbox persists your unacknowledged writes, not a full snapshot. For a meshed store, use it in
place of wrapping the store in `persist`. The two race on boot, and the outbox is the one that
rebases offline edits onto the room. `persist` stays the tool for a store that is only ever local. A
cold offline boot shows the store's initial value plus your restored writes until a welcome arrives.
If you also need to read the last room state while fully offline, assemble it as a base first, below.

The outbox also records the room **generation** the tail was written in (the relay's `instance`
nonce), this device's emission epoch floors and its clock high-water. A relay cuts a generation on
a migration: every write from before the cut is refused, and on the first welcome after a reboot
the client drops such a tail loudly through `onRefused` instead of resending it. A tail written
before any welcome ever named a generation adopts the first one it meets.

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
tab acquires the lock and takes over on a fresh origin, restoring and resending the persisted tail.

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
relay would reject, so the tripwire only ever fires on a broken or hostile peer. When it does
fire, the client ejects itself with the same reason the relay would have used: the local check
saves the room a round trip, but it is an optimization, not the enforcement. The relay validates
every envelope on arrival no matter what the client claims to have checked.

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
`agentSeat` gives it a seat anywhere JavaScript runs, with no Angular and no browser APIs: a Node
service, a worker, an edge runtime. A seat is one identity holding its own live replica; for
several agents in one room (one drafting, one reviewing), open several seats and scope each with
the relay policy. Roles are a policy question, not an API one.

### A seat at the table

```ts
import { agentSeat, describeOp, webSocketTransport } from '@mmstack/mesh';

const seat = agentSeat(initialBoard(), {
  room: 'board-42',
  writer: agentId, // an opaque principal id, like any peer's
  transport: webSocketTransport('wss://sync.example.com'),
  ctx: { kind: 'agent' },
});

seat.snapshot(); // the current document, plain data
seat.changes((e) => {
  if (e.kind === 'change') {
    activity.push(...e.ops.map((op) => describeOp(op, e.writer)));
  }
});
seat.setAtPath('tasks.t1.done', true); // a direct write, attributed like any peer's
seat.setPresence({ name: 'Scribe', kind: 'agent' });
```

`seat.doc` is the same signal store `meshSync` replicates in the browser, so computeds and reactive
reads work as usual. `setAtPath` takes the dot paths a tool-calling model naturally produces.
Reconnection, delta resume, and offline rebase behave exactly as in `meshSync`; the two are shells
over one session implementation.

### Review a branch

An agent's write is a sample that can be wrong, so the safe default keeps it behind a person's
approval. `seat.fork()` (and `mesh.fork()` in the browser) gives the agent an isolated branch of
the synced store. Its writes stay on the fork, so nothing reaches the room until someone approves.
`ops()` is the staged change as data, ready to render for review. `commit()` emits it to the room;
`discard()` drops it.

```ts
const proposal = seat.fork(); // the agent's isolated branch, off the room
setAtPath(proposal.store, 'plan.endDate', '2026-10-11'); // it writes here

const staged = proposal.ops(); // StoreOp[] for the reviewer to see
proposal.commit(); // approve: emits as concurrent writes to the room
// proposal.rebase();          // re-observe the room, then commit on top
// proposal.discard();         // reject: drops the staged writes
```

The commit cites what the fork observed when it forked, so an edit that lands on the room while a
person reviews stays a concurrent value the merge policy decides, never silently overwritten by the
approval. Call `rebase()` to re-observe the room first when the proposal should apply on top of the
latest. The reviewer reads and writes normal store values, and the agent never touches the room
directly. This is the fit when a write should be seen before it lands.

### Feed the model diffs, not the world

Room state and the model loop meet at two calls. `stableSnapshot()` returns the document stamped
with the relay sequence number it is provably the fold of, or `null` while one of the seat's own
writes is still in flight. A non-null result is byte-stable for its seq: rebuilding the room at
that seq yields exactly this document, which is what makes it safe to put in a provider prompt
cache. `changes` then delivers everything after that seq in order, so a prompt becomes a cached
prefix plus an append-only suffix, and each turn sends only what happened since.

```ts
let base = seat.stableSnapshot(); // { seq, doc } | null
const sinceBase: string[] = [];

seat.changes((e) => {
  if (e.kind === 'change') {
    sinceBase.push(...e.ops.map((op) => describeOp(op, e.writer)));
  } else {
    // 'resync': the seat rejoined past the relay's retention, the suffix no longer
    // extends the stream. Rebuild: take a fresh base, drop the accumulated lines.
    base = null;
    sinceBase.length = 0;
  }
});

// per model turn: refresh the base on your own cadence (message velocity, context size)
if (!base || sinceBase.length > 200) {
  const next = seat.stableSnapshot();
  if (next) {
    base = next; // new cached prefix
    sinceBase.length = 0;
  }
}
```

The seat carries no model code and no provider dependency. Its reads and writes are plain
JSON-shaped functions, so they wrap directly into any tool-calling loop, for example the
[`ai`](https://www.npmjs.com/package/ai) SDK:

```ts
import { setAtPath } from '@mmstack/mesh';
import { tool } from 'ai';
import { z } from 'zod';

const propose = tool({
  description: 'Stage edits for human review.',
  inputSchema: z.object({
    rationale: z.string(),
    changes: z.array(z.object({ path: z.string(), value: z.unknown() })),
  }),
  execute: async ({ rationale, changes }) => {
    const fork = seat.fork();
    for (const c of changes) setAtPath(fork.store, c.path, c.value);
    openProposals.set(stageForReview(fork, rationale), fork);
    return 'staged for review';
  },
});
// approval, wherever it happens in your UI: fork.commit() or fork.discard()
```

### Write as a peer

A trusted, in-scope agent can also write to the room directly, scoped by the relay ACL. Give it a
narrower `ctx` and a `policy`, and the relay ejects any write outside its scope (see
[Trust](#trust)). The options are the same on `agentSeat` and `meshSync`.

```ts
agentSeat(initialBoard(), {
  room: 'board-42',
  writer: agentId,
  transport,
  ctx: { kind: 'agent', claims: { scope: 'pricing' } },
  policy: pricingScopeOnly,
  onEject: (reason) => log.warn('agent ejected', reason),
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

## Knowing a write landed

`health` and `status` describe the connection. They do not answer "is what I wrote in the room",
and a live socket with an unacknowledged tail answers no. Two members do:

```ts
mesh.acked(); // signal: every local write is acknowledged
await mesh.whenAcked(); // resolves when the tail empties
```

`whenAcked()` resolves immediately when nothing is outstanding and rejects with the terminal reason
if the session is ejected or closed while writes remain — those never reached the room, so every
later call rejects the same way and `acked()` stays `false`. Await it before publishing anything
that has to contain every edit; against a relay whose adapter confirms durability before echoing,
acknowledged also means stored. `agentSeat` exposes the same pair as plain functions.

The relay answers every write it neither echoes nor ejects, so the tail is always classified one
round trip after a welcome. A resend of a write the room already holds comes back as `duplicate`,
which is the acknowledgement. A refusal — `generation` (written before a cut), `schema` (an older
data shape), `order` (a version this origin never had admitted, which only a second tab on one
origin can produce) — means the write is not in the room and never will be: the client hands the
envelope to `onRefused` (its values are inside, so you can offer to write them again), rehydrates
from a fresh snapshot so the store shows the room, and rejects any pending `whenAcked()` with
`refused: <reason>`. `health().refusedWrites` counts them. "Every write was classified" and
"every write was stored" are different questions; `whenAcked()` answers the second.

## Schema versions

The data shape a room holds is a third version axis next to `proto` and `policyVersion`. Additive
changes need no version at all: new fields fold in, and a client ignores fields it does not render.
For a breaking change, pass `schemaVersion` and migrate through the log.

```ts
meshSync(store, { room, writer, transport, schemaVersion: 2 });
```

A migration is an envelope: a privileged writer (run from your deploy) emits a root set carrying the
new `schemaVersion`. The relay bumps the room's schema and its instance nonce, so every watermark dies and
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

It is a topology of its own, without a relay's admission: no sequence, no generation, no
refusals. Do not run it beside a relay-backed `meshSync` over the same document. If a peer channel
ever carries document envelopes next to a relay, the rule is that a peer hands on only envelopes
the relay has sequenced, never its own unacknowledged writes: a sequenced envelope arriving early
is the relay's delivery arriving early, while an unacknowledged one that the relay then refuses,
or never sees, leaves the receiver showing a write the room does not hold. Ephemeral traffic that
is not document state (cursors, presence) is outside this rule.

```ts
import { webRtcMesh, webSocketTransport } from '@mmstack/mesh';

const mesh = webRtcMesh(store, {
  room: 'call-7',
  writer: currentUserId,
  signaling: webSocketTransport('wss://sync.example.com'), // data flows peer to peer
});
```

### Pointers and other frame-rate values

`rtcPresence` is for values that change many times a second and only matter while they are
fresh: pointer positions, viewports. Each peer publishes one value; every other peer sees the
latest one per sender. Frames go peer to peer over a lossy, unordered data channel, because a
pointer that waits for a retransmit is already stale. Nothing is persisted and nothing is caught
up: a peer that connects sees a sender's value when that sender next moves.
Nothing is minted while no link carries the channel: a sender alone costs no frames, no numbers
and no timers.

It rides on `peerLinks`, the link layer `webRtcMesh` is built on: one peer connection per remote,
set up from the relay's membership and negotiated over its `signal` frames, carrying the labelled
channels you ask for. Put `presenceChannel` in the links' channels.

```ts
import {
  peerLinks,
  presenceChannel,
  rtcPresence,
  webSocketTransport,
} from '@mmstack/mesh';

const links = peerLinks({
  room: 'call-7',
  origin: tabId, // one origin is one seat; give every tab its own
  signaling: webSocketTransport('wss://sync.example.com'),
  channels: [presenceChannel],
});
const pointers = rtcPresence<{ x: number; y: number }>(links, {
  roster: links.onMembers,
});

pointers.set({ x, y }); // throttled; the first value of a burst goes out at once, the last one lands
pointers.peers(); // Map of origin to its latest value
```

A document mesh and pointers can share one peer connection: ask `webRtcMesh` for the extra
channel and hand its links to the presence.

```ts
const mesh = webRtcMesh(doc, {
  room: 'call-7',
  writer: userId,
  signaling: webSocketTransport('wss://sync.example.com'),
  channels: [presenceChannel],
});
const pointers = rtcPresence<Point>(mesh.links, {
  roster: mesh.links.onMembers,
});
```

The mesh picks a random replica origin per instance unless you pass `origin`; either way
`mesh.origin` is the key other peers see this side under, and the seat rule below applies.

A receiver takes its order only from causality it can observe, never from clocks or from
numbers chosen by different senders. It holds a value only for an origin in the roster, the
relay's list of who is in the room, and drops that value as soon as the origin leaves: a peer
link can outlive a dead socket for a while, so the link is not proof that anyone is there.
Within one link the highest `seq` wins and anything at or below it is dropped: one counter
stamps every frame sent on that link in send order, so a lower `seq` was sent earlier. The link
is the epoch: a link that opens or closes starts its origin fresh, and a frame of an old link
cannot arrive on a new one. The counter belongs to the links and the channel, not to the sender,
so a sender closed and recreated on the same links carries on where the last one stopped and is
heard at once. A new tab or device is a new link, which every receiver already treats as fresh.

One origin is one seat. When a second connection arrives with the same origin the relay hands it
the seat and tells the room about a plain join, so the links tell seats apart by instance: every
link announces a random instance id in its signals and, once it knows the instance across,
addresses its signals to it. A signal addressed to an instance a side no longer has is dropped as
a retired link's leftovers. An unaddressed signal from an instance other than the linked one is a
new seat, and the receiving side rebuilds its end, addressed, which settles it: only unaddressed
signals cause a rebuild, and a rebuilt end never sends one. Two tabs sharing an origin still take
the seat from each other every time one reconnects, so give each tab its own origin.

To share a connection someone else already holds, such as a `meshSync` session, pass a
`SignalingPort` (`send`, `onMessage`, and `members()` over that connection) as `signaling`.
`members()` returns the current relay roster for the room, or `undefined` until welcomed;
the owner must keep it current even before the links subscribe. This lets links negotiate with
existing members when attached after the welcome. Pass the connection's origin to the links;
they never send a hello of their own.

For an external presence roster, pass a subscription function as `roster`. It must synchronously
emit the current origins and every subsequent membership transition, and return an unsubscribe
function. Do not adapt a signal using an effect: a leave and rejoin can be coalesced into one
snapshot, losing the evidence that the previous value must be forgotten.

### Reachability

The library ships no ICE servers: it contacts no third party unless you tell it to. Without any,
browsers hide host addresses behind mDNS names, so links only form between peers on the same
network segment. Give them servers in one of two ways: a static `RTCConfiguration` passed to
`rtcPeerConnector(config)`, or a list the relay issues in every welcome through its
`iceServers` option, which replaces the static list for every link built after that welcome.
TURN credentials are short-lived and belong to the operator, so the option also takes a function
of the room and the origin, called at each welcome to mint fresh ones. A link rebuilt long after
its welcome still uses that welcome's credentials, so choose a lifetime longer than a session.

```ts
const relay = createRelay({
  iceServers: (room, origin) => [
    { urls: 'turn:turn.example.com', ...mintTurn(room, origin) },
  ],
});
```

### Recovery

A link that does not open every channel within `openTimeoutMs` (15 s), loses a channel, or is
reported gone by its connector is dropped and rebuilt, for as long as the relay lists its origin.
The WebRTC connector first tries one ICE restart when ICE fails, or stays disconnected for
`disconnectGraceMs` (5 s). Rebuilds wait a jittered backoff that doubles from `retry.minMs` (1 s)
to `retry.maxMs` (30 s) and never gives up; a welcome or a join rebuilds at once. Either side may
rebuild: its new instance announces itself, and the other side rebuilds its end to match, as for
a new seat. Links are built only after the welcome of the connection they signal over, so every
link carries that welcome's ICE servers. `links.stalled()` lists the members whose link was lost and has not opened again; with
`peers()` it tells an open link, a first attempt, and one that keeps failing apart.
