import {
  computed,
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  signal,
  type ResourceStatus,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { type CensusMember, memberId, type Precedence } from './census';
import { censusResource } from './census-resource';
import { BOUNDARY_CENSUS } from './census-token';
import { latest, use } from './latest';
import {
  createTransitionScope,
  getTransitionScope,
  provideForwardingTransitionScope,
  provideTransitionScope,
  type ForwardingTransitionScope,
  type ResourceLike,
  type TransitionScope,
} from './transition-scope';

type Fake = ResourceLike & {
  readonly status: WritableSignal<ResourceStatus>;
  readonly value: WritableSignal<unknown>;
  readonly error: WritableSignal<unknown>;
  reloads: number;
};

const IN_FLIGHT: readonly ResourceStatus[] = ['loading', 'reloading'];

/**
 * A resource whose `hasValue()` follows Angular's rule (no value on error) while `hasContent()`
 * counts a held value, the way a `keepPrevious` query behaves after a failed reload.
 */
function fake(
  status: ResourceStatus,
  value?: unknown,
  opt: { content?: boolean; reload?: boolean } = {},
): Fake {
  const status$ = signal<ResourceStatus>(status);
  const value$ = signal<unknown>(value);
  const ref: Fake = {
    status: status$,
    value: value$,
    error: signal<unknown>(status === 'error' ? new Error('boom') : undefined),
    isLoading: computed(() => IN_FLIGHT.includes(status$())),
    hasValue: () => status$() !== 'error' && value$() !== undefined,
    reloads: 0,
  };
  if (opt.content !== false)
    Object.assign(ref, { hasContent: () => value$() !== undefined });
  if (opt.reload !== false)
    Object.assign(ref, {
      reload: () => {
        ref.reloads++;
        status$.set(value$() === undefined ? 'loading' : 'reloading');
        return true;
      },
    });
  return ref;
}

const only = (scope: TransitionScope): CensusMember => {
  const [member] = scope.census.snapshot();
  return member;
};

describe('resourceMember × TransitionScope readiness table (M1)', () => {
  const statuses: ResourceStatus[] = [
    'idle',
    'loading',
    'reloading',
    'resolved',
    'local',
    'error',
  ];
  const rows = statuses.flatMap((status) =>
    [false, true].flatMap((content) =>
      [false, true].map((suspends) => ({ status, content, suspends })),
    ),
  );

  it.each(rows)(
    'status=$status hasContent=$content suspends=$suspends',
    ({ status, content, suspends }) => {
      const scope = createTransitionScope();
      scope.add(fake(status, content ? { held: true } : undefined), {
        suspends,
      });
      const member = only(scope);
      const inFlight = IN_FLIGHT.includes(status);
      const errored = status === 'error';

      expect(member.readiness).toBe(suspends);
      expect(member.pending()).toBe(suspends && !content && !errored);
      expect(member.inFlight()).toBe(inFlight);
      expect(member.failure() !== undefined).toBe(errored);
      expect(member.paused()).toBe(false);

      expect(scope.suspended('value')).toBe(suspends && !content && !errored);
      expect(scope.suspended('loading')).toBe(suspends && inFlight);
      expect(scope.failed()).toBe(errored && suspends && !content);
      expect(scope.errored().length).toBe(errored ? 1 : 0);
      expect(scope.pending()).toBe(inFlight);
    },
  );

  it('the placeholder-forever row: an errored suspending member with no content no longer suspends (was suspended forever)', () => {
    const scope = createTransitionScope();
    scope.add(fake('error'), { suspends: true });
    expect(scope.suspended('value')).toBe(false);
    expect(scope.failed()).toBe(true);
    expect(scope.errored()[0].failure.message).toBe('boom');
  });

  it('keepPrevious failed reload: content holds, failed stays false, the failure rides errored', () => {
    const ref = fake('error', { held: true });
    expect(ref.hasValue()).toBe(false); // Angular's rule: the reason hasContent exists
    const scope = createTransitionScope();
    scope.add(ref, { suspends: true });
    expect(scope.suspended('value')).toBe(false);
    expect(scope.failed()).toBe(false);
    expect(scope.errored().length).toBe(1);
  });

  it('without hasContent the adapter falls back to hasValue (a held value on error does not count)', () => {
    const scope = createTransitionScope();
    scope.add(fake('error', { held: true }, { content: false }), {
      suspends: true,
    });
    expect(scope.failed()).toBe(true);
  });

  it('paused with no content still suspends (pause suppresses requests, it is not a fold exit)', () => {
    const scope = createTransitionScope();
    scope.add(fake('idle'), { suspends: true });
    expect(scope.suspended('value')).toBe(true);
    expect(only(scope).paused()).toBe(false);
  });

  it('an indicator-only registration still drives pending and never blanks', () => {
    const scope = createTransitionScope();
    const ref = fake('loading');
    scope.add(ref, { suspends: false });
    expect(scope.pending()).toBe(true);
    expect(scope.suspended('value')).toBe(false);
    ref.status.set('error');
    expect(scope.failed()).toBe(false);
    expect(scope.errored().length).toBe(1);
  });

  it('RegisterOptions.displayName names the member and its errored entry (default "resource")', () => {
    const scope = createTransitionScope();
    scope.add(fake('error'), { displayName: 'user profile' });
    scope.add(fake('error'));
    expect(scope.errored().map((e) => e.failure.displayName)).toEqual([
      'user profile',
      'resource',
    ]);
    expect(scope.errored()[0].member.displayName).toBe('user profile');
  });

  it('a non-Error error yields no message; the member id is the scope site + the ref ordinal', () => {
    const scope = createTransitionScope();
    const ref = fake('error');
    ref.error.set('plain string');
    scope.add(ref);
    expect(only(scope).failure()?.message).toBeUndefined();
    expect(JSON.parse(only(scope).id)[0]).toBe('transition-scope');
  });
});

describe('TransitionScope over the census', () => {
  it('commit() releases when the last pending member settles into error (M2)', () => {
    const scope = createTransitionScope();
    const a = fake('loading');
    const b = fake('loading');
    scope.add(a);
    scope.add(b);
    const source = signal('old');
    const view = scope.commit(source);
    expect(view()).toBe('old');
    source.set('new');
    expect(view()).toBe('old');
    a.value.set(1);
    a.status.set('resolved');
    expect(view()).toBe('old'); // b still in flight
    b.status.set('error');
    expect(view()).toBe('new');
  });

  it("[CHARACTERIZED → flip] a registered latest whose status is 'error' while a used member reloads makes scope pending true (was false: pending read status)", () => {
    const a = fake('reloading', 1);
    const b = fake('error');
    const l = latest(() => [use(a as never), use(b as never)]);
    expect(l.status()).toBe('error');
    expect(l.isLoading()).toBe(true);
    const scope = createTransitionScope();
    scope.add(l, { suspends: false });
    expect(scope.pending()).toBe(true);
  });

  it('add/remove keep multiplicity: a ref added twice leaves after two removes', () => {
    const scope = createTransitionScope();
    const ref = fake('loading');
    scope.add(ref);
    scope.add(ref);
    expect(scope.census.snapshot().length).toBe(2);
    scope.remove(ref);
    expect(scope.resources()).toEqual([ref]);
    expect(scope.census.snapshot().length).toBe(1);
    expect(scope.suspended('value')).toBe(true);
    scope.remove(ref);
    expect(scope.resources()).toEqual([]);
    expect(scope.census.snapshot().length).toBe(0);
    expect(scope.suspended('value')).toBe(false);
  });

  it("the adapter's retry is the ref's reload, once per round (M3)", () => {
    const scope = createTransitionScope();
    const ref = fake('error');
    scope.add(ref);
    expect(scope.retryAll().dispatched).toBe(1);
    expect(ref.reloads).toBe(1);
    expect(scope.retryAll().dispatched).toBe(0); // in flight: never re-fired
    expect(ref.reloads).toBe(1);
    ref.status.set('error');
    expect(scope.retry(only(scope).id).dispatched).toBe(1);
    expect(ref.reloads).toBe(2);
  });

  it('a ref without reload is not retryable', () => {
    const scope = createTransitionScope();
    scope.add(fake('error', undefined, { reload: false }));
    expect(only(scope).retry).toBeUndefined();
    expect(scope.retryAll().dispatched).toBe(0);
  });

  it('dismiss hides a presented non-retryable failure until it fails again; failures ignores dismissal', () => {
    const scope = createTransitionScope();
    const id = memberId('facade', 1);
    const facade = scope.census.enroll({
      id,
      displayName: 'f',
      retry: undefined,
    });
    facade.started(1);
    facade.settled(1, {
      kind: 'error',
      error: { id, displayName: 'f', message: 'x', generation: 1 },
    });
    expect(scope.errored().length).toBe(1);
    scope.dismiss(scope.errored()[0]);
    expect(scope.errored().length).toBe(0);
    expect(scope.failures().length).toBe(1);
    facade.started(2);
    facade.settled(2, {
      kind: 'error',
      error: { id, displayName: 'f', message: 'y', generation: 2 },
    });
    expect(scope.errored().length).toBe(1);
    scope.dismissAll();
    expect(scope.errored().length).toBe(0);
  });

  it('a breached settlement deadline presents as failed instead of holding the placeholder', () => {
    let fire = () => undefined as void;
    const scope = createTransitionScope({
      deadline: { ms: 10, arm: (f) => ((fire = f), () => undefined) },
    });
    scope.add(fake('loading'));
    expect(scope.suspended('value')).toBe(true);
    fire();
    expect(scope.suspended('value')).toBe(false);
    expect(scope.failed()).toBe(true);
  });

  it("settled() resolves 'error' once the last pending member fails", async () => {
    const scope = createTransitionScope({ injector: TestBed.inject(Injector) });
    const ref = fake('loading');
    scope.add(ref);
    const settled = scope.settled();
    TestBed.tick();
    ref.status.set('error');
    TestBed.tick();
    TestBed.tick();
    await expect(settled).resolves.toBe('error');
  });
});

describe('precedence (both orders)', () => {
  const build = (order?: Precedence) => {
    const scope = createTransitionScope(order ? { precedence: order } : {});
    const failing = fake('error');
    const loading = fake('loading');
    scope.add(failing);
    scope.add(loading);
    return { scope, loading };
  };

  it('pending-first (default): a failure waits while another suspending member is pending', () => {
    for (const { scope, loading } of [build(), build('pending-first')]) {
      expect(scope.census.foldState().kind).toBe('pending');
      expect(scope.suspended('value')).toBe(true);
      expect(scope.failed()).toBe(false);
      expect(scope.errored().length).toBe(1);
      loading.value.set(1);
      loading.status.set('resolved');
      expect(scope.suspended('value')).toBe(false);
      expect(scope.failed()).toBe(true);
    }
  });

  it('error-first: the failure presents at once while another member still loads', () => {
    const { scope } = build('error-first');
    expect(scope.census.foldState().kind).toBe('error');
    expect(scope.suspended('value')).toBe(false);
    expect(scope.failed()).toBe(true);
    expect(scope.pending()).toBe(true); // the activity axis does not fold
  });

  it('error-first: an indicator-only failure does not end suspense while a suspending member has nothing', () => {
    const scope = createTransitionScope({ precedence: 'error-first' });
    scope.add(fake('error'), { suspends: false });
    scope.add(fake('loading'));
    expect(scope.census.foldState().kind).toBe('error');
    expect(scope.failed()).toBe(false);
    expect(scope.suspended('value')).toBe(true); // placeholder holds, no content shown
  });

  it('error-first: a held-content failure does not end suspense while another suspending member has nothing', () => {
    const scope = createTransitionScope({ precedence: 'error-first' });
    scope.add(fake('error', { held: true }));
    scope.add(fake('loading'));
    expect(scope.census.foldState().kind).toBe('error');
    expect(scope.failed()).toBe(false);
    expect(scope.suspended('value')).toBe(true);
  });

  it('pending-first: the same two rows read the fold alone (suspended via pending)', () => {
    for (const suspends of [false, true]) {
      const scope = createTransitionScope();
      scope.add(fake('error', suspends ? { held: true } : undefined), {
        suspends,
      });
      scope.add(fake('loading'));
      expect(scope.census.foldState().kind).toBe('pending');
      expect(scope.suspended('value')).toBe(true);
      expect(scope.failed()).toBe(false);
    }
  });
});

describe('the scope census is the boundary census', () => {
  const pump = async () => {
    for (let i = 0; i < 3; i++) {
      TestBed.tick();
      await Promise.resolve();
    }
  };

  it('provideTransitionScope provides its census as BOUNDARY_CENSUS; censusResource folds into it', async () => {
    const boundary = createEnvironmentInjector(
      [provideTransitionScope()],
      TestBed.inject(EnvironmentInjector),
    );
    const scope = getTransitionScope(boundary) as TransitionScope;
    expect(boundary.get(BOUNDARY_CENSUS)).toBe(scope.census);
    TestBed.runInInjectionContext(() =>
      censusResource({
        site: 'chunk',
        displayName: 'chunk',
        injector: boundary,
        params: () => 'x',
        loader: () => new Promise<string>(() => undefined),
      }),
    );
    await pump();
    expect(scope.census.snapshot().length).toBe(1);
    expect(scope.resources().length).toBe(0);
    expect(scope.suspended('value')).toBe(true);
    boundary.destroy();
  });

  it('a failed censusResource under the scope blanks: failed is true (no content witness)', async () => {
    const boundary = createEnvironmentInjector(
      [provideTransitionScope()],
      TestBed.inject(EnvironmentInjector),
    );
    const scope = getTransitionScope(boundary) as TransitionScope;
    TestBed.runInInjectionContext(() =>
      censusResource({
        site: 'chunk',
        displayName: 'chunk',
        injector: boundary,
        params: () => 'x',
        loader: () => Promise.reject(new Error('chunk failed')),
      }),
    );
    await pump();
    expect(scope.census.foldState().kind).toBe('error');
    expect(scope.suspended('value')).toBe(false);
    expect(scope.failed()).toBe(true); // the error slot condition
    expect(scope.errored()[0].member.displayName).toBe('chunk');
    boundary.destroy();
  });

  it('the forwarding census registers into the target current at registration; reads follow the target', () => {
    const inj = createEnvironmentInjector(
      [provideForwardingTransitionScope()],
      TestBed.inject(EnvironmentInjector),
    );
    const fwd = getTransitionScope(inj) as ForwardingTransitionScope;
    const census = inj.get(BOUNDARY_CENSUS);
    expect(census).toBe(fwd.census);
    const target = createTransitionScope();
    fwd.setTarget(target);
    const id = memberId('m', 1);
    const leave = census.register({
      id,
      displayName: 'm',
      readiness: true,
      paused: signal(false),
      pending: signal(false),
      inFlight: signal(false),
      failure: signal({ id, displayName: 'm', message: undefined }),
      retry: undefined,
    });
    expect(target.census.snapshot().length).toBe(1);
    expect(fwd.failed()).toBe(true); // a direct readiness member has no content witness
    expect(fwd.errored().length).toBe(1);
    fwd.setTarget(null);
    leave();
    expect(target.census.snapshot().length).toBe(0);
    inj.destroy();
  });
});
