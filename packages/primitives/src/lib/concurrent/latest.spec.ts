import {
  computed,
  createEnvironmentInjector,
  EnvironmentInjector,
  resource,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type Signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { latest, type LatestSignal, use, type UseSource } from './latest';
import {
  getTransitionScope,
  provideTransitionScope,
  type ResourceLike,
} from './transition-scope';

// Compile-time contracts: a real ResourceRef passes to use() as-is, and a LatestSignal
// satisfies both surfaces (nesting + scope registration). Breaking any of these
// assignabilities is an API break, caught here without a runtime test.
type _RefIsUseSource = ResourceRef<number> extends UseSource<number> ? true : never;
type _RefIsResourceLike = ResourceRef<number> extends ResourceLike ? true : never;
type _LatestIsUseSource = LatestSignal<number> extends UseSource<number> ? true : never;
type _LatestIsResourceLike = LatestSignal<number> extends ResourceLike ? true : never;
const _contracts: [_RefIsUseSource, _RefIsResourceLike, _LatestIsUseSource, _LatestIsResourceLike] = [true, true, true, true];
void _contracts;

/**
 * A fake with Angular resource semantics where they matter to `use()`:
 *  - `value()` THROWS in the error state (like `ResourceRef.value`), so any test passing
 *    proves `use()` never touches `value` while errored;
 *  - `hasValue()` is false while errored;
 *  - read counters expose what `latest` actually touched (waterfall laziness proofs).
 */
function fakeRes<T>(init?: { status?: ResourceStatus; value?: T }) {
  const status = signal<ResourceStatus>(init?.status ?? 'idle');
  const value = signal<T | undefined>(init?.value);
  const error = signal<unknown>(undefined);
  const reads = { status: 0, value: 0 };

  const src: UseSource<T> & {
    reads: typeof reads;
    load(v: T): void;
    startLoad(): void;
    startReload(): void;
    fail(e: unknown): void;
    setLocal(v: T): void;
    dropToReload(): void;
    $status: WritableSignal<ResourceStatus>;
  } = {
    status: computed(() => {
      reads.status++;
      return status();
    }),
    value: computed(() => {
      reads.value++;
      if (status() === 'error') throw untracked(error);
      return value();
    }) as Signal<T | undefined>,
    hasValue: () => status() !== 'error' && value() !== undefined,
    error: computed(() => error()),
    reads,
    startLoad: () => status.set('loading'),
    startReload: () => status.set('reloading'),
    dropToReload: () => {
      value.set(undefined);
      status.set('reloading');
    },
    load: (v: T) => {
      value.set(v);
      error.set(undefined);
      status.set('resolved');
    },
    fail: (e: unknown) => {
      error.set(e);
      status.set('error');
    },
    setLocal: (v: T) => {
      value.set(v);
      status.set('local');
    },
    $status: status,
  };
  return src;
}

describe('latest / use', () => {
  describe('sync computations (no async members)', () => {
    it('behaves like a computed with resource dressing: immediate value, resolved, never pending', () => {
      const a = signal(2);
      const doubled = latest(() => a() * 2);

      expect(doubled()).toBe(4);
      expect(doubled.hasValue()).toBe(true);
      expect(doubled.status()).toBe('resolved');
      expect(doubled.pending()).toBe(false);
      expect(doubled.isLoading()).toBe(false);
      expect(doubled.error()).toBeUndefined();

      a.set(5);
      expect(doubled()).toBe(10);
    });

    it('is lazy and does not over-recompute', () => {
      const a = signal(1);
      const unrelated = signal(0);
      let runs = 0;
      const d = latest(() => {
        runs++;
        return a();
      });

      expect(runs).toBe(0); // nothing ran before the first read

      expect(d()).toBe(1);
      expect(d.status()).toBe('resolved');
      expect(d.pending()).toBe(false);
      expect(runs).toBe(1); // one evaluation serves value + status + pending

      unrelated.set(99);
      expect(d()).toBe(1);
      expect(runs).toBe(1); // untracked signal writes don't invalidate

      a.set(2);
      expect(d()).toBe(2);
      expect(d()).toBe(2);
      expect(runs).toBe(2); // exactly one re-run per relevant change
    });
  });

  describe('first load', () => {
    it('reports not-ready while the member has no value, then produces once it lands', () => {
      const user = fakeRes<{ name: string }>({ status: 'loading' });
      const name = latest(() => use(user).name);

      expect(name()).toBeUndefined();
      expect(name.hasValue()).toBe(false);
      expect(name.status()).toBe('loading');
      expect(name.pending()).toBe(true);

      user.load({ name: 'Ada' });
      expect(name()).toBe('Ada');
      expect(name.hasValue()).toBe(true);
      expect(name.status()).toBe('resolved');
      expect(name.pending()).toBe(false);
    });

    it('an idle member with no value maps to idle (blocked, nothing in flight)', () => {
      const r = fakeRes<number>();
      const d = latest(() => use(r) + 1);

      expect(d()).toBeUndefined();
      expect(d.status()).toBe('idle');
      expect(d.pending()).toBe(false);
      expect(d.hasValue()).toBe(false);
    });

    it('a local (set) value flows like any other value', () => {
      const r = fakeRes<number>();
      const d = latest(() => use(r) * 10);

      r.setLocal(4);
      expect(d()).toBe(40);
      expect(d.status()).toBe('resolved');
      expect(d.pending()).toBe(false);
    });
  });

  describe('hold-previous while pending (the stale-while-revalidate atom)', () => {
    it('holds the previous result when a reloading member drops its value', () => {
      const r = fakeRes<number>({ status: 'resolved', value: 1 });
      const d = latest(() => use(r) * 10);
      expect(d()).toBe(10);

      // reload drops the value (a resource without keepPrevious)
      r.dropToReload();

      expect(d()).toBe(10); // held — never flashes undefined
      expect(d.hasValue()).toBe(true);
      expect(d.status()).toBe('reloading');
      expect(d.pending()).toBe(true);

      r.load(2);
      expect(d()).toBe(20);
      expect(d.status()).toBe('resolved');
      expect(d.pending()).toBe(false);
    });

    it('recomputes through a member that keeps its value during reload, flagging reloading', () => {
      const r = fakeRes<number>({ status: 'resolved', value: 3 });
      const d = latest(() => use(r) + 1);
      expect(d()).toBe(4);

      r.startReload(); // keepPrevious-style: value stays present
      expect(d()).toBe(4); // stale value still flows
      expect(d.status()).toBe('reloading');
      expect(d.pending()).toBe(true);

      r.load(7);
      expect(d()).toBe(8);
      expect(d.status()).toBe('resolved');
    });
  });

  describe('pending × equal (in-flight cycles that land on an equal value)', () => {
    it('pending cycles while the value signal never notifies consumers', () => {
      const r = fakeRes<{ id: number; label: string }>({
        status: 'resolved',
        value: { id: 1, label: 'a' },
      });
      const d = latest(() => use(r).id, {});

      let notifications = 0;
      const watcher = computed(() => {
        notifications++;
        return d();
      });

      expect(watcher()).toBe(1);
      expect(notifications).toBe(1);

      r.startReload();
      expect(d.pending()).toBe(true); // flight is visible...
      expect(watcher()).toBe(1);
      expect(notifications).toBe(1); // ...but blocked-hold produced no notification

      r.load({ id: 1, label: 'b' }); // recomputes to an EQUAL result (same id)
      expect(d.pending()).toBe(false);
      expect(watcher()).toBe(1);
      expect(notifications).toBe(1); // equal recompute: consumers never re-ran

      r.load({ id: 2, label: 'b' }); // a real change does notify
      expect(watcher()).toBe(2);
      expect(notifications).toBe(2);
    });

    it('honors a custom equal for the held value', () => {
      const r = fakeRes<{ id: number; rev: number }>({
        status: 'resolved',
        value: { id: 1, rev: 1 },
      });
      const d = latest(() => ({ ...use(r) }), {
        equal: (a, b) => a.id === b.id,
      });

      let notifications = 0;
      const watcher = computed(() => {
        notifications++;
        return d()?.rev;
      });

      expect(watcher()).toBe(1);
      r.load({ id: 1, rev: 2 }); // fresh object, equal by id
      expect(watcher()).toBe(1); // held value not replaced, no notification
      expect(notifications).toBe(1);

      r.load({ id: 2, rev: 3 });
      expect(watcher()).toBe(3);
      expect(notifications).toBe(2);
    });
  });

  describe('waterfalls & dynamic dependency sets', () => {
    it('does not touch downstream members until upstream has a value', () => {
      const user = fakeRes<{ orgId: string }>({ status: 'loading' });
      const org = fakeRes<{ name: string }>({ status: 'loading' });

      const label = latest(() => {
        const u = use(user);
        void u.orgId;
        return use(org).name;
      });

      expect(label()).toBeUndefined();
      expect(label.pending()).toBe(true);
      expect(org.reads.status).toBe(0); // org is not yet a dependency at all
      expect(org.reads.value).toBe(0);

      user.load({ orgId: 'o1' });
      expect(label()).toBeUndefined(); // now blocked on org
      expect(label.pending()).toBe(true); // pending now attributed to org
      expect(org.reads.status).toBeGreaterThan(0);

      org.load({ name: 'mmstack' });
      expect(label()).toBe('mmstack');
      expect(label.status()).toBe('resolved');
      expect(label.pending()).toBe(false);
    });

    it("drops a member from the aggregate when a branch stops reading it", () => {
      const a = fakeRes<number>({ status: 'resolved', value: 1 });
      const b = fakeRes<number>({ status: 'resolved', value: 2 });
      const useA = signal(true);
      const d = latest(() => (useA() ? use(a) : use(b)));

      expect(d()).toBe(1);
      a.startReload();
      expect(d.pending()).toBe(true); // a's flight counts while a is read

      useA.set(false);
      expect(d()).toBe(2);
      expect(d.pending()).toBe(false); // a still in flight, but no longer a member

      b.startReload();
      expect(d.pending()).toBe(true); // b's flight counts now
    });

    it('reading the same source twice registers it once and still returns values', () => {
      const r = fakeRes<number>({ status: 'resolved', value: 5 });
      const d = latest(() => use(r) + use(r));
      expect(d()).toBe(10);
      expect(d.status()).toBe('resolved');
    });
  });

  describe('errors', () => {
    it('member error: status error, error surfaced, previous value held (value never read while errored)', () => {
      const r = fakeRes<number>({ status: 'resolved', value: 1 });
      const d = latest(() => use(r) * 10);
      expect(d()).toBe(10);

      const boom = new Error('boom');
      r.fail(boom);
      const valueReadsBeforeError = r.reads.value;
      expect(d()).toBe(10); // held
      expect(r.reads.value).toBe(valueReadsBeforeError); // value never touched while errored
      expect(d.hasValue()).toBe(true);
      expect(d.status()).toBe('error');
      expect(d.error()).toBe(boom);
      expect(d.pending()).toBe(false);

      r.load(3); // recovery
      expect(d()).toBe(30);
      expect(d.status()).toBe('resolved');
      expect(d.error()).toBeUndefined();
    });

    it('first-load error: no value, hasValue false, status error', () => {
      const r = fakeRes<number>({ status: 'loading' });
      const d = latest(() => use(r));

      r.fail(new Error('nope'));
      expect(d()).toBeUndefined();
      expect(d.hasValue()).toBe(false);
      expect(d.status()).toBe('error');
    });

    it('a thrown computation error surfaces as status error and holds the previous value', () => {
      const mode = signal<'ok' | 'throw'>('ok');
      const d = latest(() => {
        if (mode() === 'throw') throw new Error('user code');
        return 42;
      });

      expect(d()).toBe(42);
      mode.set('throw');
      expect(d()).toBe(42); // held
      expect(d.status()).toBe('error');
      expect((d.error() as Error).message).toBe('user code');

      mode.set('ok');
      expect(d.status()).toBe('resolved');
    });

    it('error takes precedence over in-flight work, while pending stays honest', () => {
      const bad = fakeRes<number>({ status: 'resolved', value: 1 });
      const slow = fakeRes<number>({ status: 'resolved', value: 2 });
      const d = latest(() => use(bad) + use(slow));
      expect(d()).toBe(3);

      const err = new Error('x');
      bad.fail(err);
      slow.startReload();
      expect(d.status()).toBe('error');
      expect(d.error()).toBe(err);
      // `bad` blocks before `slow` is read this round, so the flight isn't part of
      // the current dependency set — the aggregate reports the error, not the flight.
      expect(d.pending()).toBe(false);
    });

    it('reports the first erroring member in read order', () => {
      const a = fakeRes<number>({ status: 'resolved', value: 1 });
      const b = fakeRes<number>({ status: 'resolved', value: 2 });
      const d = latest(() => use(a) + use(b));
      expect(d()).toBe(3);

      const ea = new Error('a');
      const eb = new Error('b');
      b.fail(eb);
      a.fail(ea);
      expect(d.error()).toBe(ea); // a is read first
    });
  });

  describe('nesting (latest inside latest)', () => {
    it('propagates first-load blocking through an inner latest', () => {
      const user = fakeRes<{ name: string }>({ status: 'loading' });
      const inner = latest(() => use(user).name);
      const outer = latest(() => `hello ${use(inner)}`);

      expect(outer()).toBeUndefined();
      expect(outer.hasValue()).toBe(false);
      expect(outer.status()).toBe('loading'); // inner is 'loading' → in flight
      expect(outer.pending()).toBe(true);

      user.load({ name: 'Ada' });
      expect(outer()).toBe('hello Ada');
      expect(outer.status()).toBe('resolved');
      expect(outer.pending()).toBe(false);
    });

    it('propagates reloading + held value through an inner latest', () => {
      const user = fakeRes<{ name: string }>({ status: 'resolved', value: { name: 'Ada' } });
      const inner = latest(() => use(user).name);
      const outer = latest(() => `hello ${use(inner)}`);
      expect(outer()).toBe('hello Ada');

      user.dropToReload(); // drop + reload: inner holds 'Ada'
      expect(inner()).toBe('Ada');
      expect(inner.status()).toBe('reloading');

      expect(outer()).toBe('hello Ada'); // held value flows through
      expect(outer.status()).toBe('reloading'); // ...and so does the flight
      expect(outer.pending()).toBe(true);

      user.load({ name: 'Grace' });
      expect(outer()).toBe('hello Grace');
      expect(outer.pending()).toBe(false);
    });

    it('propagates an inner error as the outer error', () => {
      const r = fakeRes<number>({ status: 'resolved', value: 1 });
      const inner = latest(() => use(r));
      const outer = latest(() => use(inner) + 1);
      expect(outer()).toBe(2);

      const boom = new Error('inner boom');
      r.fail(boom);
      expect(outer.status()).toBe('error');
      expect(outer.error()).toBe(boom);
      expect(outer()).toBe(2); // outer holds too
    });
  });

  describe('use() outside latest()', () => {
    it('throws a descriptive error, like inject() outside a context', () => {
      const r = fakeRes<number>({ status: 'resolved', value: 1 });
      expect(() => use(r)).toThrowError(/use\(\) must be called synchronously/);
    });

    it('a throwing computation does not leak its collector frame', () => {
      const d = latest((): number => {
        throw new Error('always');
      });
      expect(d()).toBeUndefined();
      // if the frame leaked, this would now silently "work":
      const r = fakeRes<number>({ status: 'resolved', value: 1 });
      expect(() => use(r)).toThrowError(/use\(\) must be called/);
    });
  });

  describe('transition scope registration', () => {
    it("register: 'indicator' drives the scope's pending, without suspending the boundary", () => {
      TestBed.configureTestingModule({ providers: [provideTransitionScope()] });
      const env = TestBed.inject(EnvironmentInjector);
      const scope = getTransitionScope(env);
      if (!scope) throw new Error('scope not provided');

      const r = fakeRes<number>({ status: 'loading' });
      const d = latest(() => use(r), { register: 'indicator', injector: env });

      expect(scope.resources()).toContain(d);
      expect(d.status()).toBe('loading');
      expect(scope.pending()).toBe(true); // the derivation's aggregate drives the scope
      expect(scope.suspended('value')).toBe(false); // indicator never suspends

      r.load(1);
      expect(scope.pending()).toBe(false);
    });

    it("register: 'suspend' gates the first-load placeholder until a value is held", () => {
      TestBed.configureTestingModule({ providers: [provideTransitionScope()] });
      const env = TestBed.inject(EnvironmentInjector);
      const scope = getTransitionScope(env);
      if (!scope) throw new Error('scope not provided');

      const r = fakeRes<number>({ status: 'loading' });
      const d = latest(() => use(r), { register: 'suspend', injector: env });

      expect(scope.suspended('value')).toBe(true); // no value yet → placeholder

      r.load(1);
      expect(d()).toBe(1);
      expect(scope.suspended('value')).toBe(false);

      r.dropToReload(); // reload that drops the member's value
      expect(scope.suspended('value')).toBe(false); // held value → no re-suspend
      expect(scope.pending()).toBe(true);
    });

    it('deregisters when the registering injector is destroyed', () => {
      TestBed.configureTestingModule({ providers: [provideTransitionScope()] });
      const parent = TestBed.inject(EnvironmentInjector);
      const scope = getTransitionScope(parent);
      if (!scope) throw new Error('scope not provided');

      const child = createEnvironmentInjector([], parent);
      const r = fakeRes<number>({ status: 'loading' });
      const d = latest(() => use(r), { register: 'indicator', injector: child });

      expect(scope.resources()).toContain(d);
      expect(scope.pending()).toBe(true);

      child.destroy();
      expect(scope.resources()).not.toContain(d);
      expect(scope.pending()).toBe(false); // the in-flight member no longer leaks in
    });
  });

  describe('integration with a real Angular resource()', () => {
    // drive the resource's loader effect + settle its value microtasks
    const flush = async () => {
      TestBed.tick();
      await Promise.resolve();
      await Promise.resolve();
      TestBed.tick();
    };

    function realResource() {
      const id = TestBed.runInInjectionContext(() => signal(1));
      const resolvers: PromiseWithResolvers<{ name: string }>[] = [];
      const res = TestBed.runInInjectionContext(() =>
        resource({
          params: () => id(),
          loader: () => {
            const deferred = Promise.withResolvers<{ name: string }>();
            resolvers.push(deferred);
            return deferred.promise;
          },
        }),
      );
      return { id, res, resolvers };
    }

    it('first load blocks, resolution flows through — against the real status machine', async () => {
      const { res, resolvers } = realResource();
      const label = TestBed.runInInjectionContext(() =>
        latest(() => `hello ${use(res).name}`),
      );

      await flush(); // loader is now in flight
      expect(label()).toBeUndefined();
      expect(label.hasValue()).toBe(false);
      expect(label.status()).toBe('loading');
      expect(label.pending()).toBe(true);

      resolvers[0].resolve({ name: 'Ada' });
      await flush();

      expect(label()).toBe('hello Ada');
      expect(label.status()).toBe('resolved');
      expect(label.pending()).toBe(false);
    });

    it('holds through a param-change reload while the real resource drops its value', async () => {
      const { id, res, resolvers } = realResource();
      const label = TestBed.runInInjectionContext(() =>
        latest(() => `hello ${use(res).name}`),
      );

      await flush();
      resolvers[0].resolve({ name: 'Ada' });
      await flush();
      expect(label()).toBe('hello Ada');

      id.set(2); // new params → real resource reloads (value drops to undefined)
      await flush();

      expect(label()).toBe('hello Ada'); // held — never flashes
      expect(label.pending()).toBe(true);
      expect(label.status()).toBe('reloading');

      resolvers[1].resolve({ name: 'Grace' });
      await flush();
      expect(label()).toBe('hello Grace');
      expect(label.pending()).toBe(false);
    });

    it("survives the real error state — where resource.value() actually throws", async () => {
      const { res, resolvers } = realResource();
      const label = TestBed.runInInjectionContext(() =>
        latest(() => `hello ${use(res).name}`),
      );

      await flush();
      resolvers[0].resolve({ name: 'Ada' });
      await flush();
      expect(label()).toBe('hello Ada');

      res.reload();
      await flush();
      const boom = new Error('load failed');
      resolvers[1].reject(boom);
      await flush();

      expect(res.status()).toBe('error'); // the real machine is errored…
      expect(label()).toBe('hello Ada'); // …latest holds, and never touched value()
      expect(label.status()).toBe('error');
      expect(label.error()).toBe(boom);

      res.reload(); // recovery
      await flush();
      resolvers[2].resolve({ name: 'Grace' });
      await flush();
      expect(label()).toBe('hello Grace');
      expect(label.status()).toBe('resolved');
      expect(label.error()).toBeUndefined();
    });

    it('a local set() flows through like any settled value', async () => {
      const { res, resolvers } = realResource();
      const label = TestBed.runInInjectionContext(() =>
        latest(() => `hello ${use(res).name}`),
      );

      await flush();
      resolvers[0].resolve({ name: 'Ada' });
      await flush();

      res.set({ name: 'Locally' });
      expect(label()).toBe('hello Locally');
      expect(label.status()).toBe('resolved');
      expect(label.pending()).toBe(false);
    });
  });

  describe('status ladder', () => {
    it('walks idle → loading → resolved → reloading → resolved', () => {
      const r = fakeRes<number>();
      const d = latest(() => use(r));

      expect(d.status()).toBe('idle');
      r.startLoad();
      expect(d.status()).toBe('loading');
      r.load(1);
      expect(d.status()).toBe('resolved');
      r.startReload();
      expect(d.status()).toBe('reloading');
      r.load(2);
      expect(d.status()).toBe('resolved');
    });
  });
});
