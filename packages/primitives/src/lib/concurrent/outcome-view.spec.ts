/* eslint-disable @angular-eslint/component-selector */
import {
  Component,
  computed,
  inject,
  InjectionToken,
  Injector,
  input,
  type OnInit,
  runInInjectionContext,
  type ResourceStatus,
  signal,
  type Signal,
  viewChild,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  DONE,
  type ErrorMintReport,
  isError,
  isLoading,
  isSentinel,
  outcomeOf,
  setErrorReporter,
  injectTransitionScope,
  latest,
  provideTransitionScope,
  registerResource,
  type TransitionScope,
  use,
} from '@mmstack/primitives/core';
import { MmOutcome, type MmOutcomeSource } from './outcome-view';
import { SuspenseBoundary } from './suspense-boundary';

type FakeRes = MmOutcomeSource<string> & {
  readonly reloads: () => number;
  load(): void;
  resolve(v: string): void;
  fail(e: unknown): void;
};

function makeRes(
  initial: ResourceStatus = 'loading',
  opts: { outcome?: Signal<unknown> } = {},
): FakeRes {
  const status = signal<ResourceStatus>(initial);
  const value = signal<string | undefined>(undefined);
  const error = signal<unknown>(undefined);
  let reloads = 0;
  return {
    status,
    value,
    error,
    isLoading: computed(
      () => status() === 'loading' || status() === 'reloading',
    ),
    hasValue: () => status() !== 'error' && value() !== undefined,
    hasContent: () => value() !== undefined,
    reload: () => {
      reloads++;
      status.set(value() === undefined ? 'loading' : 'reloading');
      error.set(undefined);
      return true;
    },
    reloads: () => reloads,
    load: () => status.set(value() === undefined ? 'loading' : 'reloading'),
    resolve: (v) => {
      value.set(v);
      error.set(undefined);
      status.set('resolved');
    },
    fail: (e) => {
      error.set(e);
      status.set('error');
    },
    ...(opts.outcome ? { outcome: opts.outcome } : {}),
  } as FakeRes;
}

/** Scopes seen by probes, by probe name. */
const SCOPES = new InjectionToken<Map<string, TransitionScope>>('scopes');

@Component({ selector: 'probe', template: '' })
class Probe implements OnInit {
  readonly name = input.required<string>();
  private readonly scope = injectTransitionScope();
  private readonly scopes = inject(SCOPES);
  ngOnInit(): void {
    this.scopes.set(this.name(), this.scope);
  }
}

const RES = new InjectionToken<FakeRes>('res');

/** Enrols the shared resource into the scope it is created in. */
@Component({ selector: 'enrol', template: '' })
class Enrol implements OnInit {
  readonly suspends = input(true);
  private readonly injector = inject(Injector);
  ngOnInit(): void {
    runInInjectionContext(this.injector, () =>
      registerResource(inject(RES), {
        suspends: this.suspends(),
        displayName: 'enrolled',
      }),
    );
  }
}

const settle = async (fixture: ComponentFixture<unknown>) => {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
  }
  fixture.detectChanges();
};

type Tick = {
  suspended: boolean;
  failed: boolean;
  errored: number;
  pendingMembers: number;
  registered: number;
};

function reading(scope: TransitionScope): Tick {
  return {
    suspended: scope.suspended('value'),
    failed: scope.failed(),
    errored: scope.errored().length,
    pendingMembers: scope.census
      .snapshot()
      .filter((m) => m.readiness && m.pending()).length,
    registered: scope.census.snapshot().length,
  };
}

function setup<T>(host: new () => T, res: FakeRes) {
  const scopes = new Map<string, TransitionScope>();
  TestBed.configureTestingModule({
    providers: [
      { provide: SCOPES, useValue: scopes },
      { provide: RES, useValue: res },
    ],
  });
  const fixture = TestBed.createComponent(host);
  const text = (sel: string): string | null =>
    (fixture.nativeElement as HTMLElement).querySelector(sel)?.textContent ??
    null;
  return { fixture, scopes, text };
}

@Component({
  selector: 'above-host',
  imports: [SuspenseBoundary, MmOutcome, Probe],
  template: `
    <mm-suspense>
      <probe name="b" />
      <span placeholder class="ph">PH</span>
      <p class="v" *mmOutcome="res; let v">{{ v }}</p>
    </mm-suspense>
  `,
})
class AboveHost {
  // Created ABOVE the boundary: no registration can reach it.
  readonly res = inject(RES);
}

