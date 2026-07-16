# NEXT — start here

Single pointer to what to pick up. Update this when the frontier moves; don't let it rot.
Last updated 2026-07-08.

## State of the world

The MV-register / opSync / mesh / worker sync arc is **COMPLETE**: code-complete, adversarially
reviewed (5 lenses), fixed, and documented. Green: primitives 817, mesh-protocol 35, mesh 117,
worker 59; docs build + lint clean. On the single (amended) arc commit on master; working tree
unstaged is current work. Per-invariant status + test paths: `invariants.md` Tier 4 banner. Review
triage: `../WAVE5.5-REVIEW-FINDINGS.md`.

## THE next thing

**Build the connectivity demo.** Fully planned in `demo-plan.md` — reuse the existing relay
(`apps/playground-e2e/src/support/relay-server.mjs`) + the 5 sync routes; the build is: host the
relay (Fly free / $4 VPS), make the relay URL configurable, build one polished showcase page
(cursors + a small board), then the AI branch beat (`mesh.fork()`). Three shippable phases.
FOUR sign-off decisions wait at the top of `demo-plan.md` (relay host, client host, showcase
content, first-cut scope) — answer those, then start Phase 1. Demo build + the mgmt/dev talk prep
are a fresh session (Miha's call on timing).

## How we build features (the standing method — do not skip)

Same rigor as the whole sync arc: **proof and adversarial red-teaming FIRST, impl only after the
proofs are conclusive and asserted.** For each feature: (1) state the design + the semantic choices
explicitly; (2) build a pure reference MODEL and property-prove it (the `precedence-proofs.spec.ts`
pattern — order-independence, the counterexamples that force the design, pinned as permanent oracles);
(3) adversarially red-team the model (independent skeptics per lens, try to break it); (4) only once
the proofs hold do we implement, re-pointing the property tests at the real impl (invariants #14
discipline). A design that would violate a Tier-1 theorem is wrong BY CONSTRUCTION, not by test
failure. This is why the arc converged instead of thrashing; hold it for the authority gate,
migration determinism, and everything below.

## After the demo — near-term features (demand-driven, none block anything)

In rough priority (the first two are what Better/CMMN forces first):
1. **Relay authority admission gate** — enforce "who may override" server-side. Designed, not built:
   `relay-epoch-admission.md`. The teeth behind admin-override / agent-authority.
2. **Migration determinism** — rolling schema upgrades across mixed-version rooms. `evolution.md`;
   the schema floor + migration-reset already shipped, the migrate-through-the-log part remains.
3. **Worker+mesh one-opSync mux** — collapse the two engines so concurrent same-field edits across
   the composition converge without flicker. Roadmap #2; do it when next in worker-store for a real
   workload.
4. **Collaborative text / RGA** — keyed containers do object lists now; character-level text (the
   interleaving case) is out of scope until someone needs a shared rich-text editor.
5. **Server-as-subtree-owner** — server owns a subtree like the worker does. `worker-graph.md`.

## Small hardening (minor, optional)

Concurrency layer (found 2026-07-12 during the Solid deepdive source read):
`concurrency-fix-proposals.md` — startTransaction rollback has zero cooperating writers
(docs over-promise), attributed-pending re-trigger contract unsound (needs a monotone
`loads` counter), overlapping-transaction undo lost-update. Proposals written, [DESIGN]
choices await Miha's ratification.

Mostly closed 2026-07-08. Remaining: dead-origin `versions`/relay `wm` eviction (deferred BY CHOICE —
`versions` doubles as the emit counter, frontier is hlc-keyed, gap-detection risk for O(origins)
integers; the receive-side frontier gate that would make it safe already landed, W4); L3 tighter
min-ack frontier (current frontier is journal-volume-driven, safe); store-leaf debugNames / devtools.
(#22 HLC well-formedness is now ASSERTED; the frontier admission gate landed.)

## Far-horizon (only at mass scale, all additive)

Per-tick coalescing/batch-apply, relay tree (graph of meshes), interest management / partial
replication, binary wire format. Not needed below tens of thousands of concurrent editors per room.

## Hard rules (always)

- No git commit/push unless explicitly asked (Miha amends the single arc commit).
- Docs/READMEs: no AI tells, no em dashes, plain prose.
- Jsdocs are PUBLIC surface: no idea/-file, RFC, or invariant-number references; self-contained.
- Convergence is the non-negotiable (same op set → same state; sets equalize; nothing acked lost).

## Map

- `invariants.md` — canonical rule register (Tier 4 banner = shipped status + test paths).
- `demo-plan.md` — the immediate next.
- `conflict-precedence-and-agent-governance.md` — the design record (MV-register, epoch, deletes,
  cross-path, relay retention).
- `roadmap.md` — sequenced frontier history (arc-complete banner at top).
- `relay-epoch-admission.md` — the authority-gate design note.
- `precedence-proofs.spec.ts` (in packages/primitives/src/lib/store) — the proven model; the spec.
