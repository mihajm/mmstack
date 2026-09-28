import { type Finding } from './finding';
import { type MemorySink, type RecordedSpan } from './memory-sink';

// Budget assertions over a `memorySink`, for tests. Framework-agnostic: they throw a
// `BudgetError` listing every violation, so any test runner reports them.

export interface Budget {
  /** finding codes tolerated */
  readonly allow?: readonly string[];
  /** max findings NOT in `allow` (default 0 when `allow` is given, unlimited otherwise) */
  readonly maxFindings?: number;
  /** span name (exact or /regex/ string) → max duration ms, over ENDED spans with both stamps */
  readonly maxSpanMs?: Readonly<Record<string, number>>;
}

/** A checked-in file of named budgets, one per test scenario. */
export interface BudgetFile {
  readonly formatVersion: 1;
  readonly scenarios: Readonly<Record<string, Budget>>;
}

export class BudgetError extends Error {
  readonly violations: readonly string[];

  constructor(heading: string, violations: readonly string[]) {
    super(`${heading}:\n${violations.map((v) => `  - ${v}`).join('\n')}`);
    this.name = 'BudgetError';
    this.violations = violations;
  }
}

function describeFinding(finding: Finding): string {
  const node = finding.node === undefined ? '' : `, node ${finding.node}`;
  return `finding ${finding.code} (path ${finding.path}${node})`;
}

/** `/body/flags` → RegExp; anything else is an exact name. */
function spanMatcher(key: string): (name: string) => boolean {
  const close = key.lastIndexOf('/');
  if (key.startsWith('/') && close > 0) {
    const re = new RegExp(key.slice(1, close), key.slice(close + 1));
    return (name) => re.test(name);
  }
  return (name) => name === key;
}

function durationOf(span: RecordedSpan): number | undefined {
  if (!span.ended || span.startMs === undefined || span.endMs === undefined)
    return undefined;
  return span.endMs - span.startMs;
}

/** Throws a {@link BudgetError} naming every finding or span over budget. */
export function assertBudget(memory: MemorySink, budget: Budget): void {
  const violations: string[] = [];

  const allow = new Set(budget.allow ?? []);
  const max =
    budget.maxFindings ?? (budget.allow ? 0 : Number.POSITIVE_INFINITY);
  const unexpected = memory.findings
    .map((r) => r.finding)
    .filter((f) => !allow.has(f.code));
  if (unexpected.length > max) {
    for (const f of unexpected) {
      violations.push(
        `${describeFinding(f)}: ${unexpected.length} findings outside the allow list, max ${max}`,
      );
    }
  }

  for (const [key, cap] of Object.entries(budget.maxSpanMs ?? {})) {
    const matches = spanMatcher(key);
    for (const span of memory.spans) {
      if (!matches(span.name)) continue;
      const ms = durationOf(span);
      if (ms !== undefined && ms > cap) {
        violations.push(
          `span ${span.name} took ${ms}ms, cap ${cap}ms (${key})`,
        );
      }
    }
  }

  if (violations.length) throw new BudgetError('Budget exceeded', violations);
}

/** Throws unless every recorded finding's code is in `allow`. */
export function expectNoFindings(
  memory: MemorySink,
  allow: readonly string[] = [],
): void {
  assertBudget(memory, { allow, maxFindings: 0 });
}

/** Returns the first recorded finding with `code`; throws if there is none. */
export function expectFinding(memory: MemorySink, code: string): Finding {
  const hit = memory.findings.find((r) => r.finding.code === code);
  if (hit) return hit.finding;
  const seen = memory.findings.map((r) => r.finding.code);
  throw new BudgetError('Expected finding missing', [
    `no finding ${code} recorded (recorded: ${seen.length ? seen.join(', ') : 'none'})`,
  ]);
}

const BUDGET_KEYS = new Set(['allow', 'maxFindings', 'maxSpanMs']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function checkBudget(at: string, value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${at}: expected an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!BUDGET_KEYS.has(key)) errors.push(`${at}.${key}: unknown key`);
  }
  const { allow, maxFindings, maxSpanMs } = value;
  if (
    allow !== undefined &&
    !(Array.isArray(allow) && allow.every((c) => typeof c === 'string'))
  ) {
    errors.push(`${at}.allow: expected an array of finding codes`);
  }
  if (maxFindings !== undefined && !isLimit(maxFindings)) {
    errors.push(`${at}.maxFindings: expected a non-negative number`);
  }
  if (maxSpanMs === undefined) return;
  if (!isRecord(maxSpanMs)) {
    errors.push(`${at}.maxSpanMs: expected an object of span name → ms`);
    return;
  }
  for (const [name, cap] of Object.entries(maxSpanMs)) {
    if (!isLimit(cap)) {
      errors.push(`${at}.maxSpanMs["${name}"]: expected a non-negative number`);
    }
    try {
      spanMatcher(name);
    } catch {
      errors.push(`${at}.maxSpanMs["${name}"]: invalid regex`);
    }
  }
}

/** Validates a parsed budget file; throws a {@link BudgetError} listing every shape error. */
export function parseBudgetFile(input: unknown): BudgetFile {
  const errors: string[] = [];
  if (!isRecord(input)) {
    errors.push('expected an object');
  } else {
    if (input['formatVersion'] !== 1) {
      errors.push(
        `formatVersion: expected 1, got ${JSON.stringify(input['formatVersion'])}`,
      );
    }
    const scenarios = input['scenarios'];
    if (!isRecord(scenarios)) {
      errors.push('scenarios: expected an object of scenario name → budget');
    } else {
      for (const [name, budget] of Object.entries(scenarios)) {
        checkBudget(`scenarios["${name}"]`, budget, errors);
      }
    }
  }
  if (errors.length) throw new BudgetError('Invalid budget file', errors);
  return input as unknown as BudgetFile;
}