describe('*mmOutcome', () => {
  it('a resource created above and read below suspends the boundary and releases it', async () => {
    const res = makeRes('loading');
    const { fixture, scopes, text } = setup(AboveHost, res);
    const trace: Tick[] = [];
    await settle(fixture);
    const scope = scopes.get('b');
    if (!scope) throw new Error('probe did not run');
    expect(scope.resources().length).toBe(0); // not enrolled anywhere
    trace.push(reading(scope));
    expect(text('.ph')).toBe('PH');
    expect(text('.v')).toBeNull();

    res.resolve('ada');
    await settle(fixture);
    trace.push(reading(scope));
    expect(text('.ph')).toBeNull();
    expect(text('.v')?.trim()).toBe('ada');

    // a reload with content held is a value: no re-suspend
    res.load();
    await settle(fixture);
    trace.push(reading(scope));
    expect(text('.v')?.trim()).toBe('ada');

    res.resolve('grace');
    await settle(fixture);
    trace.push(reading(scope));
    expect(text('.v')?.trim()).toBe('grace');

    const row = (suspended: boolean, pendingMembers: number): Tick => ({
      suspended,
      failed: false,
      errored: 0,
      pendingMembers,
      registered: 1,
    });
    expect(trace).toEqual([
      row(true, 1),
      row(false, 0),
      row(false, 0),
      row(false, 0),
    ]);
  });
});

@Component({
  selector: 'enrolled-and-read-host',
  imports: [SuspenseBoundary, MmOutcome, Probe, Enrol],
  template: `
    <mm-suspense>
      <probe name="b" />
      <enrol [suspends]="enrolSuspends" />
      <span placeholder class="ph">PH</span>
      <span error class="err">ERR</span>
      <p class="v" *mmOutcome="res; let v">{{ v }}</p>
    </mm-suspense>
  `,
})
class EnrolledAndReadHost {
  readonly res = inject(RES);
  enrolSuspends = true;
}

@Component({
  selector: 'two-boundaries-host',
  imports: [SuspenseBoundary, MmOutcome, Probe],
  template: `
    <mm-suspense>
      <probe name="left" />
      <span placeholder class="ph-left">PH</span>
      <p class="v-left" *mmOutcome="res; let v">{{ v }}</p>
    </mm-suspense>
    <mm-suspense>
      <probe name="right" />
      <span placeholder class="ph-right">PH</span>
      <p class="v-right" *mmOutcome="res; let v">{{ v }}</p>
    </mm-suspense>
  `,
})
class TwoBoundariesHost {
  readonly res = inject(RES);
}

@Component({
  selector: 'nested-host',
  imports: [SuspenseBoundary, MmOutcome, Probe, Enrol],
  template: `
    <mm-suspense>
      <probe name="outer" />
      <enrol />
      <span placeholder class="ph-outer">PH</span>
      <span error class="err-outer">ERR</span>
      <p class="v-outer" *mmOutcome="res; let v">{{ v }}</p>
      <mm-suspense>
        <probe name="inner" />
        <span placeholder class="ph-inner">PH</span>
        <span error class="err-inner">ERR</span>
        <p class="v-inner" *mmOutcome="res; let v">{{ v }}</p>
      </mm-suspense>
    </mm-suspense>
  `,
})
class NestedHost {
  readonly res = inject(RES);
}

