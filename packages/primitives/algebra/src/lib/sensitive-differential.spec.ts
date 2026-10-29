import fc from 'fast-check';
import { redact, setStrictSentinels, unboxAll } from '@mmstack/primitives/core';
import {
  type Family,
  normalize,
  PRECISION_EXCLUSIONS,
  type Report,
  runReal,
  TOTALITY_EXCLUSIONS,
} from '../../../core/src/lib/semantics/testing/sensitive-adapter';
import {
  exprArb,
  pairedSourcesArb,
  plainSourcesArb,
  sourcesArb,
} from '../../../core/src/lib/semantics/testing/sensitive-language';
import {
  oracleShape,
  oracleValue,
  runOracle,
} from '../../../core/src/lib/semantics/testing/sensitive-oracle';

// The model's program generator and taint oracle, re-pointed at the real hooks through the adapter.
// Named seam witnesses live in `sensitive-seams.spec.ts` and run first by name; every exclusion
// below is a named family (see the adapter) with the design clause that makes the real behavior
// differ from the model's: top-level-only absorber joins, the real search/filter/sort schedules,
// spread as boxed elements, nested-array label scans, labeling by any argument of an aware callee
// or a method call, and a source error minted over a boxed cause.

// Budget and statistics are environment knobs for a longer local pass (the suite runs 400).
const ENV =
  (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {};
const RUNS = Number(ENV['SENSITIVE_DIFF_RUNS'] ?? 400);
const TIMEOUT = 120_000;

beforeEach(() => setStrictSentinels(true));
afterEach(() => setStrictSentinels(false));

const excluded = (
  flags: ReadonlySet<Family>,
  families: readonly Family[],
): boolean => families.some((f) => flags.has(f));

/** Every position the oracle labels is labeled in the real result, or under a labeled ancestor. */
const covers = (real: unknown, oracle: unknown): boolean => {
  if (real === 'L') return true;
  if (oracle === 'L') return false;
  if (Array.isArray(real) && Array.isArray(oracle))
    return (
      real.length === oracle.length &&
      real.every((r, i) => covers(r, oracle[i]))
    );
  if (
    typeof real === 'object' &&
    real !== null &&
    typeof oracle === 'object' &&
    oracle !== null
  ) {
    const o = oracle as Record<string, unknown>;
    return Object.entries(real).every(([k, r]) => covers(r, o[k]));
  }
  return true;
};

const contains = (shape: unknown, mark: string): boolean =>
  shape === mark ||
  (typeof shape === 'object' &&
    shape !== null &&
    Object.values(shape).some((s) => contains(s, mark)));

const plainReports = (reports: readonly Report[]) =>
  reports.map((r) => ({
    origin: r.origin,
    subclass: r.subclass,
    cause: normalize(r.cause),
  }));

describe('sensitive differential: the model generator and oracle against the real hooks', () => {
  it(
    '[PREMISE] mode off, plain sources: the real hooks compute the oracle values outside the excluded schedules',
    () => {
      let compared = 0;
      fc.assert(
        fc.property(exprArb, plainSourcesArb, (tree, specs) => {
          const off = runReal(tree, specs, false);
          if (excluded(off.flags, TOTALITY_EXCLUSIONS)) return;
          compared++;
          expect(off.value).toEqual(oracleValue(runOracle(tree, specs).v));
        }),
        { numRuns: RUNS },
      );
      expect(compared).toBeGreaterThan(RUNS / 2);
    },
    TIMEOUT,
  );

  it(
    '[PROVEN] totality: labeled exactly where the oracle says, modulo the named exclusions',
    () => {
      const seen = { sound: 0, exact: 0, labeled: 0 };
      const families: Partial<Record<Family, number>> = {};
      fc.assert(
        fc.property(exprArb, sourcesArb, (tree, specs) => {
          const on = runReal(tree, specs, true);
          for (const f of on.flags) families[f] = (families[f] ?? 0) + 1;
          if (excluded(on.flags, TOTALITY_EXCLUSIONS)) return;
          const o = runOracle(tree, specs);
          expect(on.value).toEqual(oracleValue(o.v));
          const expected = oracleShape(o);
          expect(covers(on.shape, expected)).toBe(true);
          seen.sound++;
          if (contains(expected, 'L')) seen.labeled++;
          if (excluded(on.flags, PRECISION_EXCLUSIONS)) return;
          expect(on.shape).toEqual(expected);
          seen.exact++;
        }),
        { numRuns: RUNS },
      );
      if (ENV['SENSITIVE_DIFF_STATS'])
        console.info('totality', RUNS, seen, families);
      expect(seen.sound).toBeGreaterThan(RUNS / 3);
      expect(seen.exact).toBeGreaterThan(RUNS / 5);
      expect(seen.labeled).toBeGreaterThan(RUNS / 20);
    },
    TIMEOUT,
  );

  it(
    '[PROVEN] erasure: unboxing the mode-on result gives the mode-off result, reports included',
    () => {
      fc.assert(
        fc.property(exprArb, sourcesArb, (tree, specs) => {
          const off = runReal(tree, specs, false);
          const on = runReal(tree, specs, true);
          expect(on.value).toEqual(off.value);
          expect(
            plainReports(
              on.reports.map((r) => ({ ...r, cause: unboxAll(r.cause) })),
            ),
          ).toEqual(plainReports(off.reports));
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    '[PROVEN] no-mint: without a declared source nothing is boxed and nothing registers',
    () => {
      fc.assert(
        fc.property(exprArb, plainSourcesArb, (tree, specs) => {
          const on = runReal(tree, specs, true);
          expect(contains(on.shape, 'L')).toBe(false);
          expect(on.registered).toBe(0);
          expect(on.reports.every((r) => !r.sensitive)).toBe(true);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    '[PROVEN] mode off: declared sources register nothing',
    () => {
      fc.assert(
        fc.property(exprArb, sourcesArb, (tree, specs) => {
          expect(runReal(tree, specs, false).registered).toBe(0);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    '[PROVEN] noninterference: withholding readers and the reporter cannot tell two secrets apart',
    () => {
      const seen = { differ: 0, labeledReports: 0, reports: 0 };
      const observe = (raw: unknown, reports: readonly Report[]) => ({
        result: normalize(redact(raw)),
        reports: reports
          .filter((r) => !r.sensitive)
          .map((r) => ({
            origin: r.origin,
            subclass: r.subclass,
            cause: normalize(redact(r.cause)),
          })),
        leaks: reports.filter((r) => r.origin === 'leak').length,
      });
      const labeledReports = (raw: unknown, reports: readonly Report[]) =>
        reports.filter((r) => r.sensitive).length;
      fc.assert(
        fc.property(exprArb, pairedSourcesArb, (tree, [a, b]) => {
          const oa = runReal(tree, a, true, observe).observed;
          const ob = runReal(tree, b, true, observe).observed;
          expect(ob).toEqual(oa);
          if ((runReal(tree, a, true, labeledReports).observed ?? 0) > 0)
            seen.labeledReports++;
          if (oa && oa.reports.length > 0) seen.reports++;
          // A real pair: mode off, the two secrets compute different values or report different causes.
          const plain = (specs: typeof a) => {
            const off = runReal(tree, specs, false);
            return JSON.stringify([off.value, plainReports(off.reports)]);
          };
          if (plain(a) !== plain(b)) seen.differ++;
        }),
        { numRuns: RUNS },
      );
      if (ENV['SENSITIVE_DIFF_STATS'])
        console.info('noninterference', RUNS, seen);
      expect(seen.differ).toBeGreaterThan(RUNS / 20);
      expect(seen.reports).toBeGreaterThan(RUNS / 80);
      expect(seen.labeledReports).toBeGreaterThan(RUNS / 80);
    },
    TIMEOUT,
  );
});
