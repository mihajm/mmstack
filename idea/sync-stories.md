# Sync stories — where this goes after the demo

**Status:** prep notes 2026-07-13, for the "what is this actually for" conversation with the
tech lead. Grounded in the live demo (mmstack-demo.duckdns.org) and the op-protocol creed
(op-protocol-rfc.md §0, currently in idea-vault history). The demo is the evidence anchor for
every story below: everything named here ran on the public @mmstack packages, on a 6 EUR box,
verified with real concurrent users and a real model in the agent seat.

## What the demo actually proved (capability → substrate property)

- Concurrent edits converge deterministically — MV-register precedence, proven core, and the
  one "divergence" report from real users traced to a browser date-widget quirk, not the sync
  layer (the relay log showed one totally-ordered history every peer agreed on).
- Presence (who is here, who is editing which field) rides the same channel as state.
- Offline edits queue in an outbox and merge on reconnect; late joiners hydrate to current
  state instantly.
- Every mutation is a narrated, attributed op — the ticker is a free audit trail.
- An agent joins as a governed peer: it stages edits on a fork, nothing lands without human
  approval, and its identity is on every op. Headless seat is ~150 lines, no Angular.
- Schema governance works at the door: relay rejects hellos on policyVersion mismatch.

## Story 1 — the CMMN case is a synced document, the engine is just another writer

This is the mapping already redlined in the RFC: case file = attributed synced subtree,
envelope journal = case audit, sentries = computeds over synced state, milestones = derived
state, discretionary items = human-or-agent peers under OpPolicy, planning = branches. The
primer below is what those words mean; the walkthrough after it is how they run.

### CMMN, just enough to read the mapping

CMMN is BPMN's data-driven sibling. BPMN prescribes sequence (do A, then B, then a gateway);
CMMN assumes knowledge work has no fixed sequence — which tasks happen, and when, depends on
the state of the case data and on human judgment. The model is a bag of possible work plus
rules for when each piece becomes available:

- **Case file** — the data the case revolves around (structured items plus documents). It is
  a first-class model element, and the spec's execution semantics are literally driven by
  change events on it: caseFileItem created/updated/replaced/deleted are standard event
  types. Every engine has to manufacture that event stream somehow; an op log IS that
  stream, already attributed.
- **Sentry** — a guard on a task, stage, or milestone saying when it may start (entry
  criterion) or must stop (exit criterion). Two parts: an on-part (an event — "item X
  updated", "task Y completed") and an if-part (a boolean over case file data —
  "hemoglobin < 7"). On-part fires while the if-part holds → the guarded item activates or
  terminates. That is precisely a reactive condition over case data: the if-part is a
  computed over the synced doc, and the on-part arrives for free as ops land. No polling, no
  event-bus glue.
- **Milestone** — a plan item with no work in it: a named sub-goal that "occurs" when its
  entry sentry fires ("diagnosis established", "all documents received"). Pure derived
  state; the only imperative bit is recording the occurrence, which is one op with the
  engine's identity on it.
- **Discretionary items** — CMMN's signature feature: tasks in the model that are NOT
  automatically in play. They sit in a planning table, and at runtime a human case worker
  decides to plan them into the running case ("add a nutrition consult for this patient").
  Planning is a participant's decision, not the engine's — so it is an attributed write, and
  who may plan what is an ACL question, i.e. OpPolicy.
- **Planning** — weighing a plan change before committing it maps to a fork: stage the added
  items, get sign-off, merge. Same machinery the agent seat already uses.

### How a case actually runs on the substrate

A case is not a row the engine owns and others poll. It is a live document every participant
holds a converging replica of: the case file plus a small plan-state subtree (which plan
items are active/completed — the doc-side mirror of execution progress). Ward screens, the
coordinator's dashboard, and the engine's headless seat all join as peers; opening a case is
one hydration handshake, not a fan-out of GETs.