describe('*mmOutcome: one incident per resource and census', () => {
  it('enrolled and read in one census: one member in the fold, one retry round', async () => {
    const res = makeRes('loading');
    const { fixture, scopes, text } = setup(EnrolledAndReadHost, res);
    await settle(fixture);
    const scope = scopes.get('b');
    if (!scope) throw new Error('probe did not run');
    expect(scope.resources()).toEqual([res]);
    expect(reading(scope)).toEqual({
      suspended: true,
      failed: false,
      errored: 0,
      pendingMembers: 2, // raw registrations: the enrolment and the read
      registered: 2,
    });
    expect(scope.census.foldState()).toEqual({ kind: 'pending' });

    res.fail(new Error('boom'));
    await settle(fixture);
    expect(text('.err')).toBe('ERR');
    expect(scope.errored().length).toBe(1);
    expect(scope.failures().length).toBe(1);
    const fold = scope.census.foldState();
    expect(fold.kind === 'error' && fold.failures.length).toBe(1);

    const round = scope.retryAll();
    expect(round.dispatched).toBe(1);
    expect(res.reloads()).toBe(1);
    // the round is in flight: a second one dispatches nothing
    expect(scope.retryAll().dispatched).toBe(0);
    expect(res.reloads()).toBe(1);

    res.resolve('ada');
    await settle(fixture);
    expect(text('.v')?.trim()).toBe('ada');
    expect(reading(scope)).toEqual({
      suspended: false,
      failed: false,
      errored: 0,
      pendingMembers: 0,
      registered: 2,
    });
  });

  it('an indicator-only enrolment does not stop the read from suspending; still one incident', async () => {
    const res = makeRes('loading');
    const scopes = new Map<string, TransitionScope>();
    TestBed.configureTestingModule({
      providers: [
        { provide: SCOPES, useValue: scopes },
        { provide: RES, useValue: res },
      ],
    });
    const fixture = TestBed.createComponent(EnrolledAndReadHost);
    fixture.componentInstance.enrolSuspends = false;
    await settle(fixture);
    const scope = scopes.get('b');
    if (!scope) throw new Error('probe did not run');
    expect(scope.suspended('value')).toBe(true);
    res.fail(new Error('boom'));
    await settle(fixture);
    expect(scope.errored().length).toBe(1);
    // the representative is the read (readiness), and it has no content: the boundary blanks
    expect(scope.errored()[0].member.readiness).toBe(true);
    expect(scope.failed()).toBe(true);
    expect(scope.retryAll().dispatched).toBe(1);
    expect(res.reloads()).toBe(1);
  });

  it('two readers under two boundaries: two holds, released together', async () => {
    const res = makeRes('loading');
    const { fixture, scopes, text } = setup(TwoBoundariesHost, res);
    await settle(fixture);
    const left = scopes.get('left');
    const right = scopes.get('right');
    if (!left || !right) throw new Error('probes did not run');
    expect(left).not.toBe(right);
    expect([reading(left), reading(right)]).toEqual([
      {
        suspended: true,
        failed: false,
        errored: 0,
        pendingMembers: 1,
        registered: 1,
      },
      {
        suspended: true,
        failed: false,
        errored: 0,
        pendingMembers: 1,
        registered: 1,
      },
    ]);
    expect(text('.ph-left')).toBe('PH');
    expect(text('.ph-right')).toBe('PH');

    res.fail(new Error('boom'));
    await settle(fixture);
    // each boundary has its own incident and its own retry round
    expect(left.errored().length).toBe(1);
    expect(right.errored().length).toBe(1);
    expect(left.retryAll().dispatched).toBe(1);
    expect(res.reloads()).toBe(1);

    res.resolve('ada');
    await settle(fixture);
    expect([left.suspended('value'), right.suspended('value')]).toEqual([
      false,
      false,
    ]);
    expect(text('.v-left')?.trim()).toBe('ada');
    expect(text('.v-right')?.trim()).toBe('ada');
  });

  it('enrolled in the outer boundary, read in the inner one, plus an outer reader: both hold', async () => {
    const res = makeRes('loading');
    const { fixture, scopes, text } = setup(NestedHost, res);
    await settle(fixture);
    const outer = scopes.get('outer');
    const inner = scopes.get('inner');
    if (!outer || !inner) throw new Error('probes did not run');
    expect(outer).not.toBe(inner);
    expect(outer.resources()).toEqual([res]);
    expect(inner.resources()).toEqual([]);
    expect(reading(outer)).toEqual({
      suspended: true,
      failed: false,
      errored: 0,
      pendingMembers: 2, // enrolment + outer read, one incident
      registered: 2,
    });
    expect(reading(inner)).toEqual({
      suspended: true,
      failed: false,
      errored: 0,
      pendingMembers: 1,
      registered: 1,
    });
    expect(text('.ph-outer')).toBe('PH');

    res.fail(new Error('boom'));
    await settle(fixture);
    expect([outer.errored().length, inner.errored().length]).toEqual([1, 1]);
    expect([outer.failed(), inner.failed()]).toEqual([true, true]);
    expect(text('.err-outer')).toBe('ERR');
    expect(outer.retryAll().dispatched).toBe(1);
    expect(res.reloads()).toBe(1);

    res.resolve('ada');
    await settle(fixture);
    expect([outer.suspended('value'), inner.suspended('value')]).toEqual([
      false,
      false,
    ]);
    expect(text('.v-outer')?.trim()).toBe('ada');
    expect(text('.v-inner')?.trim()).toBe('ada');
  });
});

@Component({
  selector: 'toggle-host',
  imports: [SuspenseBoundary, MmOutcome, Probe],
  template: `
    <mm-suspense>
      <probe name="b" />
      <span placeholder class="ph">PH</span>
      @if (show()) {
        <p class="v" *mmOutcome="res; let v">{{ v }}</p>
      }
      <span class="content">content</span>
    </mm-suspense>
  `,
})
class ToggleHost {
  readonly res = inject(RES);
  readonly show = signal(true);
}

const DONE_OUTCOME = new InjectionToken<FakeRes>('done-res');

