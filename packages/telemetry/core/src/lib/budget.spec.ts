import {
  assertBudget,
  BudgetError,
  expectFinding,
  expectNoFindings,
  parseBudgetFile,
  type Budget,
} from './budget';
import { fingerprintOf, type FindingSpec } from './finding';
import { memorySink, type MemorySink } from './memory-sink';

const CTX = { traceId: '1'.repeat(32), spanId: '2'.repeat(16) };

function record(m: MemorySink, code: string, path = 'p', node?: string) {
  const spec: FindingSpec = { severity: 'warn', path, node, message: 'fix it' };
  m.recordFinding?.({
    ...spec,
    code,
    fingerprint: fingerprintOf(code, path, node),
  });
}

function span(m: MemorySink, name: string, startMs?: number, endMs?: number) {
  const s = m.startSpan?.(name, CTX, {}, startMs);
  if (endMs !== undefined || startMs !== undefined) s?.end(endMs);
}

function violationsOf(fn: () => void): readonly string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BudgetError);
    return (err as BudgetError).violations;
  }
  throw new Error('expected a BudgetError');
}

describe('budgets', () => {
  it('allow list tolerates the listed codes and names every other finding', () => {
    const m = memorySink();
    record(m, 'A');
    record(m, 'B', 'forms.login', 'email');

    expect(() => assertBudget(m, { allow: ['A', 'B'] })).not.toThrow();
    expect(violationsOf(() => assertBudget(m, { allow: ['A'] }))).toEqual([
      'finding B (path forms.login, node email): 1 findings outside the allow list, max 0',
    ]);
  });

  it('maxFindings: unlimited without allow, a cap on non-allowed findings with it', () => {
    const m = memorySink();
    record(m, 'A');
    record(m, 'A');
    record(m, 'B');

    expect(() => assertBudget(m, {})).not.toThrow();
    expect(() => assertBudget(m, { maxFindings: 3 })).not.toThrow();
    expect(
      violationsOf(() => assertBudget(m, { maxFindings: 2 })),
    ).toHaveLength(3);
    expect(() =>
      assertBudget(m, { allow: ['A'], maxFindings: 1 }),
    ).not.toThrow();
    expect(
      violationsOf(() => assertBudget(m, { allow: ['B'], maxFindings: 1 })),
    ).toEqual([
      'finding A (path p): 2 findings outside the allow list, max 1',
      'finding A (path p): 2 findings outside the allow list, max 1',
    ]);
  });

  it('maxSpanMs by exact name: over the cap fails, at the cap passes, other names ignored', () => {
    const m = memorySink();
    span(m, 'load', 100, 160);
    span(m, 'load.child', 100, 400);

    expect(
      violationsOf(() => assertBudget(m, { maxSpanMs: { load: 50 } })),
    ).toEqual(['span load took 60ms, cap 50ms (load)']);
    expect(() => assertBudget(m, { maxSpanMs: { load: 60 } })).not.toThrow();
  });

  it('maxSpanMs by /regex/ string, flags included', () => {
    const m = memorySink();
    span(m, 'http GET', 0, 30);
    span(m, 'http POST', 0, 80);
    span(m, 'render', 0, 500);

    expect(
      violationsOf(() => assertBudget(m, { maxSpanMs: { '/^http /': 50 } })),
    ).toEqual(['span http POST took 80ms, cap 50ms (/^http /)']);
    expect(
      violationsOf(() => assertBudget(m, { maxSpanMs: { '/^HTTP/i': 20 } })),
    ).toHaveLength(2);
  });

  it('maxSpanMs only counts ended spans with both stamps', () => {
    const m = memorySink();
    span(m, 'open', 0); // started, never ended
    m.startSpan?.('open', CTX, {}, 0); // no end at all
    span(m, 'unstamped', undefined, 999); // ended, no start stamp
    // stamped but not ended (e.g. a hand-built record): still ignored
    m.spans.push({
      name: 'open',
      ctx: CTX,
      attrs: {},
      ended: false,
      startMs: 0,
      endMs: 999,
    });
    expect(() =>
      assertBudget(m, { maxSpanMs: { open: 0, unstamped: 0 } }),
    ).not.toThrow();
  });

  it('assertBudget lists every violation, not just the first', () => {
    const m = memorySink();
    record(m, 'X', 'a');
    span(m, 'load', 0, 100);
    span(m, 'save', 0, 100);
    const budget: Budget = { allow: [], maxSpanMs: { load: 10, save: 10 } };

    let error: unknown;
    try {
      assertBudget(m, budget);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(BudgetError);
    expect((error as BudgetError).violations).toEqual([
      'finding X (path a): 1 findings outside the allow list, max 0',
      'span load took 100ms, cap 10ms (load)',
      'span save took 100ms, cap 10ms (save)',
    ]);
    for (const v of (error as BudgetError).violations) {
      expect((error as BudgetError).message).toContain(v);
    }
  });

  it('expectNoFindings passes clean, honours allow, and names offenders', () => {
    const m = memorySink();
    expect(() => expectNoFindings(m)).not.toThrow();
    record(m, 'A', 'x', 'n');
    expect(() => expectNoFindings(m, ['A'])).not.toThrow();
    expect(violationsOf(() => expectNoFindings(m))).toEqual([
      'finding A (path x, node n): 1 findings outside the allow list, max 0',
    ]);
  });

  it('expectFinding returns the first match and throws with what was recorded', () => {
    const m = memorySink();
    record(m, 'A', 'first');
    record(m, 'A', 'second');
    record(m, 'B');

    expect(expectFinding(m, 'A').path).toBe('first');
    expect(violationsOf(() => expectFinding(m, 'C'))).toEqual([
      'no finding C recorded (recorded: A, A, B)',
    ]);
    expect(violationsOf(() => expectFinding(memorySink(), 'C'))).toEqual([
      'no finding C recorded (recorded: none)',
    ]);
  });

  describe('parseBudgetFile', () => {
    it('returns a valid file as-is', () => {
      const file = {
        formatVersion: 1,
        scenarios: {
          checkout: {
            allow: ['A'],
            maxFindings: 1,
            maxSpanMs: { load: 50, '/^http/': 200 },
          },
          empty: {},
        },
      };
      expect(parseBudgetFile(file)).toBe(file);
    });

    it.each<[string, unknown, string]>([
      ['a non-object', 'nope', 'expected an object'],
      [
        'a wrong version',
        { formatVersion: 2, scenarios: {} },
        'formatVersion: expected 1, got 2',
      ],
      [
        'missing scenarios',
        { formatVersion: 1 },
        'scenarios: expected an object of scenario name → budget',
      ],
      [
        'a non-object budget',
        { formatVersion: 1, scenarios: { s: [] } },
        'scenarios["s"]: expected an object',
      ],
      [
        'a non-string allow',
        { formatVersion: 1, scenarios: { s: { allow: [1] } } },
        'scenarios["s"].allow: expected an array of finding codes',
      ],
      [
        'a negative maxFindings',
        { formatVersion: 1, scenarios: { s: { maxFindings: -1 } } },
        'scenarios["s"].maxFindings: expected a non-negative number',
      ],
      [
        'a string maxFindings',
        { formatVersion: 1, scenarios: { s: { maxFindings: '3' } } },
        'scenarios["s"].maxFindings: expected a non-negative number',
      ],
      [
        'a non-numeric span cap',
        { formatVersion: 1, scenarios: { s: { maxSpanMs: { load: 'fast' } } } },
        'scenarios["s"].maxSpanMs["load"]: expected a non-negative number',
      ],
      [
        'an invalid regex key',
        { formatVersion: 1, scenarios: { s: { maxSpanMs: { '/(/': 1 } } } },
        'scenarios["s"].maxSpanMs["/(/"]: invalid regex',
      ],
      [
        'an unknown key',
        { formatVersion: 1, scenarios: { s: { maxFinding: 1 } } },
        'scenarios["s"].maxFinding: unknown key',
      ],
    ])('rejects %s with a message', (_label, input, message) => {
      expect(violationsOf(() => parseBudgetFile(input))).toEqual([message]);
    });

    it('collects every shape error into one BudgetError', () => {
      const violations = violationsOf(() =>
        parseBudgetFile({
          formatVersion: 0,
          scenarios: { a: { allow: 'A' }, b: { maxSpanMs: [] } },
        }),
      );
      expect(violations).toEqual([
        'formatVersion: expected 1, got 0',
        'scenarios["a"].allow: expected an array of finding codes',
        'scenarios["b"].maxSpanMs: expected an object of span name → ms',
      ]);
    });
  });
});
