# Connectivity demo — plan (2026-07-08, for sign-off; build in a coming session)

Goal: a PUBLIC, hosted demo that makes the @mmstack sync story visible — worker + tabSync + mesh
live across real browsers over the internet. Store content is deliberately trivial; connectivity is
the star. Doubles as the spine of the mgmt/dev talk. No new library work needed: the arc is complete.

## What already exists (survey 2026-07-08) — reuse, don't rebuild

- **Relay**: `apps/playground-e2e/src/support/relay-server.mjs` — Node HTTP + `ws` wrapping
  `createRelay` from @mmstack/mesh-protocol. ~zero-dep, port via `RELAY_PORT`, `/stats` endpoint,
  pathPrefixAcl (humans full store, agents scoped to `agent/*`). This IS the hostable relay.
- **Routes (all query-param driven: writer/room/kind)**: `/mesh` (in-page relay), `/webrtc` (P2P +
  rtcPeerConnector), `/mesh-agent` (agent + relay ACL), `/mesh-outbox` (durable outbox + cross-tab
  Web Lock), `/worker-mesh` (worker owns doc, mesh + persist as readers, worker-computed derived
  converges full-stack). `apps/playground/src/app/examples/`.
- **Transports**: `webSocketTransport(url)` (network), `directTransport(relay, ctx)` (in-page),
  `rtcPeerConnector(config)` (P2P). `packages/mesh/client/src/lib/transport.ts`.
- **mesh.fork()** (new this arc): the branch-first seam for the AI beat.

## Gaps to close (the actual build)

1. **Host the relay.** No deploy config today (no Dockerfile/fly.toml/start script). It is a tiny
   stateless-ish Node ws process → a free/cheap tier carries it.
2. **Point the client at the hosted relay.** Routes hardcode `ws://location.hostname:4301`. Make the
   relay URL env/config-driven (build-time or a small runtime config), defaulting to the hosted URL.
3. **A polished showcase page.** The existing routes are functional TEST harnesses, not a demo. Build
   ONE compelling page (shared cursors + a shared board/counter) that reads as a product, not a test.
4. **Client hosting.** Playground is SSR (Hono). For a demo a static CSR build on a free static host
   (Cloudflare Pages / Netlify / the existing GH Pages pipeline) is simplest — it just needs the
   relay ws URL. (SSR is not needed for the demo.)

## Hosting recommendation

- **Relay**: Fly.io free tier or Render free (a Dockerfile + a 10-line start script), or a $4 VPS.
  The relay is the only stateful server bit and it is tiny; in-memory rooms are fine for a demo
  (optionally wire onCommit→disk later, not needed day one). WebRTC route needs a STUN server for
  real cross-network P2P (`stun:stun.l.google.com:19302` is free); the relay carries signaling.
- **Client**: static CSR build on Cloudflare Pages / Netlify free (or GH Pages). One env var: the
  relay wss:// URL.
- Cost: effectively $0–4/mo. Matches the "runs on a cheap box" story that IS part of the pitch.

## Demo beats (the narrative — also the talk outline)

1. **"It just syncs."** Two browser windows side by side, same room. Edit a field in one → appears in
   the other instantly. No spinner, no save button. The reveal: a synced store reads exactly like a
   local signal store. (Reuse the showcase page with `webSocketTransport` to the hosted relay.)
2. **Late join catches up.** Open a third window/device → it hydrates to current state and goes live.
3. **Offline → reconnect, nothing lost.** Toggle a client offline, keep editing, reconnect → the
   queued edits merge, no clobber. (`/mesh-outbox` shows the durable outbox + cross-tab lock.)
4. **Concurrent edits converge (no last-write-wins loss).** Two people edit the same object's
   different fields at once → both survive. Same field with `preserve` → both kept as a conflict to
   resolve. The "provably converges" line lands here.
5. **Worker offload stays in sync.** `/worker-mesh`: the worker owns the doc and computes a
   derivation; a remote edit converges INTO the worker and its computed value updates → sync goes
   full-stack, off the main thread.
6. **Presence / live cursors.** The flashy visual — everyone's cursor moving in real time (ephemeral,
   never persisted, never conflicts).

## The AI beat (the differentiator — build on mesh.fork)

An agent proposes on a branch, a human approves, and the room never loses a concurrent human edit:
- Agent runs against `mesh.fork()` (off the room). Its staged `ops()` render as a reviewable diff.
- A human edits the room meanwhile.
- Human clicks approve → `commit()`. The agent's edit lands as a concurrent write; the human's
  mid-review edit survives (the fold decides, not the approval). `rebase()` shows "apply on top of
  latest" instead.
This is "an agent is a user, confined to a branch you review" made visible. Small build on top of the
showcase page; `/mesh-agent` (relay ACL) is the complementary "trusted agent writes directly" variant.

## Phasing (each phase shippable)

