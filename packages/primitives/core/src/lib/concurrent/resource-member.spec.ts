import {
  computed,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { type CensusMember, memberId } from './census';
import { createCensus } from './census-registry';
import { resourceMember } from './resource-member';
import { type ResourceLike } from './transition-scope';

type Fake = ResourceLike & {
  status: WritableSignal<ResourceStatus>;
  error: WritableSignal<unknown>;
  reloads: number;
};

function fake(status: ResourceStatus = 'idle'): Fake {
  const s = signal<ResourceStatus>(status);
  const ref: Fake = {
    status: s,
    error: signal<unknown>(undefined),
    isLoading: computed(() => s() === 'loading' || s() === 'reloading'),
    hasValue: () => false,
    reload: () => {
      ref.reloads++;
      s.set('loading');
      return true;
    },
    reloads: 0,
  };
  return ref;
}

const opts = (key: string, suspends = true) => ({
  id: memberId('spec', key),
  displayName: key,
  suspends,
});

describe('resourceMember, kind: mutation', () => {
  it('is never a readiness member and has no retry, whatever suspends says', () => {
    const ref = fake('loading');
    const m = resourceMember(ref, { ...opts('save'), kind: 'mutation' });
    expect(m.readiness).toBe(false);
    expect(m.pending()).toBe(false);
    expect(m.inFlight()).toBe(true);
    expect(m.retry).toBeUndefined();
    expect(m.source).toBe(ref);
  });

  it('latches the failure the ref carries; the generation is the one the ref stamps, never object identity', () => {
    const lastFailure = signal<
      { readonly error: unknown; readonly generation: number } | undefined
    >(undefined);
    const ref = Object.assign(fake('idle'), {
      lastFailure: lastFailure.asReadonly(),
    });
    const m = resourceMember(ref, { ...opts('save'), kind: 'mutation' });
    expect(m.failure()).toBeUndefined();

    const error = new Error('one');
    lastFailure.set({ error, generation: 1 });
    ref.status.set('idle'); // the request cleared: the latch is what reports
    const a = m.failure();
    expect(a).toMatchObject({
      displayName: 'save',
      message: 'one',
      generation: 1,
    });
    expect(m.failure()).toBe(a);

    // the same error reference again, as a new failure: a new generation, so a dismissal of the
    // first does not swallow the second
    lastFailure.set({ error, generation: 2 });
    const b = m.failure();
    expect(b?.generation).toBe(2);

    lastFailure.set(undefined);
    expect(m.failure()).toBeUndefined();
  });

  it('without lastFailure it follows status as it happens', () => {
    const ref = fake('loading');
    const m = resourceMember(ref, { ...opts('save'), kind: 'mutation' });
    ref.error.set(new Error('x'));
    ref.status.set('error');
    expect(m.failure()).toMatchObject({ message: 'x' });
    expect(m.failure()?.generation).toBeUndefined();
    ref.status.set('idle');
    expect(m.failure()).toBeUndefined();
  });

  it('a resource member is unchanged by default', () => {
    const ref = fake('loading');
    const m = resourceMember(ref, opts('q'));
    expect(m.readiness).toBe(true);
    expect(m.pending()).toBe(true);
    expect(m.retry).toBeDefined();
    expect(m.source).toBe(ref);
  });
});

describe('census: one incident per source', () => {
  const failing = (key: string, source: object, readiness = true) => {
    const failed = signal(false);
    const member: CensusMember = {
      id: memberId('spec', key),
      displayName: key,
      readiness,
      paused: signal(false),
      pending: computed(() => readiness && !failed()),
      inFlight: computed(() => !failed()),
      failure: computed(() =>
        failed()
          ? { id: memberId('spec', key), displayName: key, message: key }
          : undefined,
      ),
      retry: { retry: () => calls.push(key) },
      source,
    };
    return { member, fail: () => failed.set(true) };
  };
  let calls: string[] = [];
  beforeEach(() => (calls = []));

  it('two members of one source fold, fail and retry as one; another source is its own', () => {
    const census = createCensus({ arm: () => undefined });
    const src = {};
    const a = failing('a', src, false);
    const b = failing('b', src, true);
    const c = failing('c', {}, true);
    census.register(a.member);
    census.register(b.member);
    census.register(c.member);
    expect(census.snapshot().length).toBe(3);
    expect(census.foldState()).toEqual({ kind: 'pending' });

    for (const x of [a, b, c]) x.fail();
    const fold = census.foldState();
    expect(fold.kind === 'error' && fold.failures.map((f) => f.id)).toEqual([
      b.member.id, // the readiness member represents the source
      c.member.id,
    ]);
    expect(census.errored().map((e) => e.member)).toEqual([b.member, c.member]);
    expect(census.retryAll().dispatched).toBe(2);
    expect(calls).toEqual(['b', 'c']);
  });

  it('the representative leaves, the other member takes over', () => {
    const census = createCensus({ arm: () => undefined });
    const src = {};
    const a = failing('a', src);
    const b = failing('b', src);
    const leaveA = census.register(a.member);
    census.register(b.member);
    a.fail();
    b.fail();
    expect(census.errored().map((e) => e.member.id)).toEqual([a.member.id]);
    leaveA();
    expect(census.errored().map((e) => e.member.id)).toEqual([b.member.id]);
  });

  it('a settlement deadline keeps the source, so armed members still dedup', () => {
    const census = createCensus({
      arm: () => undefined,
      deadline: { ms: 10, arm: () => () => undefined },
    });
    const src = {};
    const content = signal(true);
    const a = failing('a', src);
    census.register({ ...a.member, content });
    census.register(failing('b', src).member);
    expect(census.errored()).toEqual([]);
    a.fail();
    const [entry] = census.errored();
    expect(census.errored().length).toBe(1);
    expect(entry.member.source).toBe(src);
    expect(entry.member.content).toBe(content);
  });
});
