# Concurrency-layer fix proposals — transaction rollback, attribution, undo overlap

**Status: PROPOSED, nothing implemented.** Found 2026-07-12 while fact-checking the
solid-concurrency-deepdive (adversarial source read of `concurrent/`, both directions).
All three are in the UI concurrency layer (`packages/primitives/src/lib/concurrent/`),
NOT the proven sync substrate — no Tier-1 theorem is touched. Findings 2 and 3 have real
interleaving semantics, so they get the proof-first shape (prose semantics, named
`[DESIGN]` choices, counterexamples to pin); finding 1 is an integration gap. Semantic
choices below are proposals for Miha to ratify, not decisions.

---

## Finding 1 — `startTransaction` rollback has zero cooperating writers

**Evidence.** `abort()` restores only signals recorded via `activeTransaction()?.record(sig)`.
Repo-wide grep: the ONLY caller of `record()` outside `transaction.ts` is a mock
"stateful action" in `transaction.spec.ts:111`. No shipped primitive consults
`activeTransaction()`. So today, `abort()` = release-hold only; the docs page and README
("call `abort()` to roll the writes back") over-promise for every real write path.

**Proposed fix, tiered:**

- **T1 (docs honesty, immediate):** state that rollback covers *recorded* writes and that
  recording is the cooperating-primitive seam; today that set is empty. One paragraph in
  the README + docs page. Ship this even if T2 lands the same week — the contract should
  be explicit either way.
- **T2 (the real fix): wire the seam into our own write paths.**
  - **Store writes are the jackpot:** the store is copy-on-write, so recording the store's
    ROOT WritableSignal on first write inside a transaction is an O(1), perfect undo — the
    pre-write root is just a reference, structural sharing keeps it alive for free. One
    `activeTransaction()?.record(root)` in the store's write path covers every leaf/child
    write. This is the same structural-sharing dividend merge3 and the op-log already cash.
  - **`derived` / `pausableSignal` / `keepPrevious`:** their `set`/`update` forward to a
    source — record the SOURCE (record-once dedup makes double-recording harmless).
  - **`mutable()`:** value-logging is UNSOUND under in-place mutation (the recorded
    "pre-value" aliases the mutated object). `[DESIGN]` choice: (a) exclude + dev-warn when
    `mutate`/`inline` runs inside an active transaction (proposed), or (b) record a
    `structuredClone` (cost scales with value size, silently expensive). Proposing (a);
    a transaction over mutable state can use a store or a fork instead.
  - **Userland plain signals:** export a tiny `transactional(sig)` wrapper (set/update
    record first, then forward). Killed alternative: auto-intercepting all signal writes —
    impossible (Angular signals expose no write hook) and undesirable if it were.
- **Spec first:** turn the spec's mock into the real thing — failing test: store write
  inside `startTransaction`, `abort()`, expect pre-transaction value. Then the
  mutable-warn test and the `transactional()` wrapper tests.

---

## Finding 2 — attributed-pending's "re-trigger counts" contract is unsound

**The documented contract** (`createAttributedPending` jsdoc): a load already in flight at
transaction start is excluded "only until it first settles; a later re-trigger of the same
resource counts as the transaction's own work."

**Why it cannot hold as implemented.** Exclusion is dropped when a *read of the computed
observes* the resource in a settled state. Two failure cases:

1. **Abort+restart:** the transaction's write changes an in-flight query's request; the
   resource aborts and refires with status going `reloading` → `reloading`. No settled
   state ever exists to observe.
2. **Same-tick settle+retrigger:** settle and re-fire happen between reads. Signals are
   pull-based and glitch-free — the intermediate `resolved` state is unobservable *in
   principle*, not just in practice.