- **Phase 1 (MVP, ~1 session): prove it over the internet.** Deploy the relay; make the relay URL
  configurable; point `/worker-mesh` or a minimal showcase at it; demonstrate two-device live sync +
  late join. This alone is the core story working publicly.
- **Phase 2 (polish, ~1 session): the showcase page.** Shared cursors + a shared board/counter,
  presence, the offline/reconnect beat, concurrent-edit-converges beat. Make it read as a product.
- **Phase 3 (AI beat): the branch-first agent** on the showcase (mesh.fork propose → human approve).

## Talk framing (mgmt / other devs — draft in the coming days)

Arc: (1) the problem — realtime sync is hard, usually a whole backend + a CRDT library + conflict
headaches. (2) the reveal — with @mmstack a synced store is indistinguishable from a local one; you
write signals, it syncs. (3) the substance — offline-first, convergent BY CONSTRUCTION (proven, not
hoped: 800+ tests incl. adversarial + property proofs), worker offload for heavy state, all on a
zero-dep relay that runs on a $4 box. (4) the future — branch-first AI: agents propose, humans
approve, nothing steamrolled. Lead the visual with live cursors; lead the argument with "it just
syncs"; close on the AI branch.

## Open decisions for Miha at sign-off

> RESOLVED 2026-07-09 — see the addendum below; build started this session.

- Relay host: Fly vs Render vs VPS? (recommend Fly free or a $4 VPS.)
- Client host: static CSR on Cloudflare/Netlify/GH Pages vs deploy the SSR playground? (recommend
  static CSR.)
- Showcase content: cursors + kanban board? cursors + shared counter/text field? (recommend cursors +
  a small board — visual and obviously collaborative.)
- Scope for the FIRST public cut: Phase 1 only (prove it), or Phase 1+2 (polished) before showing?

## RESOLVED 2026-07-09 (sign-off + AI-beat design session) — build started

Decisions:
- **Hosting: ONE VPS, one container** ($5-20/mo fine, "tens not hundreds"). Relay, agent seat, and
  static client all served by a single Node process behind Caddy (TLS -> wss). Same-origin kills the
  client-config chicken-and-egg: the client fetches `/config` from the host that served it. No
  separate static host needed.
- **New apps, NOT playground**: `apps/demo` (Angular CSR, static build) + `apps/demo-server` (Node:
  createRelay over ws + static serving + /config + agent seat). Playground stays a test harness,
  never deployed.
- **Env safety (public repo)**: `.env`/`.env.*` now gitignored (`.env.example` committed).
  ANTHROPIC_API_KEY etc. are server-only; the client receives ONLY a whitelisted `/config` JSON via
  appInitializer.
- **Deps**: `@anthropic-ai/sdk` only (installed). No Vercel AI SDK / TanStack AI — one provider, no
  streaming-UI needs, plain tool-use loop. Model: claude-opus-4-8, adaptive thinking, prompt caching
  on the stable system prompt. Billing: Miha's personal Console API key in `.env`.
- **Showcase surface**: one structured doc serving every beat — an event/project plan (title,
  start/end dates, budget line items + total, task list with owners). Visual enough for cursors and
  concurrent edits, semantic enough for the agent to catch real mistakes (end < start, line items
  not summing to total, unassigned task).
- **Scope**: phases 1-2 are the first cut; phase 3 (AI) lands before the management showing.

AI beat design (supersedes the sketch above):
- **Agent = a headless Node peer**, not a browser widget (the API key can't ship in a CSR bundle —
  the constraint that makes "an agent is a user" literal). Lives in the demo-server process,
  connects via webSocketTransport like any client. The demo seat gets full-store write (the
  confinement story here is fork + human approval; /mesh-agent's ACL scoping stays as the
  complementary variant).
- **Active/reactive, primed**: user primes it once ("flag mistakes, propose improvements"), then it
  watches. Quiescence trigger: buffer ops, wake after ~2-3s settle + min interval + only for
  non-trivial deltas. Per wake it picks one tool: propose(changes, rationale) / comment(text) /
  pass — the explicit `pass` is what keeps it watchful-but-quiet.
- **Prompt shape**: system (role + doc schema + how narrated ops read; cache_control) + priming +
  CURRENT state snapshot + English-narrated ops since last wake + open/dismissed proposals.
  Snapshot+delta keeps prompts bounded (never ops-since-hydrate). Narration is a trivial renderer
  over the op shape ("user A set budget.total to 500").
- **Proposals/chat/priming are synced state under `agent/*`** — no bespoke RPC. A proposal is
  {narration, staged ops, status}; humans render the diff; approve flips status -> the agent sees it
  and commit()s its fork (a human's concurrent mid-review edit survives — the beat); dismiss ->
  status dismissed, and dismissed proposals stay in agent context so it never re-proposes the same
  fix.
