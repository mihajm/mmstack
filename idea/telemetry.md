# @mmstack/telemetry: headless signals-native telemetry suite

**Source of truth:** the two RFCs in `../abscratch` — `TELEMETRY-RFC.md` (the generic suite) and
`TELEMETRY-APP-BUILDER-RFC.md` (app-builder's policy + seams on top). This file is the mmstack-side
ledger entry: what it is, where it stands, and what's left to make it a real mmstack release.
Working code currently lives in `../abscratch/src/mmstack/telemetry-*` as a temporary home.

## The pitch (community angle)

A headless, signals-native, vendor-neutral telemetry suite (spans/events/errors/metrics/logs) with
capability-based backend adapters. The wedge is a **real, verified upstream gap**: Angular v21 is
zoneless by default, OTel's browser context propagation requires zone.js (`ZoneContextManager`,
which also breaks on native `async/await`), there is no built-in zoneless context manager (OTel
issue #6211, open/unassigned) and no official Angular instrumentation. Explicit zone-free context
propagation + signals-native reactive consent is exactly the shape of the answer, and nobody has
shipped it. Re-verify the ecosystem state at release time — this is a moving target.

Architecture in one breath: `telemetry-core` is paradigm-neutral (capability sinks: span/event/
error/metric/log) but OTel/W3C-shaped for traces, so OTLP export and cross-vendor correlation come
free; `-otel` is the OTLP interchange adapter built on the official OTel JS SDK; `-posthog`/
`-sentry` are vendor adapters (native sinks + proprietary-feature init + correlation via shared
trace context and a signal-based handle registry); Datadog rides OTLP. Privacy is mechanism-not-
policy: core sends-as-given, an optional per-sink `AttributePolicy` (+ `allowOnly`/`deny`/
`redactKeys`/`hashKeys`/`compose` builders) enforces whatever the consumer needs. Opt-in factory
provider, noop when unconfigured, zero overhead.

## Current state (2026-07-02)

**Phase 0 done in abscratch**: core facade + noop + capability sinks + readiness buffering (flush
on sink-ready, drop after `readyTimeoutMs`) + `AttributePolicy` + builders + HTTP interceptor
(`withTelemetryParent` HttpContext nesting) + `memorySink` test util; `-otel` on the official SDK
(traces/metrics/logs, id-bridging, BYO `WebTracerProvider`); `-posthog`/`-sentry` event/error sinks
landed early, plus the correlation substrate (`EmitOptions.parent`, active-span trace-id injection)
and `TelemetryHandles` signal registry. Also present: `traced`/`tracedCallback`, `tracedSignal`
(causal signal wrapper), `TelemetryScope` (hierarchical-DI lineage directive). ~39 spec cases in
the suite itself (the RFC's "219 tests" counted the whole scratch project); build+lint green there.

**Known remaining before release:**
- OTLP end-to-end smoke against a real collector (docker loop).
- `tracedSignal` (§8.2 signal-causality) semantics — prototype flagged as needs-validation:
  narrow synchronous capture, last-writer-wins; make sure the model holds before documenting.
- `TelemetryScope` directive is thin (25 lines) — the DI-lineage story needs exercising.
- Sampling/batching/OTLP transport config surface (adapter-level, non-blocking).
- Consent plumbing (`requirements`/`pending`/`decide`, async ConsentStore) — designed in RFC §7;
  check what's actually implemented vs designed.

## Port to mmstack (the actual work item)

1. `packages/telemetry/` — decide shape: one lib with secondary entry points
   (`@mmstack/telemetry`, `/otel`, `/posthog`, `/sentry`) vs separate libs. RFC leans separate
   packages so consumers pull only the SDK weight they use; peer-dep hygiene matters (OTel SDK,
   posthog-js, @sentry/browser are all optional heavyweights).
2. Nx buildable-lib setup + tsconfig paths (mind the no-trailing-commas constraint), lint, publish
   metadata — same drill as the other libs.
3. Bring tests up to the mmstack public-lib bar (dnd-quality: deep assertions, not happy-path).
   39 cases is a skeleton count for a surface this size.
4. README per package, friendly docs tone; the zoneless/OTel gap is the headline.
5. Cross-lib touchpoint: first-party instrumentation hooks in `@mmstack/resource` (queryResource
   retry/interval refetches emitting when telemetry is installed, noop otherwise) — RFC §8.2.

## App-builder consumption (mid-term, phases 1–3)

Lives in the app-builder RFC; summary: Phase 1 = structural vendor channel + error-pathing (kills
the silent `catch {}` sites — independently valuable), Phase 2 = `x-sensitivity` classification →
tenant value telemetry, Phase 3 = consent + product analytics. The vendor/tenant privacy split,
`SafeAttr` branding, and sensitivity taxonomy are all app-builder-side policy on core's hook.

## Future work parked in the RFC (don't lose)

- **Signal-graph instrumentation** (RFC §12): production-counting via version-advance detection on
  primitives we own (`store` leaves, `derived`, wrappers), `debugName` + store-path identity,
  templated paths for metric cardinality, dev overlay + aggregated metrics (never raw event
  stream). **Standalone win to extract:** `debugName` path-propagation in `@mmstack/primitives`
  store leaves — makes anonymous leaves show up named in Angular DevTools' signal graph, valuable
  with zero telemetry involvement. Could land in primitives independently, any time.
- Component-event wrapping helpers / directives for library components (RFC §8 "needs exploration").

## Strategic fit

Community-first (fills an unsolved gap, standalone useful), app-builder consumes it mid-term —
the same dual-purpose pattern as the concurrency work (SDUI tool → generic carve-out, in reverse).
Design is essentially done and Phase 0 is built; the mmstack port is mostly mechanical + test
deepening, which makes it a good candidate for bounded sessions (doesn't compete with the
design-heavy concurrency items for deep-thinking budget).

## Downstream consumer queued behind the port (2026-07-02)

Concurrency devtools (idea/concurrency.md item 6) was deferred IN FULL until this port lands:
the plan is an instrumentation seam in `@mmstack/primitives` (dnd-plugin-style provider-level
listener token at the scope/transition taps — pending span start/end, suspend, abortPending,
registration — plus scope naming) whose event vocabulary should be designed AGAINST these RFCs
so the OTel span mapping is 1:1, not adapted. Consumers then live here: the OTel adapter, and a
dev-mode exporter / performance-custom-tracks preset that likely subsumes "devtools" entirely.
When porting, budget a small design pass for that seam.