// No boundary component, so the reads' own templates are always on screen; the scope is the host's.
@Component({
  selector: 'templates-host',
  imports: [MmOutcome, Probe],
  providers: [provideTransitionScope()],
  template: `
    <div>
      <probe name="b" />
      <p
        class="v"
        *mmOutcome="
          res;
          let v;
          loading: loadingTpl;
          error: errorTpl;
          name: 'profile'
        "
      >
        {{ v }}
      </p>
      <p class="d" *mmOutcome="doneRes; let v; loading: loadingTpl">
        done:{{ v }}
      </p>
    </div>
    <ng-template #loadingTpl><span class="loading">L</span></ng-template>
    <ng-template #errorTpl let-err let-retry="retry">
      <button class="retry" (click)="retry()">{{ err.message }}</button>
    </ng-template>
  `,
})
class TemplatesHost {
  readonly res = inject(RES);
  readonly doneRes = inject(DONE_OUTCOME);
}

@Component({
  selector: 'held-host',
  imports: [SuspenseBoundary, MmOutcome, Probe],
  template: `
    <mm-suspense>
      <probe name="b" />
      <span failed class="failed-slot">FAILED</span>
      <span class="content">content</span>
      <p class="v" *mmOutcome="res; let v">{{ v }}</p>
    </mm-suspense>
  `,
})
class HeldHost {
  readonly res = inject(RES);
}

@Component({
  selector: 'latest-host',
  imports: [SuspenseBoundary, MmOutcome, Probe],
  template: `
    <mm-suspense>
      <probe name="b" />
      <span placeholder class="ph">PH</span>
      <p class="v" *mmOutcome="derived; let v">{{ v }}</p>
    </mm-suspense>
  `,
})
class LatestHost {
  private readonly res = inject(RES);
  readonly derived = latest(() => `hello ${use(this.res)}`);
}

describe('*mmOutcome: lifecycle and outcomes', () => {
  it('destroyed while pending: the member is removed and the boundary releases', async () => {
    const res = makeRes('loading');
    const { fixture, scopes, text } = setup(ToggleHost, res);
    await settle(fixture);
    const scope = scopes.get('b');
    if (!scope) throw new Error('probe did not run');
    const trace = [reading(scope)];
    expect(text('.ph')).toBe('PH');

    fixture.componentInstance.show.set(false);
    await settle(fixture);
    trace.push(reading(scope));
    expect(text('.ph')).toBeNull();
    expect(text('.content')).toBe('content');

    // the resource keeps loading and then fails: nothing reaches the census any more
    res.fail(new Error('late'));
    await settle(fixture);
    trace.push(reading(scope));
    expect(scope.retryAll().dispatched).toBe(0);
    expect(res.reloads()).toBe(0);

    const off: Tick = {
      suspended: false,
      failed: false,
      errored: 0,
      pendingMembers: 0,
      registered: 0,
    };
    expect(trace).toEqual([
      {
        suspended: true,
        failed: false,
        errored: 0,
        pendingMembers: 1,
        registered: 1,
      },
      off,
      off,
    ]);
  });

  it('done renders no view and is not pending; templates follow the outcome', async () => {
    const res = makeRes('loading');
    const doneStatus = signal<ResourceStatus>('loading');
    const doneOutcome = computed(() =>
      doneStatus() === 'resolved' ? DONE : undefined,
    );
    const doneRes = makeRes('loading', { outcome: doneOutcome });
    // the done source is loading per status but its outcome says otherwise: the outcome wins
    TestBed.configureTestingModule({
      providers: [{ provide: DONE_OUTCOME, useValue: doneRes }],
    });
    const { fixture, scopes, text } = setup(TemplatesHost, res);
    await settle(fixture);
    const scope = scopes.get('b');
    if (!scope) throw new Error('probe did not run');
    const el = fixture.nativeElement as HTMLElement;
    // `res` is loading: its loading template renders; `doneRes` reads `undefined`, a value
    expect(el.querySelectorAll('.loading').length).toBe(1);
    expect(text('.d')?.trim()).toBe('done:');
    expect(scope.census.snapshot().map((m) => m.pending())).toEqual([
      true,
      false,
    ]);

    doneStatus.set('resolved');
    await settle(fixture);
    expect(text('.d')).toBeNull();
    expect(el.querySelectorAll('.loading').length).toBe(1);
    expect(scope.census.snapshot()[1].pending()).toBe(false);
    expect(scope.census.snapshot()[1].failure()).toBeUndefined();

    res.fail(new Error('nope'));
    await settle(fixture);
    expect(el.querySelectorAll('.loading').length).toBe(0);
    expect(text('.retry')?.trim()).toBe('nope');
    expect(scope.errored().map((e) => e.failure)).toEqual([
      {
        id: scope.errored()[0].member.id,
        displayName: 'profile',
        message: 'nope',
      },
    ]);
    // nothing on screen for this read: it blanks
    expect(scope.failed()).toBe(true);

    (el.querySelector('.retry') as HTMLButtonElement).click();
    expect(res.reloads()).toBe(1);
    await settle(fixture);
    expect(el.querySelectorAll('.loading').length).toBe(1);
    expect(text('.retry')).toBeNull();

    res.resolve('ada');
    await settle(fixture);
    expect(text('.v')?.trim()).toBe('ada');
    expect(el.querySelectorAll('.loading').length).toBe(0);
    expect(scope.census.foldState()).toEqual({ kind: 'idle' });
  });

  it('a failed reload with content held is presented, never blanks', async () => {
    const res = makeRes('loading');
    const { fixture, scopes, text } = setup(HeldHost, res);
    res.resolve('ada');
    await settle(fixture);
    const scope = scopes.get('b');
    if (!scope) throw new Error('probe did not run');
    res.load();
    res.fail(new Error('reload failed'));
    await settle(fixture);
    expect(scope.errored().length).toBe(1);
    expect(scope.failed()).toBe(false);
    expect(text('.failed-slot')).toBe('FAILED');
    expect(text('.content')).toBe('content');
    // the read itself has nothing to render while its outcome is an error
    expect(text('.v')).toBeNull();
  });

  it('a latest() under the directive reports like a resource', async () => {
    const res = makeRes('loading');
    const { fixture, scopes } = setup(LatestHost, res);
    await settle(fixture);
    const scope = scopes.get('b');
    if (!scope) throw new Error('probe did not run');
    expect(scope.suspended('value')).toBe(true);
    res.resolve('ada');
    await settle(fixture);
    expect(scope.suspended('value')).toBe(false);
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('.v')
        ?.textContent?.trim(),
    ).toBe('hello ada');
  });
});

