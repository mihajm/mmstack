import { computed, signal } from '@angular/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type CensusMember, type ErroredEntry, memberId } from './census';
import {
  dismissAllEntries,
  dismissEntry,
  EMPTY_DISMISSALS,
  isDismissable,
  presentedErrored,
  type DismissalMap,
} from './dismiss';

interface EntryOptions {
  readonly generation?: number;
  readonly retryable?: boolean;
}

function entry(
  name: string,
  { generation, retryable = false }: EntryOptions = {},
): ErroredEntry {
  const id = memberId(name, 0);
  const never = signal(false);
  const member: CensusMember = {
    id,
    displayName: name,
    readiness: false,
    paused: never,
    pending: computed(() => false),
    inFlight: computed(() => false),
    failure: computed(() => undefined),
    retry: retryable ? { retry: () => undefined } : undefined,
  };
  return {
    member,
    failure: {
      id,
      displayName: name,
      message: `${name} failed`,
      ...(generation !== undefined ? { generation } : {}),
    },
  };
}

const ids = (entries: readonly ErroredEntry[]): string[] =>
  entries.map((e) => String(e.member.id));

describe('[PROVEN] dismiss laws — pure presentation projection', () => {
  it('dismiss hides exactly the (id, generation) pair', () => {
    const act = entry('act', { generation: 3 });
    const other = entry('other', { generation: 1 });
    const dismissed = dismissEntry(EMPTY_DISMISSALS, act);

    expect(ids(presentedErrored([act, other], dismissed))).toEqual([
      String(other.member.id),
    ]);
    const olderGeneration = {
      ...act,
      failure: { ...act.failure, generation: 2 },
    };
    expect(ids(presentedErrored([olderGeneration, other], dismissed))).toEqual(
      ids([olderGeneration, other]),
    );
  });

  it('a NEWER failure generation than the dismissal is presented again', () => {
    const failed = entry('act', { generation: 2 });
    const dismissed = dismissEntry(EMPTY_DISMISSALS, failed);
    expect(presentedErrored([failed], dismissed)).toEqual([]);

    const failedAgain = {
      ...failed,
      failure: { ...failed.failure, generation: 3 },
    };
    expect(presentedErrored([failedAgain], dismissed)).toEqual([failedAgain]);
  });

  it('generation-less and retry-carrying entries are never filtered; dismiss on them is a no-op', () => {
    const rendererTrip = entry('trip');
    const connector = entry('conn', { generation: undefined, retryable: true });
    const retryAct = entry('retry-act', { generation: 5, retryable: true });

    expect(isDismissable(rendererTrip)).toBe(false);
    expect(isDismissable(connector)).toBe(false);
    expect(isDismissable(retryAct)).toBe(false);

    let dismissed: DismissalMap = EMPTY_DISMISSALS;
    for (const e of [rendererTrip, connector, retryAct]) {
      const next = dismissEntry(dismissed, e);
      expect(next).toBe(dismissed);
      dismissed = next;
    }
    const forged: DismissalMap = new Map([
      [String(rendererTrip.member.id), 1],
      [String(connector.member.id), 1],
    ]);
    expect(presentedErrored([rendererTrip, connector], forged)).toEqual([
      rendererTrip,
      connector,
    ]);
    expect(
      presentedErrored([retryAct], dismissEntry(EMPTY_DISMISSALS, retryAct)),
    ).toEqual([retryAct]);
  });

  it('dismissAll ≡ folding dismissEntry over the dismissable subset; non-dismissable untouched', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom('act', 'connector', 'trip'),
            generation: fc.integer({ min: 1, max: 5 }),
          }),
          { maxLength: 8 },
        ),
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 7 }),
            fc.integer({ min: 1, max: 5 }),
          ),
        ),
        (shapes, priorDismissals) => {
          const entries = shapes.map((shape, index) =>
            entry(`m${index}`, {
              generation: shape.kind === 'trip' ? undefined : shape.generation,
              retryable: shape.kind === 'connector',
            }),
          );
          const prior = new Map(
            priorDismissals
              .filter(
                ([index]) =>
                  index < entries.length && isDismissable(entries[index]),
              )
              .map(([index, generation]) => [
                String(entries[index].member.id),
                generation,
              ]),
          );

          const swept = dismissAllEntries(prior, entries);
          let folded: DismissalMap = prior;
          for (const e of entries) {
            if (isDismissable(e)) folded = dismissEntry(folded, e);
          }
          expect(new Map(swept)).toEqual(new Map(folded));
          const presented = presentedErrored(entries, swept);
          for (const e of entries) {
            if (!isDismissable(e)) expect(presented).toContain(e);
          }
        },
      ),
    );
  });

  it('idempotence + unknown-id dismissals are inert', () => {
    const act = entry('act', { generation: 4 });
    const once = dismissEntry(EMPTY_DISMISSALS, act);
    const twice = dismissEntry(once, act);
    expect(new Map(twice)).toEqual(new Map(once));
    expect(presentedErrored([act], twice)).toEqual(
      presentedErrored([act], once),
    );

    const withUnknown = new Map(once);
    withUnknown.set(String(memberId('long-gone', 0)), 9);
    expect(presentedErrored([act], withUnknown)).toEqual(
      presentedErrored([act], once),
    );
    expect(dismissAllEntries(withUnknown, [act])).toBe(withUnknown);
  });

  it('the presentation-error predicate is presentedErrored(...).length > 0', () => {
    const act = entry('act', { generation: 1 });
    const connector = entry('conn', { retryable: true });

    let dismissed = dismissAllEntries(EMPTY_DISMISSALS, [act]);
    expect(presentedErrored([act], dismissed).length > 0).toBe(false);

    dismissed = dismissAllEntries(EMPTY_DISMISSALS, [act, connector]);
    expect(presentedErrored([act, connector], dismissed).length > 0).toBe(true);
    expect(presentedErrored([act, connector], dismissed)).toEqual([connector]);
  });
});