Walk one case end to end. A lab result lands — a device integration, which is just another
writer with an identity. The op merges on every replica; on the engine's replica the
"transfusion review" entry sentry, a computed with if-part hemoglobin < 7, flips true. The
engine activates the task, and that activation is itself an op ("engine set plan item X
active"), so every screen shows the task appear with no push-then-refetch choreography — and
the journal already reads causally: lab wrote the value, engine reacted, both attributed,
one total order every peer agrees on.

A nurse completes the task mid ward round with no connectivity; the completion op waits in
the outbox and merges on reconnect. Its arrival satisfies the "treatment reviewed" milestone
sentry, the milestone occurs, downstream sentries cascade — data-driven, nothing ticking on
a timer. Meanwhile the consulting physician plans a discretionary "nutrition consult" from
the planning table: staged as ops (on a fork where governance wants sign-off), admitted or
refused by OpPolicy, attributed to the physician, not to the engine. When a decision has to
be walked back, compensation is invertBatch over the recorded ops, not a bespoke
compensation framework. And because the engine writes through the same door as everyone
else, the audit trail is complete by construction — there is no privileged path it could
have bypassed the journal through.

Every beat of that walkthrough is a demo-proven property wearing case-management clothes:
convergence, attribution, outbox, late-join hydration, governed forks.

Why this beats status quo: the usual engine integration is websocket-push-then-refetch with
hand-rolled conflict handling per screen. Here state IS the protocol; screens are ui = fn(state).

### With Temporal in the picture (the current CMMN demo build)

The current CMMN demo workflow is being built on Temporal. That is not competition for this
substrate — it is the other half of the creed's split, arriving on schedule: Temporal is an
excellent imperative shell (durable execution, retries, timers, SLAs, long-running
orchestration survive restarts for free), and a weak state/collaboration plane (UI liveness
means queries plus polling, there is no attribution model, no conflict semantics, and one
writer per workflow). The division of labor writes itself:

- **The case file lives in the mesh room**: attributed, synced, offline-capable, per-field
  conflict policy, presence — everything the screens and humans need.
- **The Temporal workflow orchestrates**: one workflow per case holds timers, retries,
  escalations, and activity execution. It holds orchestration state only; case DATA never
  forks into workflow variables. That discipline is the whole integration contract — one
  source of truth for data (the doc), one for execution progress (the workflow history).
- **The bridge is the agent-seat pattern**: a Temporal worker joins the room as a headless
  peer (the injector-free seat from the demo, verbatim), forwards relevant op batches to the
  workflow as signals, and commits workflow decisions back as ops under an "engine" writer
  identity. Sentries evaluate as computeds in the bridge over the synced doc — workflow code
  stays deterministic and thin, and never needs to poll for data conditions.
- **Two audits, cleanly split**: Temporal's event history answers "what did the engine
  execute, when, with what retries"; the envelope journal answers "who changed what in the
  case, in what order". Together that is the full CMMN audit story.

One integration nuance to have ready: real CMMN sentries react to lifecycle events ("task Y
completed") as well as data changes. Task lifecycle lives in the workflow, so the bridge has
to reflect those transitions into the plan-state subtree as ops — otherwise the data-side
sentries can't see them. That is the discipline restated, not an exception to it: any state
a sentry reads belongs in the doc, and workflow variables are never its only home.

The pitch to the lead: nobody should rebuild durable timers on the mesh, and nobody should
rebuild collaboration, attribution, and conflict policy on Temporal. The op stream is also
exactly the data-change event source a declarative CMMN model needs to drive sentries —
Temporal alone has to manufacture those events; here they already exist, attributed.

## Story 2 — the MDT board (the demo wearing scrubs)

A tumor board or discharge planning session is the event-plan demo with higher stakes:
several clinicians and a coordinator on one plan, presence rings showing who is in which
field, the ticker narrating changes as they land. The differentiator is per-field conflict
policy: most fields can auto-converge (last-writer semantics are fine for a phone number),
but safety-critical fields — allergy status, medication decisions — use the preserve
resolver, so a genuine concurrent disagreement surfaces both values and forces a human
choice instead of silently picking a winner. The demo's title field shows exactly this UX.
Nobody ships that per-field nuance on top of a generic websocket sync; here it is one line
of policy per path.

## Story 3 — openEHR/FHIR at the edge: many writers, one truth

Compositions and resources are touched by more than clinicians: device feeds, lab results,
integrations, batch imports. Each of those is naturally a writer with an identity, and
convergence with attribution is exactly what the substrate does. Two concrete shapes:

- Reactive reads: a form bound to a composition updates live as results land — sync-at-read,
  no refetch choreography, and the late-joiner hydration means opening a chart is one
  handshake, not a fan-out of GETs.
- Reconciliation as proposals: an inbound external FHIR resource does not blind-overwrite
  local state. Its diff is staged the way the agent stages edits — a fork with a rationale,
  approved or dismissed by a human. Same mechanism, different writer. Interop review stops
  being a bespoke merge screen and becomes the already-built proposal UX.

## Story 4 — the governed agent seat ("an agent is a user")

The creed's fourth pillar is the healthcare story. An AI scribe, coding assistant, or
completeness checker joins the room as a peer: same attribution, same ACLs (OpPolicy), same
undo as a human. It cannot write to the record; it can only stage a fork with a rationale,
and the audit shows which agent proposed what, and which human approved it. That posture —
AI suggests, human disposes, everything attributed — is the one regulators and clinical
governance actually accept, and we did not build it specially for AI: it is the same
branching machinery users get.

The demo proved the whole loop with a real model: watch the room, propose a fix for an
inconsistent date, get approved by a different user than the one who triggered it, survive a
concurrent human edit, answer in chat, leave. Inside a CMMN case the same seat is a
discretionary-task performer: "draft the discharge summary" as a planned item an agent picks
up, executes on a branch, and hands back for sign-off.

## Story 5 — phase 2: app-builder exposes the layers to its users

Today the obvious studio application is buildtime: collaborative canvas in the form/app
builder. Phase 2 inverts it: collaboration becomes a capability of the apps people build,
not just of the builder. Concretely: a "shared" toggle on a form or section in the builder;
the generated app wires meshSync with the right policies (which fields preserve conflicts,
which auto-converge); rooms and ACLs provisioned per tenant on a relay we or they host (the
relay is zero-dep and the whole demo server is one small Node process, so self-hosting is a
real option, not a slide). Presence, the audit ticker, offline, and optionally an agent seat
come along for free because they are substrate properties, not features per app.

That turns "our builder has multiplayer" into "apps built with our platform can be
multiplayer, attributed, and agent-ready" — a capability their customers cannot easily get
elsewhere, and one we have already de-risked end to end in public.

## Sequencing notes (phase 2 prerequisites, roughly ordered)

1. Policy authoring UX in the builder (per-path resolver choice, safe defaults).
2. Room/ACL provisioning story per tenant (the relay's OpPolicy seam exists; the admin
   surface does not).
3. Persistence beyond in-memory rooms (journal store behind the relay; demo deliberately
   skips it).
4. Collaborative-safe undo (storeHistory needs meshSync to expose the local envelope
   stream — known small API addition, parked during the demo build).
5. Agent seat as a packaged opt-in (the injector-free seat pattern from the demo, productized).
