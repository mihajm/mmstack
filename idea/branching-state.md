# Branching state: time as a first-class dimension of the store

**Status: CORE BUILT 2026-07-04** (overnight, by composition with the op-protocol L0):
`forkStore` was already the frame-bound view (object identity binds the frame; linkedSignal
reconcile = CONTINUOUS rebase against a live base — stronger than the planned manual rebase).
Added: `Fork.ops()` (inspectable structural delta) and `policyStrategy(policies)` (per-path
ForkStrategy from the shared rebaseOps — lww/mergeThree/preserve on fork↔base conflicts, incl.
Conflicted-as-data on a live base move; spec-pinned). Remaining rungs: undo/redo surface over
invertBatch (mechanical), optimistic-mutation integration, `branch.run()` sugar (deferred —
no named consumer yet, per the seam rule). Originally HIGH-conviction frontier idea
(discussion 2026-07-03).

## The unification

Signals model *now*; everything interesting in modern UX hacks around the missing time
dimension. These are ALL the same operation — fork state, apply speculative ops, then
fast-forward or rebase:

- optimistic updates (a branch that rebases on the server echo)
- transitions (display-time forks — Solid 2.0 does this internally and hides it)
- undo/redo (inverse ops from the log's `prev` values)
- offline queue + replay (a long-lived branch rebased on reconnect)
- collaborative rebase (mesh's local-pending ops ARE an implicit branch)
- "preview this change" / speculative precompute on idle

Ship the fork as a user primitive and five ad-hoc patterns collapse into one. Git vocabulary
is the DX win: `fork` / `commit` / `discard` / `rebase`.

```ts
const branch = store.fork();          // cheap: lazily-vivified, ops-backed
branch.$.pricing.plan.set('pro');     // same store surface, speculative
branch.ops();                         // the delta, inspectable
branch.commit();                      // fast-forward into the base store
branch.discard();                     // or drop it
branch.rebase(remoteOps);             // merge3 per conflicting leaf
```

## What exists (substrate, all shipped)

- `opLog` in primitives/store: echo-free apply, ref-pruned diffs — the delta format.
- `forkStore` + `merge3` (fork-store.ts): fork + 3-way leaf merge already exist in v0 form.
- Single-writer/replica discipline proven across a real boundary (@mmstack/worker): a branch
  is structurally a local replica with unacked ops — the same shape as a mesh client.

## The hard parts (the actual design work)

- **Isolation is contextual, not temporal (Miha's simplification, 2026-07-03).** No hold
  semantics during speculation. `untracked` is a frame-stack op on the who's-watching axis;
  branches add the same push/run/pop discipline on a which-reality axis. Two rules:
  1. **Frame binds at creation for reactive consumers**: `branch.$.path` returns view
     accessors closed over the frame handle (ambient-at-read-time would leak — a computed's
     re-execution happens outside the scope and would read base). Effects/computeds see the
     frame they were created under; app effects are base-bound so speculative values never
     reach them, by construction.
  2. **`branch.run(fn)` is sync-only sugar** for running existing base-written derivation
     code against a branch without threading a store parameter. Pops synchronously; a
     post-await read sees base — same contract as the telemetry span stack (§8.2). Third
     appearance of the house pattern: sync stack + explicit handle across async, no zones.
  Holds re-enter ONLY at commit, as ordinary transition composition (commit inside a
  transaction reveals one consistent frame) — machinery already shipped, stays orthogonal.
- **Derivations against a branch**: lazily-vivified per-branch views (the store already
  vivifies children lazily — same trick; only read paths materialize).
- Conflict semantics on rebase: per-leaf LWW default + `merge3` escape hatch + the op-log's
  keyed array handling — identical policy surface as mesh, build once.
- Nested forks: v1 says no (single level); revisit if speculation-on-idle wants trees.

## Relationships

- **mesh**: build the branch primitive and mesh's optimistic/rebase layer is free — or build
  mesh first and extract it. Either order works; doing them together avoids two rebase impls.
- **concurrency**: `commit()` inside a transaction composes with hold/reveal (one consistent
  frame). `branch.commit()` is a natural transaction boundary.
- **telemetry/devtools**: branches are visualizable timelines; op attribution makes "what did
  this speculation change" a query (ties into idea/concurrency-devtools.md).
