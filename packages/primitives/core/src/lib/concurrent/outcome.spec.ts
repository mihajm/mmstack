import { computed, type ResourceStatus, signal } from '@angular/core';
import {
  type ErrorMintReport,
  isError,
  isLoading,
  isSentinel,
  setErrorReporter,
} from '../semantics/sentinel';
import { outcomeErrorCause, outcomeOf, type OutcomeSource } from './outcome';

const STATUSES: readonly ResourceStatus[] = [
  'idle',
  'loading',
  'reloading',
  'resolved',
  'local',
  'error',
];

/**
 * A fake ref. `content` drives `hasContent` when `withHasContent`, otherwise `hasValue`. `value()`
 * throws while errored (Angular `ResourceRef` semantics), so a passing row proves the outcome never
 * reads it there.
 */
function fakeRef(init: {
  status: ResourceStatus;
  content: boolean;
  withHasContent: boolean;
  value?: unknown;
  error?: unknown;
}) {
  const status = signal(init.status);
  const content = signal(init.content);
  const value = signal<unknown>(init.value ?? 'v');
  const error = signal<unknown>(init.error);
  const ref: OutcomeSource<unknown> & {
    $status: typeof status;
    $error: typeof error;
    $value: typeof value;
  } = {
    status,
    value: computed(() => {
      if (status() === 'error') throw new Error('value() read while errored');
      return content() ? value() : undefined;
    }),
    hasValue: () => !init.withHasContent && content(),
    ...(init.withHasContent ? { hasContent: () => content() } : {}),
    error,
    $status: status,
    $error: error,
    $value: value,
  };
  return ref;
}

/** The outcome table from the `outcomeOf` docs, as an oracle. */
function expected(status: ResourceStatus, content: boolean) {
  if (status === 'error') return 'error';
  if (status === 'loading' || status === 'reloading')
    return content ? 'value' : 'loading';
  return content ? 'value' : 'undefined';
}

function classify(out: unknown) {
  if (isError(out)) return 'error';
  if (isLoading(out)) return 'loading';
  if (out === undefined) return 'undefined';
  return isSentinel(out) ? 'other-sentinel' : 'value';
}

describe('outcomeOf (M5 outcome table)', () => {
  let reports: ErrorMintReport[];
  beforeEach(() => {
    reports = [];
    setErrorReporter((r) => reports.push(r));
  });
  afterEach(() => setErrorReporter(undefined));

  for (const withHasContent of [true, false]) {
    for (const status of STATUSES) {
      for (const content of [true, false]) {
        const want = expected(status, content);
        it(`${status} × content ${content} (${withHasContent ? 'hasContent' : 'hasValue fallback'}) → ${want}`, () => {
          const ref = fakeRef({
            status,
            content,
            withHasContent,
            value: 42,
            error: new Error('e'),
          });
          const out = outcomeOf(ref)();
          expect(classify(out)).toBe(want);
          if (want === 'value') expect(out).toBe(42);
          if (want === 'error') {
            expect(reports.length).toBe(1);
            expect(reports[0].origin).toBe('edge');
            expect(reports[0].subclass).toBe('external-fault');
          } else expect(reports.length).toBe(0);
        });
      }
    }
  }

  it('hasContent wins over hasValue: a held value through a failed reload is content, but the outcome still says error', () => {
    const ref = fakeRef({
      status: 'reloading',
      content: true,
      withHasContent: true,
      value: 1,
    });
    expect(outcomeOf(ref)()).toBe(1);
    ref.$error.set(new Error('reload failed'));
    ref.$status.set('error');
    expect(isError(outcomeOf(ref)())).toBe(true);
  });

  it('memoized per ref: the same signal for the same source', () => {
    const ref = fakeRef({
      status: 'idle',
      content: false,
      withHasContent: false,
    });
    expect(outcomeOf(ref)).toBe(outcomeOf(ref));
  });

  it('mint-once: re-reading the same error returns the same sentinel and reports once', () => {
    const boom = new Error('boom');
    const ref = fakeRef({
      status: 'error',
      content: false,
      withHasContent: true,
      error: boom,
    });
    const first = outcomeOf(ref)();
    // a recompute that lands on the same failure (status leaves error and comes back)
    ref.$status.set('reloading');
    outcomeOf(ref)();
    ref.$status.set('error');
    const again = outcomeOf(ref)();
    expect(again).toBe(first);
    expect(reports).toEqual([
      { origin: 'edge', subclass: 'external-fault', cause: boom },
    ]);
    expect(outcomeErrorCause(first as never)).toEqual({ cause: boom });
  });

  it('mint-once across a recovery: A → recover → A again re-reads A’s sentinel; a new failure mints once more', () => {
    const a = new Error('a');
    const b = new Error('b');
    const ref = fakeRef({
      status: 'error',
      content: false,
      withHasContent: true,
      error: a,
    });
    const out = outcomeOf(ref);
    const sa = out();
    ref.$status.set('resolved');
    expect(classify(out())).toBe('undefined');
    ref.$status.set('error');
    expect(out()).toBe(sa);
    ref.$error.set(b);
    const sb = out();
    expect(sb).not.toBe(sa);
    expect(reports.map((r) => r.cause)).toEqual([a, b]);
  });

  it('a primitive failure is remembered while it stays the latest one', () => {
    const ref = fakeRef({
      status: 'error',
      content: false,
      withHasContent: true,
      error: 'down',
    });
    const out = outcomeOf(ref);
    const s1 = out();
    ref.$status.set('loading');
    out();
    ref.$status.set('error');
    expect(out()).toBe(s1);
    expect(reports.length).toBe(1);
  });

  it('the loading sentinel is minted once per ref and names the ref', () => {
    const ref = fakeRef({
      status: 'loading',
      content: false,
      withHasContent: true,
    });
    const out = outcomeOf(ref, { name: 'user' });
    const l1 = out();
    ref.$status.set('reloading');
    expect(out()).toBe(l1);
    expect((l1 as { source: unknown }).source).toEqual({
      kind: 'resource',
      name: 'user',
    });
  });
});
