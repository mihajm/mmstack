import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

interface ModelMember {
  readonly id: string;
  pending: boolean;
  generation: number;
  readonly capable: boolean;
  paused: boolean;
}
interface Round {
  readonly generation: number;
  readonly invoked: ReadonlyMap<string, number>;
}

function retryAll(
  snapshot: readonly ModelMember[],
  roundGeneration: number,
): {
  round: Round;
  invocations: readonly string[];
} {
  const invoked = new Map<string, number>();
  const invocations: string[] = [];
  for (const m of snapshot) {
    if (!m.capable || m.pending) continue;
    m.pending = true;
    m.generation += 1;
    invoked.set(m.id, m.generation);
    invocations.push(m.id);
  }
  return { round: { generation: roundGeneration, invoked }, invocations };
}

function settle(
  members: readonly ModelMember[],
  id: string,
  generation: number,
): void {
  const m = members.find((x) => x.id === id);
  if (m && m.pending && m.generation === generation) m.pending = false;
}

function roundSettled(round: Round, members: readonly ModelMember[]): boolean {
  const byId = new Map(members.map((m) => [m.id, m]));
  for (const [id, generation] of round.invoked) {
    const m = byId.get(id);
    if (!m || m.paused) continue;
    if (m.pending && m.generation === generation) return false;
  }
  return true;
}

const member = (id: string, over: Partial<ModelMember> = {}): ModelMember => ({
  id,
  pending: false,
  generation: 0,
  capable: true,
  paused: false,
  ...over,
});

describe('[PROVEN] retry rounds — atomic claim + generation + paused boundary (pure model)', () => {
  it('atomic no-op claim: a member already pending is NEVER re-fired by retryAll', () => {
    const inFlight = member('a', { pending: true, generation: 5 });
    const idle = member('b');
    const { invocations } = retryAll([inFlight, idle], 1);
    expect(invocations).toEqual(['b']);
    expect(inFlight.generation).toBe(5);
  });

  it('retryAll-parallel: all capable, non-pending members are claimed in ONE frame', () => {
    const a = member('a');
    const b = member('b');
    const messageOnly = member('c', { capable: false });
    const { invocations } = retryAll([a, b, messageOnly], 1);
    expect(invocations).toEqual(['a', 'b']);
    expect([a.pending, b.pending]).toEqual([true, true]);
  });

  it('round settles only when its invoked members are quiescent — not at a premature partial', () => {
    const a = member('a');
    const b = member('b');
    const { round } = retryAll([a, b], 1);
    expect(roundSettled(round, [a, b])).toBe(false);
    settle([a, b], 'a', a.generation);
    expect(roundSettled(round, [a, b])).toBe(false);
    settle([a, b], 'b', b.generation);
    expect(roundSettled(round, [a, b])).toBe(true);
  });

  it('generation: a stale completion for a superseded invocation never settles the round', () => {
    const a = member('a');
    const { round: r1 } = retryAll([a], 1);
    const staleGen = a.generation;
    retryAll([{ ...a, pending: false }], 2);
    a.generation += 1;
    settle([a], 'a', staleGen);
    expect(a.pending).toBe(true);
    expect(roundSettled(r1, [a])).toBe(true);
  });

  it('paused round-boundary: a paused snapshot member is excluded — the round settles on the rest', () => {
    const a = member('a');
    const b = member('b');
    const { round } = retryAll([a, b], 1);
    a.paused = true;
    settle([a, b], 'b', b.generation);
    expect(roundSettled(round, [a, b])).toBe(true);
  });

  it('property: repeated retryAll in one frame never double-fires an in-flight member', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 2, max: 5 }),
        (n, rounds) => {
          const members = Array.from({ length: n }, (_, i) => member(`m${i}`));
          let totalInvocations = 0;
          for (let r = 1; r <= rounds; r++)
            totalInvocations += retryAll(members, r).invocations.length;
          return (
            totalInvocations === n && members.every((m) => m.generation === 1)
          );
        },
      ),
    );
  });
});
