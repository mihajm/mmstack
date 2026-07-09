# @mmstack/mesh-protocol

> **Experimental.** The API may still change and this package is not yet battle-tested in production. Pin a version and expect some churn.

The wire and room layer of the mmstack op protocol: envelope and message types, an `OpPolicy`
seam with tripwire semantics, and a runtime-agnostic reference relay. Zero dependencies. It
runs in Node, Bun, Cloudflare Durable Objects, or anywhere else, because it never touches a
socket or a clock directly. You inject those.

The Angular client that syncs a signal store over this protocol lives in
[`@mmstack/mesh`](https://www.npmjs.com/package/@mmstack/mesh). This package is the piece a
server (or a peer) runs.

```bash
npm install @mmstack/mesh-protocol
```

## What it is, and is not

The op protocol replicates a store as a stream of small structural operations rather than whole
snapshots (the same op-log that backs `@mmstack/worker`). A client emits an `OpEnvelope` per
change; the relay assigns each one a room-scoped sequence number and fans it out. Because the
relay only orders and stores opaque ops, it needs to understand nothing about your data. That
is the point: a smart client with a dumb server.

The relay is deliberately small. It sequences, keeps a journal, retains per-path register
state, answers a joining client with whatever it is missing, routes presence, and enforces an
optional policy. It does not merge, validate schemas, or hold application logic. Conflict
resolution is the client's job: how concurrent writes fold into a value is client-configured
policy, which is exactly why the relay never materializes a value of its own. It retains the
concurrent writes and their supersession watermarks per path, and every client folds that same
register state with its own rules.

## The envelope

```ts
type OpEnvelope = {
  proto: number;         // wire format version
  origin: string;        // the emitting log instance (one per tab or device)
  writer: string;        // the authenticated principal (a person or an agent)
  version: number;       // per-origin counter, for gap detection
  hlc: { p: number; l: number }; // hybrid logical clock, for last-writer-wins ordering
  policyVersion: number; // the room policy this writer validated against
  ops: readonly SyncOp[];
};
```

Each op is a structural `set`, `delete`, or `clear` plus two pieces of causal metadata: `cites`
lists the sibling writes the emitter observed at that path (exactly those get superseded; an
uncited concurrent write survives as a sibling), and `epoch` is the op's precedence term. An op
without citations cannot be merged soundly, so envelopes from another protocol version are
rejected outright rather than silently mixed into a room.

`origin` and `writer` are separate on purpose. Two tabs of one signed-in user share a `writer`
but differ by `origin`. `writer` is a stable, opaque pseudonym: the protocol forbids putting a
real name in the envelope, so a person's display name lives in a mutable directory outside the
journal and erasing them is a directory edit, not a history rewrite. The relay never mints
identity; your adapter supplies `writer` from whatever authenticated the connection.

## The relay

```ts
import { createRelay } from '@mmstack/mesh-protocol';

const relay = createRelay({
  policyVersion: 1,
  policy: myOpPolicy,           // optional, see below
  limits: { maxOpsPerEnvelope: 1024, maxEnvelopesPerSecond: 50 },
  journalLimit: 1000,           // envelopes kept for delta catch-up before compacting into register state
});
```

One sizing note: a subtree replace legitimately emits one `set` plus one `clear` per observed
live descendant register in a single envelope, so a tightened `maxOpsPerEnvelope` must still
accommodate honest clear-groups.

`relay.connect(socket, ctx)` attaches one authenticated connection and returns
`{ receive, disconnect }`. You pump inbound frames into `receive` and call `disconnect` on
close. The `socket` is anything with `send(msg)` and `close()`, so the same relay drives a
`ws` server, a Durable Object, or an in-memory pair in a test.

When a client joins, the relay answers with one of three shapes:

- `up-to-date` when the client already has the latest sequence,
- `delta` with just the envelopes it missed, for a quick reconnect,
- `snapshot` with the room's register state, when the client is too far behind for the journal
  to cover. The client folds the registers with its own merge policy to derive its root, so a
  late joiner ends up with exactly the state (and the supersession knowledge) of a peer that
  saw every envelope. Deletes ride along as tombstone registers, so a late joiner never
  resurrects a removed key.

## Trust: `OpPolicy` and the tripwire

Validation is a pure, versioned function, run the same way on the client (before it emits) and
on the relay (before it accepts). Because an honest client never emits an invalid op, any
invalid op the relay sees is a broken or hostile peer, so the relay ejects that writer for the
rest of the session rather than trying to repair the stream.

```ts
import { pathPrefixAcl } from '@mmstack/mesh-protocol';

const policy = pathPrefixAcl([
  { prefix: ['notes'], allow: () => true },
  { prefix: ['cases', '*', 'plan'], allow: (ctx) => ctx.kind !== 'agent' },
]);
```

`pathPrefixAcl` grants write access by path prefix, and can discriminate by principal, so an
agent peer can be given a narrower surface than a human. It is deny-by-default once any rule
matches a path. For richer rules, write your own `OpPolicy` with `canWrite` and `validate`.
Schema-aware validation (deriving a policy from your data model) composes on top and stays in
your codebase, not here.

Two boundaries to be clear about. Policy gates writes, not reads: every member of a room sees
the whole root, so the room is the confidentiality boundary, and data with different audiences
belongs in different rooms. A `clear` op counts as a write at its path, so ACLs see a subtree
replace's clear-group like any other write. And because the relay compacts envelopes into
register state, it reads plaintext; end-to-end encryption where the server sees only
ciphertext is incompatible with server-side compaction as designed. Encrypt the transport and
the stored data, but treat the relay as inside the trust boundary.

## Adapter recipes

The relay is pure over injected sockets, so an adapter is a few lines of glue.

Node (`ws`):

```ts
import { WebSocketServer } from 'ws';
import { createRelay } from '@mmstack/mesh-protocol';

const relay = createRelay({ policyVersion: 1 });
new WebSocketServer({ port: 8787 }).on('connection', (ws, req) => {
  const writer = authenticate(req); // your auth (the relay never mints identity)
  const conn = relay.connect(
    { send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() },
    { writer },
  );
  ws.on('message', (data) => conn.receive(JSON.parse(String(data))));
  ws.on('close', () => conn.disconnect());
});
```

Cloudflare Durable Objects (a room maps naturally onto an object):

```ts
export class MeshRoom {
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
}
```

## Persistence

Rooms live in memory. That covers dev and single-process deployments, and when the relay
restarts, the first client to rejoin seeds the room from its own local state, so nothing is
lost as long as somebody was online. For durability beyond that, the relay exposes a seam
rather than a storage engine, because the envelope already is the persistence record: an
event-sourced journal is just `register checkpoint + envelopes`, compacted by re-checkpointing.

`onCommit` fires after every envelope is sequenced and retained, with the envelope and the
room's current `{ seq, instance, registers, wm, schemaVersion }`. Append the envelope to your
journal, and checkpoint the register state as often as you like. The relay never awaits it, so
batching and backpressure belong to your adapter:

```ts
const relay = createRelay({
  onCommit: (room, env, state) => {
    journal.append(room, env); // your DB, KV, or DO storage
    if (state.seq % 100 === 0) checkpoints.put(room, state);
  },
});
```

`relay.hydrate(room, snapshot)` restores a persisted room before clients join (relay boot, or
inside a Durable Object's `blockConcurrencyWhile`). It refuses once the room has state or
members, so your load can race a fast client without corrupting a live sequence space:

```ts
const saved = await checkpoints.get(roomName);
if (saved) {
  relay.hydrate(roomName, {
    ...saved, // seq, instance, registers, wm
    journal: await journal.tail(roomName, saved.seq),
  });
}
```

Restoring the persisted `instance` nonce is what lets clients that were connected before the
restart keep their sequence watermark and catch up with a cheap `delta` answer. Omit it and
they fall back to a full snapshot, which is always safe. The optional journal tail is only
there to make those delta answers possible; the room is complete without it.

## WebRTC signaling

The relay also routes opaque `signal` messages between peers by origin, which is all a
peer-to-peer topology needs from a server. `@mmstack/mesh`'s `webRtcMesh` uses it to negotiate
data channels; the relay itself carries no media and inspects no payloads.
