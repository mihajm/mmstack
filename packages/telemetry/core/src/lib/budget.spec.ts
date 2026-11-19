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

  it('maxSpanMs by re: pattern', () => {
    const m = memorySink();
    span(m, 'http GET', 0, 30);
    span(m, 'http POST', 0, 80);
    span(m, 'render', 0, 500);

    expect(
      violationsOf(() => assertBudget(m, { maxSpanMs: { 're:^http ': 50 } })),
    ).toEqual(['span http POST took 80ms, cap 50ms (re:^http )']);
    expect(
      violationsOf(() => assertBudget(m, { maxSpanMs: { 're:^http': 20 } })),
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
    expect((error as BudgetError).name).toBe('BudgetError');
    expect((error as BudgetError).message).toBe(
      [
        'Budget exceeded:',
        '  - finding X (path a): 1 findings outside the allow list, max 0',
        '  - span load took 100ms, cap 10ms (load)',
        '  - span save took 100ms, cap 10ms (save)',
      ].join('\n'),
    );
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
        formatVersion: 2,
        scenarios: {
          checkout: {
            allow: ['A'],
            maxFindings: 1,
            maxSpanMs: { load: 50, 're:^http': 200 },
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
        { formatVersion: 3, scenarios: {} },
        'formatVersion: expected 2, got 3',
      ],
      [
        'missing scenarios',
        { formatVersion: 2 },
        'scenarios: expected an object of scenario name → budget',
      ],
      [
        'a non-object budget',
        { formatVersion: 2, scenarios: { s: [] } },
        'scenarios["s"]: expected an object',
      ],
      [
        'a non-string allow',
        { formatVersion: 2, scenarios: { s: { allow: [1] } } },
        'scenarios["s"].allow: expected an array of finding codes',
      ],
      [
        'a negative maxFindings',
        { formatVersion: 2, scenarios: { s: { maxFindings: -1 } } },
        'scenarios["s"].maxFindings: expected a non-negative number',
      ],
      [
        'a string maxFindings',
        { formatVersion: 2, scenarios: { s: { maxFindings: '3' } } },
        'scenarios["s"].maxFindings: expected a non-negative number',
      ],
      [
        'a non-numeric span cap',
        { formatVersion: 2, scenarios: { s: { maxSpanMs: { load: 'fast' } } } },
        'scenarios["s"].maxSpanMs["load"]: expected a non-negative number',
      ],
      [
        'an invalid regex key',
        { formatVersion: 2, scenarios: { s: { maxSpanMs: { 're:(': 1 } } } },
        'scenarios["s"].maxSpanMs["re:("]: invalid regex',
      ],
      [
        'an unknown key',
        { formatVersion: 2, scenarios: { s: { maxFinding: 1 } } },
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
        'formatVersion: expected 2, got 0',
        'scenarios["a"].allow: expected an array of finding codes',
        'scenarios["b"].maxSpanMs: expected an object of span name → ms',
      ]);
    });
  });
});

describe('budgets: span keys', () => {
  function over(name: string, key: string): readonly string[] {
    const m = memorySink();
    span(m, name, 0, 100);
    try {
      assertBudget(m, { maxSpanMs: { [key]: 10 } });
      return [];
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetError);
      return (err as BudgetError).violations;
    }
  }

  it.each<[string, string, string, number]>([
    ['a path-like exact name', '/api/users', '/api/users', 1],
    [
      'a path-like key does not match a different path',
      '/api/orders',
      '/api/users',
      0,
    ],
    ['a name with only its leading slash', '/health', '/health', 1],
    ['a lone slash is an exact name, not an empty regex', 'render', '/', 0],
    [
      'an inner slash without a leading one is an exact name',
      'pipeline',
      'api/v',
      0,
    ],
    ['the same key matches its own span', 'api/v', 'api/v', 1],
    [
      'a path whose tail looks like flags is exact',
      '/users/id',
      '/users/id',
      1,
    ],
    ['and does not match by pattern', '/users/42', '/users/id', 0],
    ['an old /regex/ key is now an exact name', 'http GET', '/^http/', 0],
    ['and matches only a span with that literal name', '/^http/', '/^http/', 1],
    ['a re: key matches by pattern', 'http GET', 're:^http', 1],
    ['a re: key takes no flags', 'HTTP GET', 're:^http', 0],
  ])('%s', (_label, name, key, count) => {
    expect(over(name, key)).toHaveLength(count);
  });

  it('a re: pattern is checked against every span, statelessly', () => {
    const m = memorySink();
    for (const name of ['http GET', 'http PUT', 'http POST'])
      span(m, name, 0, 100);
    expect(
      violationsOf(() => assertBudget(m, { maxSpanMs: { 're:^http': 10 } })),
    ).toHaveLength(3);
  });

  it('parseBudgetFile accepts path-like exact names and rejects a broken re: source', () => {
    const ok = {
      formatVersion: 2,
      scenarios: {
        s: { maxSpanMs: { '/api/users': 1, '/users/id': 1, '/(/': 1 } },
      },
    };
    expect(parseBudgetFile(ok)).toBe(ok);
    expect(
      violationsOf(() =>
        parseBudgetFile({
          formatVersion: 2,
          scenarios: { s: { maxSpanMs: { 're:[': 1 } } },
        }),
      ),
    ).toEqual(['scenarios["s"].maxSpanMs["re:["]: invalid regex']);
  });

  it('parseBudgetFile rejects a version 1 file and says how to migrate', () => {
    expect(
      violationsOf(() =>
        parseBudgetFile({
          formatVersion: 1,
          scenarios: { s: { maxSpanMs: { '/^http/': 1 } } },
        }),
      ),
    ).toEqual([
      'formatVersion: 1 is no longer supported; set formatVersion to 2 and rewrite regex keys from "/source/" to "re:source"',
    ]);
  });
});

describe('budgets: error headings and parser boundaries', () => {
  function thrown(fn: () => void): BudgetError {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetError);
      return err as BudgetError;
    }
    throw new Error('expected a BudgetError');
  }

  it('each thrower names its failure in the message heading', () => {
    expect(thrown(() => expectFinding(memorySink(), 'C')).message).toBe(
      'Expected finding missing:\n  - no finding C recorded (recorded: none)',
    );
    expect(thrown(() => parseBudgetFile('nope')).message).toBe(
      'Invalid budget file:\n  - expected an object',
    );
  });

  it.each<[string, unknown, string]>([
    ['null', null, 'expected an object'],
    [
      'a null budget',
      { formatVersion: 2, scenarios: { s: null } },
      'scenarios["s"]: expected an object',
    ],
    [
      'an infinite maxFindings',
      { formatVersion: 2, scenarios: { s: { maxFindings: Infinity } } },
      'scenarios["s"].maxFindings: expected a non-negative number',
    ],
    [
      'a mixed allow array',
      { formatVersion: 2, scenarios: { s: { allow: ['A', 1] } } },
      'scenarios["s"].allow: expected an array of finding codes',
    ],
  ])('rejects %s', (_label, input, message) => {
    expect(thrown(() => parseBudgetFile(input)).violations).toEqual([message]);
  });

  it('accepts zero limits', () => {
    const file = {
      formatVersion: 2,
      scenarios: { s: { maxFindings: 0, maxSpanMs: { load: 0 } } },
    };
    expect(parseBudgetFile(file)).toBe(file);
  });
});
