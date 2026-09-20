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
  proto: number; // wire format version
  origin: string; // the emitting log instance (one per tab or device)
  writer: string; // the authenticated principal (a person or an agent)
  version: number; // per-origin counter, for gap detection
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
  policy: myOpPolicy, // optional, see below
  limits: { maxOpsPerEnvelope: 1024, maxEnvelopesPerSecond: 50 },
  journalLimit: 1000, // envelopes kept for delta catch-up before compacting into register state
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
invalid op the relay sees is a broken or hostile peer, so the relay ejects the offender rather
than trying to repair the stream. How far that reaches is the relay's `ejection` option:
`'writer'` (the default) blacklists the writer in that room for the relay's lifetime, closing
every connection it holds and refusing every later hello; `'connection'` closes only the
offending connection, leaves the writer's other connections live, and admits a fresh,
re-authenticated one. Use `'connection'` so one bug in one tab cannot lock a human out until
a restart. Authentication alone does not prevent abuse: a hostile authenticated writer can
obtain fresh connections after each ejection.

Neither ejection scope provides denial-of-service protection. The adapter must limit connection
attempts, concurrent connections, payload sizes, and incoming messages of every type before
expensive parsing or relay processing. Keep principal-level budgets and temporary abuse
cooldowns across reconnects; apply pre-authentication limits at the HTTP/transport boundary,
including any endpoint that issues connection tickets. Bound outgoing buffers for slow readers.
Distributed deployments need shared enforcement or coordinated quotas, and upstream protection
for floods that exceed the application's capacity.

`limits.maxEnvelopesPerSecond` is an optional token bucket per writer **per room**, with a burst
of twice the configured rate. It survives reconnects while the room is retained, but is not a
connection or ingress limit: hello, presence, and signaling messages bypass it, and envelope
validation runs before it. Configure it as an operation budget alongside adapter protections.

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

### Rules that need to know the room is empty

Every hook takes the room name and a trailing `info: PolicyRoomInfo` — `{ seq }`, the room's
sequence **before** this envelope is given one, so `0` means the envelope is the room's first.

The case that needs it is the root. A client joining a room it finds empty seeds it with a `set`
at the root path; that write establishes the document. The identical op on a room already at
`seq >= 1` is something else entirely: a concurrent root sibling that wins the root register by
clock and shadows every leaf that lived only inside the earlier seed's value. So a rule like "an
agent may never write the root" would lock agents out of creating rooms, and "an agent may write
the root" would let one flatten a live document. Only the relay knows which it is:

```ts
const policy: OpPolicy = {
  canWrite: (ctx, path, room, info) =>
    path.length > 0 || ctx.kind !== 'agent' || info?.seq === 0,
};
```

`info` is absent when the caller cannot know the sequence. A client running the same policy
before it emits supplies its own last observed sequence, which can only lag the relay's, so the
emit-side check is at worst more permissive than the relay's — it never refuses an honest write
the room would have taken.

Two boundaries to be clear about. Policy gates writes, not reads: every member of a room sees
the whole root, so the room is the confidentiality boundary, and data with different audiences
belongs in different rooms. A `clear` op counts as a write at its path, so ACLs see a subtree
replace's clear-group like any other write. And because the relay compacts envelopes into
register state, it reads plaintext; end-to-end encryption where the server sees only
ciphertext is incompatible with server-side compaction as designed. Encrypt the transport and
the stored data, but treat the relay as inside the trust boundary.

## Adapter recipes

The relay is pure over injected sockets. These minimal recipes show transport wiring; production
adapters also need the authentication, input validation, and resource limits described above.

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
      {
        send: (m) => server.send(JSON.stringify(m)),
        close: () => server.close(),
      },
      { writer },
    );
    server.addEventListener('message', (e) =>
      conn.receive(JSON.parse(String(e.data))),
    );
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

`onCommit` fires synchronously after every envelope is sequenced and retained, with the
envelope and the room's current `{ seq, instance, checkpoint(), wm, frontier, schemaVersion }`.
Append the envelope to your journal, and checkpoint the register state as often as you like.
`checkpoint()` is a thunk — walking every register is the dominant per-commit cost, so it runs
only when you ask, and it must be called inside the callback because it reads live state:

```ts
const relay = createRelay({
  onCommit: (room, env, state) => {
    journal.append(room, env); // your DB, KV, or DO storage
    if (state.seq % 100 === 0) {
      checkpoints.put(room, { ...state, registers: state.checkpoint() });
    }
  },
});
```

### Telling a client a write is safe

Return nothing and the relay releases the envelope at once — the memory-adapter behaviour, and
the default. Return a **promise** and the relay holds everything that carries that envelope (its
echo, the frontier notice emitted with it, and any welcome answered while it is in flight) until
the promise resolves. Presence, signal, membership and ejection are not document state and always
pass immediately.

```ts
const relay = createRelay({
  onCommit: (room, env) => journal.record(room, env), // resolves once the append landed
  onDurabilityFailed: (room, env, cause) => {
    log.error({ room, seq: env.seq, cause }, 'room stalled');
  },
});
```

This matters because a client takes the relay's echo of its own envelope as proof the write is
safe and drops it from its unacknowledged tail. Echoing before the adapter has stored anything
makes that a lie, the same way returning from `COMMIT` before the log is written would. A
rejected promise **stalls the room**: that envelope and everything queued behind it stay
unreleased and `onDurabilityFailed` fires once. Nothing is un-ingested and nothing is answered
with state that will not survive; recovery is a process restart, after which the writers still
holding those envelopes unacknowledged resend them.

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

Persist `state.frontier` with the checkpoint and hand it back as `snapshot.frontier`. The
frontier is the stamp compaction has settled past; a room that forgets it readmits the very
writes it used to drop, which is how a pruned value comes back from the dead.

`relay.unload(room)` is the other half of the same contract: it drops a quiescent room from
memory, so a relay serving thousands of them holds only the ones somebody is in. It refuses a
room with members and one whose release queue still owes a client a message, so nobody is
dropped mid-answer. Everything else is the adapter's promise — that what the room held is
already on the substrate, and that the name is hydrated from that substrate before it is served
again. The next `hello` for an unloaded name gets a brand-new room at seq 0, so an adapter
without that gate grows a second sequence space into an old journal, and the two then read as
one history.

A room whose durability promise REJECTED is stalled: the failed head stays queued, every later
answer queues behind it, and nothing is released again — including the welcome, so the room
answers nobody. `room(name).stalled` says so, and `relay.unload(room, { discard: true })` is the
adapter's one way out: it drops a stalled room with no members and discards the queue, which is
safe because nothing behind a failed head was ever acknowledged, so every client still holds
what it sent. A queue that is merely pending is refused even with `discard` — a promise that may
yet resolve is not the adapter's to throw away — and so is a room with members. The adapter
then re-hydrates the name from the substrate, which is where the truth was all along.

### Writes the relay refuses without ejecting anyone

Some envelopes are neither valid nor an offence. They are dropped silently and reported through
`onDrop(room, env, reason)`:

| reason       | what happened                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'schema'`   | a straggler stamped with a data shape older than the room's, arriving after a migration — its sender is outdated, not malicious                                                                                                              |
| `'frontier'` | a write stamped at or below the room's compaction frontier. An honest offline writer produces one; every client's own receive gate refuses the same envelope, so the relay refusing it is what keeps the two sides retaining the same op set |

## WebRTC signaling

The relay also routes opaque `signal` messages between peers by origin, which is all a
peer-to-peer topology needs from a server. `@mmstack/mesh`'s `webRtcMesh` uses it to negotiate
data channels; the relay itself carries no media and inspects no payloads.
