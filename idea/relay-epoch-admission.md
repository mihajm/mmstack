# Design note: relay epoch / citation admission (W6 — BUILT 2026-07-16, options 1+2)

**Status:** SHIPPED 2026-07-16 (options 1+2, driven by the studio governance arc; task spec was
Desktop tomorrow.md). Option 3 (signed dots) is RULED OUT — studio governance ratification
2026-07-16 (`../studio/libs/builders/app-builder/docs/governance-and-seams.md` §1): E2EE-against-
own-relay contradicts the audit architecture; do not gold-plate toward it. Relates to invariants
#16 (client-ingress validation) and #25 (rank is not authority; admission at the relay — see #25
for the full enforcement record + test paths), and conflict-precedence-and-agent-governance.md §1
(epoch) / §5 (P2P trust-full).

**As built (deltas vs the sketch below):**
- Option 1: `OpPolicy.canBump(ctx, path, epoch)`; observed max = `RegisterStore.maxEpoch(path)` over
  ALL retained siblings (not just live — a superseded bump must not lower the floor mid-window);
  carry (`epoch <= observed`) always admitted, authority consulted only for raises. Reason string
  `'epoch-bump'`.
- Option 2 is OPT-IN via `OpPolicy.verifyCitations` (the sketch left the gate unspecified;
  unconditional checking would eject honest writers in ungoverned rooms). Trace = origin's sibling
  OR watermark at/above the cited dot at that path; cites at/below the compaction frontier are
  EXEMPT (unverifiable + provably inert there); self-cites tolerated like ingest. Reason string
  `'unknown-citation'`. Preconditions: relay-mediated room + durable relay (hydrate).
- Both checks run pre-sequencing (a rejected envelope enters no op set) and AFTER the stale-schema
  silent drop. Client fix that rode along: `flushUnacked` sends restored-tail origins before the
  fresh mint, so a fresh-room seed citing tail dots survives a verifying relay.

## The gap

An op self-asserts two precedence-relevant things on the wire: its `epoch` (the precedence term the
fold uses as the outermost key) and its `cites` (the dots it claims to have observed and superseded).
Nothing verifies either:

- **Forged epoch.** Any peer can stamp `epoch: 999999`. Because `compareSiblings` orders by epoch
  first, that op wins the fold and suppresses every concurrent write at the path. This is the
  owner/authority override mechanic (opSync.override / host.override), available to anyone, because
  no admission check binds the RIGHT to bump an epoch to an identity.
- **Forged citation.** An op can cite `{origin: victim, hlc: huge}` it never observed, setting the
  victim's supersession watermark and permanently killing that victim's writes at or below that hlc.

The design already SAYS bump-authority is admission control at the relay (#25/#29), but the shipped
`checkEnvelope`/`pathPrefixAcl` gate only which PATH a writer may touch. There is no hook that
inspects `epoch` or validates `cites`. So the relay cannot enforce the one thing #25 says it must.

## Why it is not urgent

- On the RELAY path this only matters for a room that needs "only role X may override role Y". The
  common case (everyone equal, LWW) never fires an epoch, so nothing to gate.
- On the DIRECT P2P path it is DOCUMENTED trust-full for authority (relay bypassed) — use P2P among
  mutually-trusting clients or route through the relay. This is stated in the relay docs Trust
  section and OpPolicy jsdoc as of the fix pass.
- The malicious-forged-citation convergence vector is bounded: it is deterministic across peers (a
  forged watermark is applied identically everywhere), so it is a griefing/authority problem, not a
  convergence break. Convergence (the non-negotiable) holds regardless.

## Options

1. **Policy hook `canBump(ctx, path, epoch)`** — the relay tracks the room's observed max epoch per
   path (it already retains register state, so this is close at hand) and rejects an envelope whose
   op raises an epoch above the observed max unless the writer is authorized to bump. Tripwire-ejects
   on violation like every other policy failure.
   - Pros: fits the existing policy seam and tripwire model; no wire change; the relay already has
     the per-path register state to know the current epoch.
   - Cons: the relay must interpret epoch (a small step past "orders opaque ops"); an authorized
     writer carrying (not bumping) a high epoch forward must be distinguished from a raise (the
     emission rule already separates carry from bump, so the check is `epoch > observed-max` gated by
     authority, carry is `epoch == observed-max` and always allowed).
2. **Citation provenance** — reject an op citing a dot the relay has no record of (it retains the
   register state, so it can check a cited dot exists). Closes forged citations of non-existent dots;
   does NOT stop citing a real dot you did not actually observe (unforgeable observation needs signed
   dots, option 3).
   - Pros: cheap, uses retained state, catches the blatant forgery.
   - Cons: partial (real-but-unobserved dots slip through).
3. **Signed dots / envelopes** — each op carries a signature over `(origin, hlc, path, cites,
   epoch)`; peers and the relay verify. Closes both forged epoch and forged citation end to end,
   including on the P2P path (no relay needed).
   - Pros: the only option that makes P2P authority-safe; strongest.
   - Cons: key management, a wire/envelope change, per-op crypto cost; a much larger project.

## Recommendation

Ship option 1 (`canBump` policy hook) as the relay-side authority gate when a consumer first needs
role-based override in a relayed room; add option 2 (cheap citation-existence check) alongside it as
defense in depth. Treat option 3 (signed dots) as a separate, larger track, taken only if a
zero-trust P2P room with authority is a real requirement — until then P2P stays documented
trust-full. None of these block the current release: convergence holds, and the trust model is
documented honestly.
