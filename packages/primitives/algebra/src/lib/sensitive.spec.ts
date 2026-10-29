import {
  error,
  type ErrorMintReport,
  redact,
  sensitive,
  setErrorReporter,
  setSensitiveMode,
  setSensitivePolicy,
  unbox,
} from '@mmstack/primitives/core';
import { member } from './algebra';
import { isLabeled, markLabeled } from './sensitive';

const PLACEHOLDER = '[mmstack sensitive]';

const counters = (
  (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('@mmstack/primitives.sensitive')
  ] as { counters: { registered: number } }
).counters;

let reports: ErrorMintReport[];

beforeEach(() => {
  reports = [];
  setErrorReporter((r) => reports.push(r));
  setSensitivePolicy({ placeholder: PLACEHOLDER });
});

afterEach(() => {
  setErrorReporter(undefined);
  setSensitiveMode(false);
});

function thrownUnderMember(thrown: object): void {
  try {
    member(sensitive({}), () => {
      throw thrown;
    });
  } catch {
    // The object is marked on its way out.
  }
}

describe('markLabeled', () => {
  it('labels a thrown object so its later mint is labeled, as a throw under a labeled call does', () => {
    setSensitiveMode(true);
    const marked = new Error('marked');
    const underCall = new Error('under call');
    markLabeled(marked);
    thrownUnderMember(underCall);
    expect(isLabeled(marked)).toBe(true);
    expect(isLabeled(underCall)).toBe(true);
    const a = error(marked, 'evaluation');
    const b = error(underCall, 'evaluation');
    expect(reports.map((r) => r.sensitive)).toEqual([true, true]);
    expect(unbox(reports[0].cause)).toBe(marked);
    expect(redact(a)).toBe(PLACEHOLDER);
    expect(redact(b)).toBe(PLACEHOLDER);
  });

  it('a primitive, null, or an object already labeled: nothing registered', () => {
    setSensitiveMode(true);
    const box = sensitive('secret') as object;
    const once = new Error('once');
    markLabeled(once);
    const registered = counters.registered;
    markLabeled('plain');
    markLabeled(1);
    markLabeled(null);
    markLabeled(undefined);
    markLabeled(box);
    markLabeled(once);
    expect(counters.registered).toBe(registered);
    error('plain', 'evaluation');
    expect(reports.at(-1)?.sensitive).toBe(false);
  });

  it('mode off: nothing registered, and the object mints plain once the mode is on', () => {
    const thrown = new Error('off');
    const registered = counters.registered;
    markLabeled(thrown);
    expect(counters.registered).toBe(registered);
    expect(isLabeled(thrown)).toBe(false);
    setSensitiveMode(true);
    expect(isLabeled(thrown)).toBe(false);
    const e = error(thrown, 'evaluation');
    expect(reports.at(-1)).toMatchObject({ sensitive: false, cause: thrown });
    expect(redact(e)).toBe(e);
  });
});