Consequence in both: the resource stays excluded, the transaction sees no attributable
work, the `afterNextRender` fallback commits early, hold releases, `abort()` is a no-op.
Case 1 (write changes a visible query's request) is arguably the most common transaction
shape. No spec covers the re-trigger claim (the existing specs only cover
"pre-existing load is not adopted").

**The load-bearing observation:** any attribution scheme built on *sampling status
transitions* is unsound in a glitch-free pull system — intermediate states don't exist
for the sampler. Flight identity must be carried in a VALUE, not inferred from observed
transitions. This kills the tempting alternatives by construction:

- Killed: watch statuses with an effect instead of a computed — effects batch; same-tick
  transitions are still invisible.
- Killed: snapshot request equality — `ResourceLike` has no request surface, and equal
  requests can legitimately re-fire (equality is not flight identity).

**Proposed fix: a monotone flight counter.**

- Add optional `loads?: Signal<number>` to `ResourceLike`: bumped once each time a request
  goes in flight (including abort+restart refires). Monotone counters survive any
  interleaving of reads because the count is cumulative — missing an intermediate read
  loses nothing.
- Attribution rule: at transaction start, for each registered resource record
  `loads0 = loads()` (if exposed). A resource is attributed-pending iff it is loading AND
  (`!preexisting` OR `loads() > loads0`). Preexisting is then just `loads0`-was-recorded-
  while-loading; no Set mutation inside a computed at all.
- Resources without `loads` (plain Angular `resource`) keep the current heuristic,
  documented as best-effort. `@mmstack/resource` (query/stream/mutation) implements
  `loads`; `latest()` can expose the sum of member `loads` where members expose it.
- `[CHARACTERIZED]` option until the fix lands: pin the two failure cases as tests
  asserting the CURRENT wrong behavior with a flip-contract naming the assertions that
  invert when `loads` ships.

**Proof plan (proportionate):** tiny pure model — a ledger of flights (start/settle
events with a txn-start marker) as ground truth, the counter-based attributor beside it.
Property: attributed set == flights started at-or-after txn start, under generated
interleavings (same-tick settle+refire, abort+restart chains, preexisting flights
settling before/after txn end). Pin counterexamples 1 and 2 as permanent oracles, then
re-point the same generators at the real `createAttributedPending` (invariants #14
discipline).

---

## Finding 3 — overlapping transactions: value-log undo has a lost-update anomaly

**The counterexample (pin it):** txn A records `x=1`, writes `2`. Txn B records `x=2`,
writes `3`, commits. A aborts → restores `1`. B's committed write is silently destroyed.
The hold counter explicitly advertises that transactions compose; the undo logs are
mutually unaware and store absolute pre-values, so composition invites this.

**Prose semantics first — what SHOULD abort mean when others wrote after?** Proposed:
"abort removes THIS transaction's effect where it is still in effect, and yields where a
later writer took over." Concretely, `[DESIGN]` choice per state kind:

- **Plain signals: compare-and-restore.** At the end of `fn`, snapshot each recorded
  signal's current value as `mine`. `restore()` becomes: restore `pre` only if the
  signal's current value is still `mine` (`Object.is`); otherwise skip — a later writer
  owns the value now. Cheap, allocation-free, and turns the anomaly into last-writer-wins,
  which is the only defensible semantic without op structure.
- **Store roots: merge3 on abort.** Record `pre` (first touch) and `postFn` (root at end
  of `fn`). Abort sets root to `merge3(ancestor = postFn, mine = current, theirs = pre)`:
  paths only this txn touched satisfy `mine === ancestor` → revert to `pre`; paths a later
  writer touched differ → keep theirs; both-touched conflicts resolve to the later writer.
  Structural sharing makes all three snapshots references, so this is nearly free and
  reuses the exact merge machinery the fork already trusts.
- Killed alternative (named so it can't be relitigated): full op-based undo (record this
  txn's ops via the op-log and apply inversions on abort). Correct but heavy for a
  UI-scoped primitive, and users who need real multi-writer undo already have
  `storeHistory` — the transaction should stay the cheap tier.

Note the composition with Finding 1: the T2 record seam should capture `mine`/`postFn` at
the end of `runInTransaction` anyway, so 1 and 3 land best as one change to the
transaction's record/restore internals plus the per-primitive recording hooks.

---

## Minor items (no design work needed)

- **`latest()` pending waterfall visibility:** `pending` reflects only members collected
  up to the blocking `use()` — later members are invisible until earlier ones unblock.
  Inherent to the design; add one doc line so nobody debugs it as a bug.
- **`<mm-suspense>` leans on eager instantiation of projected content** (resources must be
  created while the placeholder branch renders, or `suspended()` could never flip). It is
  a framework contract, fine today — add a comment and a pinning test so an Angular
  behavior change in conditional content projection fails loudly here instead of
  silently breaking suspense.

## Non-coverage / open

- Nothing here touches the sync substrate, relay, or MV-register semantics.
- The attribution model deliberately abstracts away Angular effect scheduling (the fix's
  whole point is to not depend on it); the pinning tests cover the scheduling reality.
- OPEN `[DESIGN]` items for Miha: mutable-in-transaction policy (1), whether `loads`
  becomes public `ResourceLike` surface or an internal brand (2), and ratification of
  compare-and-restore + merge3-abort as the overlap semantics (3).