@Component({
  selector: 'no-sentinel-host',
  imports: [MmOutcome],
  template: `
    <p class="v" *mmOutcome="res; let v; loading: ld; error: er">{{ v }}</p>
    <ng-template #ld><span class="ld">loading</span></ng-template>
    <ng-template #er let-e let-retry="retry">
      <span class="er">{{ e?.message }}</span>
      <button class="rt" (click)="retry?.()">retry</button>
    </ng-template>
  `,
})
class NoSentinelHost {
  readonly res = inject(RES);
  readonly dir = viewChild(MmOutcome);
}

/** Every value reachable through plain data (arrays, plain objects), functions not called. */
function reachable(value: unknown, depth = 3): unknown[] {
  if (depth < 0 || typeof value !== 'object' || value === null) return [value];
  const own = Array.isArray(value) ? value : Object.values(value);
  return [value, ...own.flatMap((v) => reachable(v, depth - 1))];
}

describe('*mmOutcome never hands a sentinel to a binding (negative control)', () => {
  afterEach(() => setErrorReporter(undefined));

  it('loading and error outcomes render their templates with plain context while the read itself IS a sentinel', async () => {
    const reports: ErrorMintReport[] = [];
    setErrorReporter((r) => reports.push(r));
    const res = makeRes('loading');
    const { fixture, text } = setup(NoSentinelHost, res);
    await settle(fixture);
    const contextOf = () =>
      (
        fixture.componentInstance.dir() as unknown as {
          view: { context: Record<string, unknown> } | null;
        }
      ).view?.context;

    expect(isLoading(outcomeOf(res)())).toBe(true);
    expect(text('.ld')).toBe('loading');
    expect(text('.v')).toBeNull();
    expect(reachable(contextOf()).some(isSentinel)).toBe(false);

    res.fail(new Error('404'));
    await settle(fixture);
    expect(isError(outcomeOf(res)())).toBe(true);
    expect(text('.er')).toBe('404');
    const ctx = contextOf();
    expect(Object.keys(ctx ?? {}).sort()).toEqual(['$implicit', 'retry']);
    expect(ctx?.['$implicit']).toBeInstanceOf(Error);
    expect(typeof ctx?.['retry']).toBe('function');
    expect(reachable(ctx).some(isSentinel)).toBe(false);

    res.resolve('ada');
    await settle(fixture);
    expect(text('.v')?.trim()).toBe('ada');
    expect(reachable(contextOf()).some(isSentinel)).toBe(false);

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain(
      '[mmstack',
    );
    expect(reports.filter((r) => r.origin === 'leak')).toHaveLength(0);
  });
});
