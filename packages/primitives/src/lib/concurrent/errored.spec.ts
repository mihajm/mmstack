/* eslint-disable @angular-eslint/component-selector */
import {
  Component,
  computed,
  type OnDestroy,
  effect,
  ErrorHandler,
  type ErrorDetails,
  inject,
  Injectable,
  type Injector,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type Type,
  viewChild,
  type WritableSignal,
} from '@angular/core';
import {
  getTransitionScope,
  injectTransitionScope,
  provideTransitionScope,
  registerResource,
  type TransitionScope,
} from '@mmstack/primitives/core';
import { render } from '@testing-library/angular';
import { MmErrored } from './errored';
import { MmTransition } from './transition';

/** Records every report, and keeps the console quiet. */
class RecordingErrorHandler extends ErrorHandler {
  readonly viewErrors: { error: Error; details: ErrorDetails }[] = [];
  readonly handled: unknown[] = [];
  override handleError(error: unknown): void {
    this.handled.push(error);
  }
  override onViewError(error: Error, details: ErrorDetails): void {
    this.viewErrors.push({ error, details });
  }
}

type FakeRef = ResourceRef<unknown> & {
  status: WritableSignal<ResourceStatus>;
  value: WritableSignal<unknown>;
};

function makeRef(status: ResourceStatus): FakeRef {
  const status$ = signal<ResourceStatus>(status);
  const value$ = signal<unknown>(undefined);
  return {
    status: status$,
    value: value$,
    isLoading: computed(() => status$() === 'loading'),
    hasValue: () => value$() !== undefined,
    error: signal(undefined),
    reload: () => true,
    destroy: () => undefined,
  } as unknown as FakeRef;
}

/** Shared, test-controlled state the guarded components read. */
@Injectable()
class Knobs {
  readonly bad = signal(false);
  readonly label = signal('one');
  readonly instances: object[] = [];
  readonly ctorThrows = signal(false);
  readonly effectBad = signal(false);
  readonly siblingThrows = signal(false);
  readonly late = signal(false);
  readonly outerTick = signal(0);
  readonly contentTick = signal(0);
  readonly scopes: TransitionScope[] = [];
  readonly hold = makeRef('loading');
  readonly destroyThrows = signal(false);
  readonly destroyed: object[] = [];
}

const flushWith = async (detect: () => void) => {
  for (let i = 0; i < 5; i++) {
    detect();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
  }
  detect();
};

function scopeOf(injector: Injector): TransitionScope {
  const scope = getTransitionScope(injector);
  if (!scope) throw new Error('no transition scope');
  return scope;
}

function boundaryOf(host: {
  boundary: () => MmErrored | undefined;
}): MmErrored {
  const boundary = host.boundary();
  if (!boundary) throw new Error('no boundary');
  return boundary;
}

const isShown = (el: Element | null): boolean =>
  el !== null && (el as HTMLElement).style.display !== 'none';

/** OnPush (the Angular 22 default): renders `label`, throws while `bad`. */
@Component({
  selector: 'er-child',
  template: `<span class="before">{{ knobs.label() }}</span
    ><span class="mid">{{ guarded() }}</span
    ><input class="field" />`,
})
class Child {
  readonly knobs = inject(Knobs);
  renders = 0;
  protected readonly guarded = computed(() => {
    const label = this.knobs.label();
    if (this.knobs.bad()) throw new Error(`bad:${label}`);
    return `ok:${label}`;
  });
  constructor() {
    this.knobs.instances.push(this);
  }
}

const P1_TEMPLATE = `
  <ng-template [mmErrored]="fb">
    <div class="content"><er-child /></div>
  </ng-template>
  <ng-template #fb let-error let-retry="retry">
    <p class="fb">{{ error.message }}</p>
    <button class="retry" (click)="retry()">retry</button>
  </ng-template>
`;

@Component({
  selector: 'er-p1-host',
  imports: [MmErrored, Child],
  providers: [provideTransitionScope()],
  template: P1_TEMPLATE,
})
class P1Host {
  readonly boundary = viewChild.required(MmErrored);
}

async function setup<T>(host: Type<T>, knobs = new Knobs()) {
  const { fixture, container } = await render(host, {
    providers: [
      { provide: Knobs, useValue: knobs },
      { provide: ErrorHandler, useClass: RecordingErrorHandler },
    ],
  });
  const handler = fixture.debugElement.injector.get(
    ErrorHandler,
  ) as RecordingErrorHandler;
  const settle = () => flushWith(() => fixture.detectChanges());
  await settle();
  return { fixture, container, handler, knobs, settle };
}

describe('*mmErrored: update-pass fault', () => {
  it('A-P1: hides the kept content, shows the fallback, reports once; retry after the fix renders the SAME instance', async () => {
    const { fixture, container, handler, knobs, settle } = await setup(P1Host);
    const scope = scopeOf(fixture.debugElement.injector);
    const content = container.querySelector('.content');
    const field = container.querySelector('.field') as HTMLInputElement;
    expect(container.querySelector('.mid')?.textContent).toBe('ok:one');
    expect(knobs.instances.length).toBe(1);
    const instance = knobs.instances[0];
    field.value = 'typed';

    knobs.label.set('two');
    knobs.bad.set(true);
    await settle();

    expect(handler.viewErrors.map((r) => r.error.message)).toEqual(['bad:two']);
    expect(handler.viewErrors[0].details.declarationType).toBe(Child);
    expect(handler.viewErrors[0].details.boundary?.type).toBe(P1Host);
    expect(handler.handled).toEqual([]);
    // kept: same nodes, hidden; the torn frame (`before` already says two) is not on screen
    expect(container.querySelector('.content')).toBe(content);
    expect(isShown(content)).toBe(false);
    expect(container.querySelector('.before')?.textContent).toBe('two');
    expect(container.querySelector('.fb')?.textContent).toBe('bad:two');
    expect(fixture.componentInstance.boundary().error()?.message).toBe(
      'bad:two',
    );
    // census: presented, not blanking
    expect(scope.errored().map((e) => e.failure.message)).toEqual(['bad:two']);
    expect(scope.failed()).toBe(false);

    knobs.bad.set(false);
    await settle();
    // the fix alone does not reveal or re-render: the view is detached until retry
    expect(isShown(content)).toBe(false);
    expect(container.querySelector('.mid')?.textContent).toBe('ok:one');
    expect(container.querySelector('.fb')).not.toBeNull();

    (container.querySelector('.retry') as HTMLButtonElement).click();
    await settle();

    expect(container.querySelector('.fb')).toBeNull();
    expect(container.querySelector('.content')).toBe(content);
    expect(isShown(content)).toBe(true);
    expect(container.querySelector('.mid')?.textContent).toBe('ok:two');
    expect(knobs.instances).toEqual([instance]);
    expect((container.querySelector('.field') as HTMLInputElement).value).toBe(
      'typed',
    );
    expect(handler.viewErrors.length).toBe(1);
    expect(scope.errored()).toEqual([]);
    expect(scope.failed()).toBe(false);
    expect(fixture.componentInstance.boundary().error()).toBeUndefined();
  });
});

describe('*mmErrored: retry before the fix', () => {
  it('a computed that cached the throw throws again on retry until a dependency moves, then the retry renders', async () => {
    const { fixture, container, handler, knobs, settle } = await setup(P1Host);
    const scope = scopeOf(fixture.debugElement.injector);
    const content = container.querySelector('.content');
    const instance = knobs.instances[0];
    knobs.bad.set(true);
    await settle();
    expect(handler.viewErrors.length).toBe(1);

    fixture.componentInstance.boundary().retry();
    // synchronous: the retry render threw again, nothing torn was revealed
    expect(handler.viewErrors.map((r) => r.error.message)).toEqual([
      'bad:one',
      'bad:one',
    ]);
    expect(isShown(content)).toBe(false);
    await settle();
    expect(isShown(content)).toBe(false);
    expect(container.querySelector('.fb')?.textContent).toBe('bad:one');
    expect(scope.errored().length).toBe(1);

    knobs.bad.set(false);
    fixture.componentInstance.boundary().retry();
    expect(isShown(content)).toBe(true);
    expect(container.querySelector('.mid')?.textContent).toBe('ok:one');
    await settle();
    expect(container.querySelector('.fb')).toBeNull();
    expect(knobs.instances).toEqual([instance]);
    expect(handler.viewErrors.length).toBe(2);
    expect(scope.errored()).toEqual([]);
  });
});

const P2_TEMPLATE = `
  <ng-template [mmErrored]="fb">
    <div class="content"><span class="own">{{ own() }}</span><er-child /></div>
  </ng-template>
  <ng-template #fb let-error let-retry="retry">
    <p class="fb">{{ error.message }}</p>
  </ng-template>
`;

/** The content template's own first-pass binding can throw too (`ownBad`). */
@Component({
  selector: 'er-p2-host',
  imports: [MmErrored, Child],
  providers: [provideTransitionScope()],
  template: P2_TEMPLATE,
})
class P2Host {
  readonly boundary = viewChild.required(MmErrored);
  readonly ownBad = signal(false);
  protected readonly own = computed(() => {
    if (this.ownBad()) throw new Error('own-bad');
    return 'own-ok';
  });
}

describe('*mmErrored: first update pass', () => {
  it('A-P2: a nested component throwing in its first update pass is kept, hidden, and resumes with the same instance', async () => {
    const knobs = new Knobs();
    knobs.bad.set(true);
    const { fixture, container, handler, settle } = await setup(P2Host, knobs);
    const scope = scopeOf(fixture.debugElement.injector);

    expect(handler.viewErrors.map((r) => r.error.message)).toEqual(['bad:one']);
    expect(knobs.instances.length).toBe(1);
    const content = container.querySelector('.content');
    expect(content).not.toBeNull(); // created and inserted: only its update pass threw
    expect(isShown(content)).toBe(false);
    expect(container.querySelector('.fb')?.textContent).toBe('bad:one');
    expect(scope.errored().map((e) => e.failure.displayName)).toEqual(['view']);
    expect(scope.failed()).toBe(false);

    knobs.bad.set(false);
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(isShown(content)).toBe(true);
    expect(container.querySelector('.mid')?.textContent).toBe('ok:one');
    expect(container.querySelector('.own')?.textContent).toBe('own-ok');
    expect(container.querySelector('.fb')).toBeNull();
    expect(knobs.instances.length).toBe(1);
    expect(handler.viewErrors.length).toBe(1);
    expect(scope.errored()).toEqual([]);
  });

  it('A-P2: a binding of the content template itself throwing in the first pass; retry re-reads it', async () => {
    @Component({
      selector: 'er-p2-own-host',
      imports: [MmErrored, Child],
      providers: [provideTransitionScope()],
      template: P2_TEMPLATE,
    })
    class OwnHost extends P2Host {
      constructor() {
        super();
        this.ownBad.set(true);
      }
    }
    const { fixture, container, handler, knobs, settle } = await setup(OwnHost);
    const host = fixture.componentInstance;
    const content = container.querySelector('.content');
    expect(handler.viewErrors.map((r) => r.error.message)).toEqual(['own-bad']);
    expect(handler.viewErrors[0].details.declarationType).toBe(OwnHost);
    expect(isShown(content)).toBe(false);

    host.boundary().retry(); // not fixed yet: the cached throw is read again
    expect(handler.viewErrors.length).toBe(2);
    expect(isShown(content)).toBe(false);

    host.ownBad.set(false);
    host.boundary().retry();
    await settle();
    expect(isShown(content)).toBe(true);
    expect(container.querySelector('.own')?.textContent).toBe('own-ok');
    expect(container.querySelector('.fb')).toBeNull();
    expect(knobs.instances.length).toBe(1);
    expect(handler.viewErrors.length).toBe(2);
  });
});

/** Throws from its constructor while `ctorThrows`; only successful constructions are recorded. */
@Component({ selector: 'er-ctor', template: `<span class="ctor">built</span>` })
class CtorThrower {
  readonly knobs = inject(Knobs);
  constructor() {
    if (this.knobs.ctorThrows()) throw new Error('ctor-failed');
    this.knobs.instances.push(this);
  }
}

const P3_TEMPLATE = `
  <ng-template [mmErrored]="fb" mmErroredName="ctor-region">
    <div class="content"><er-ctor /></div>
  </ng-template>
  <ng-template #fb let-error let-retry="retry">
    <p class="fb">{{ error.message }}</p>
    <button class="retry" (click)="retry()">retry</button>
  </ng-template>
`;

@Component({
  selector: 'er-p3-host',
  imports: [MmErrored, CtorThrower],
  providers: [provideTransitionScope()],
  template: P3_TEMPLATE,
})
class P3Host {
  readonly boundary = viewChild.required(MmErrored);
}

describe('*mmErrored: creation throw', () => {
  it('A-P3: a constructor throw leaves no view; the fallback shows; retry builds the content anew (a new instance)', async () => {
    const knobs = new Knobs();
    knobs.ctorThrows.set(true);
    const { fixture, container, handler, settle } = await setup(P3Host, knobs);
    const scope = scopeOf(fixture.debugElement.injector);

    expect(handler.viewErrors.map((r) => r.error.message)).toEqual([
      'ctor-failed',
    ]);
    expect(handler.viewErrors[0].details.declarationType).toBe(P3Host);
    expect(handler.viewErrors[0].details.boundary?.type).toBe(P3Host);
    expect(handler.handled).toEqual([]);
    expect(container.querySelector('.content')).toBeNull(); // never inserted
    expect(container.querySelector('.fb')?.textContent).toBe('ctor-failed');
    expect(knobs.instances).toEqual([]);
    expect(scope.errored().map((e) => e.failure.displayName)).toEqual([
      'ctor-region',
    ]);
    expect(scope.failed()).toBe(false);

    // still broken: retry tries to build again and lands on the fallback
    (container.querySelector('.retry') as HTMLButtonElement).click();
    await settle();
    expect(handler.viewErrors.length).toBe(2);
    expect(container.querySelector('.content')).toBeNull();
    expect(container.querySelector('.fb')).not.toBeNull();
    expect(scope.errored().length).toBe(1);

    knobs.ctorThrows.set(false);
    (container.querySelector('.retry') as HTMLButtonElement).click();
    await settle();
    expect(knobs.instances.length).toBe(1);
    expect(knobs.instances[0]).toBeInstanceOf(CtorThrower);
    const content = container.querySelector('.content');
    expect(isShown(content)).toBe(true);
    expect(container.querySelector('.ctor')?.textContent).toBe('built');
    expect(container.querySelector('.fb')).toBeNull();
    expect(handler.viewErrors.length).toBe(2);
    expect(scope.errored()).toEqual([]);
    // content renders ahead of where the fallback was, and only one view remains
    expect(container.querySelectorAll('.content').length).toBe(1);
  });

  it('retry on a boundary with no fault does nothing', async () => {
    const knobs = new Knobs();
    const { fixture, container, handler, settle } = await setup(P3Host, knobs);
    expect(knobs.instances.length).toBe(1);
    expect(handler.viewErrors).toEqual([]);
    const first = knobs.instances[0];
    expect(isShown(container.querySelector('.content'))).toBe(true);
    // the boundary is quiet: nothing to retry
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(knobs.instances).toEqual([first]);
    expect(container.querySelectorAll('.content').length).toBe(1);
  });
});

// angular-eslint cannot parse `@boundary` yet; a template held in a const is not extracted for template lint.
const P4_BOUNDARY_TEMPLATE = `
  <ng-template [mmErrored]="fb">
    <div class="content">
      @boundary {
        <er-child />
      } @error {
        <span class="inner">inner</span>
      }
    </div>
  </ng-template>
  <ng-template #fb><p class="fb">outer</p></ng-template>
`;

@Component({
  selector: 'er-p4-boundary-host',
  imports: [MmErrored, Child],
  providers: [provideTransitionScope()],
  template: P4_BOUNDARY_TEMPLATE,
})
class P4BoundaryHost {
  readonly boundary = viewChild.required(MmErrored);
}

const P4_NESTED_TEMPLATE = `
  <ng-template [mmErrored]="outerFb" #outer="mmErrored">
    <div class="content">
      <ng-template [mmErrored]="innerFb" #inner="mmErrored">
        <er-child />
      </ng-template>
    </div>
  </ng-template>
  <ng-template #outerFb><p class="fb">outer</p></ng-template>
  <ng-template #innerFb let-error><p class="inner">{{ error.message }}</p></ng-template>
`;

@Component({
  selector: 'er-p4-nested-host',
  imports: [MmErrored, Child],
  providers: [provideTransitionScope()],
  template: P4_NESTED_TEMPLATE,
})
class P4NestedHost {
  readonly outer = viewChild.required<MmErrored>('outer');
}

const P4_THROWING_FALLBACK_TEMPLATE = `
  @boundary {
    <ng-template [mmErrored]="fb">
      <div class="content"><er-child /></div>
    </ng-template>
    <ng-template #fb><p class="fb">{{ boom() }}</p></ng-template>
  } @error {
    <span class="outer-error">outer</span>
  }
`;

@Component({
  selector: 'er-p4-throwing-fallback-host',
  imports: [MmErrored, Child],
  providers: [provideTransitionScope()],
  template: P4_THROWING_FALLBACK_TEMPLATE,
})
class P4ThrowingFallbackHost {
  protected boom(): string {
    throw new Error('fallback-failed');
  }
}

describe('*mmErrored: nearest wins', () => {
  it('A-P4: an inner @boundary catches first; *mmErrored sees nothing', async () => {
    const { fixture, container, handler, knobs, settle } =
      await setup(P4BoundaryHost);
    const scope = scopeOf(fixture.debugElement.injector);
    knobs.bad.set(true);
    await settle();

    expect(handler.viewErrors.length).toBe(1); // Angular's own report, not ours
    expect(handler.viewErrors[0].details.caughtBy).toBeDefined();
    expect(container.querySelector('.inner')).not.toBeNull();
    expect(container.querySelector('er-child')).toBeNull();
    expect(container.querySelector('.fb')).toBeNull();
    expect(isShown(container.querySelector('.content'))).toBe(true);
    expect(fixture.componentInstance.boundary().error()).toBeUndefined();
    expect(scope.errored()).toEqual([]);
  });

  it('A-P4: an inner *mmErrored catches first; the outer keeps rendering its content', async () => {
    const { fixture, container, handler, knobs, settle } =
      await setup(P4NestedHost);
    const scope = scopeOf(fixture.debugElement.injector);
    knobs.bad.set(true);
    await settle();

    expect(handler.viewErrors.map((r) => r.error.message)).toEqual(['bad:one']);
    expect(container.querySelector('.inner')?.textContent).toBe('bad:one');
    expect(container.querySelector('.fb')).toBeNull();
    expect(isShown(container.querySelector('.content'))).toBe(true);
    expect(fixture.componentInstance.outer().error()).toBeUndefined();
    expect(scope.errored().length).toBe(1); // the inner boundary's member only
  });

  it('a fallback that throws is caught by the next boundary out', async () => {
    const { fixture, container, handler, knobs, settle } = await setup(
      P4ThrowingFallbackHost,
    );
    const scope = scopeOf(fixture.debugElement.injector);
    knobs.bad.set(true);
    await settle();

    expect(handler.viewErrors.map((r) => r.error.message)).toEqual([
      'bad:one', // ours
      'fallback-failed', // the outer @boundary's
    ]);
    expect(handler.viewErrors[1].details.boundary?.type).toBe(
      P4ThrowingFallbackHost,
    );
    expect(container.querySelector('.outer-error')).not.toBeNull();
    expect(container.querySelector('.content')).toBeNull();
    expect(container.querySelector('.fb')).toBeNull();
    // the destroyed boundary took its census member with it
    expect(scope.errored()).toEqual([]);
  });
});

/** A view effect living in the content view (its host element is in the content template). */
@Component({
  selector: 'er-effect',
  template: `<span class="eff">{{ shown() }}</span>`,
})
class EffectThrower {
  readonly knobs = inject(Knobs);
  readonly shown = signal('eff');
  constructor() {
    effect(() => {
      if (this.knobs.effectBad()) throw new Error('effect-failed');
    });
  }
}

/** OnPush between the outer @boundary and *mmErrored: it is only traversed when it is not dirty. */
@Component({
  selector: 'er-mid',
  imports: [MmErrored, EffectThrower],
  template: `
    <ng-template [mmErrored]="fb">
      <div class="content">{{ knobs.contentTick() }}<er-effect /></div>
    </ng-template>
    <ng-template #fb><p class="fb">mm-fallback</p></ng-template>
  `,
})
class Mid {
  readonly knobs = inject(Knobs);
}

const P5_TEMPLATE = `
  @boundary {
    <span class="tick">{{ knobs.outerTick() }}</span>
    <er-mid />
  } @error {
    <span class="outer-error">outer</span>
  }
`;

@Component({
  selector: 'er-p5-host',
  imports: [Mid],
  providers: [provideTransitionScope()],
  template: P5_TEMPLATE,
})
class P5Host {
  readonly knobs = inject(Knobs);
}

describe('*mmErrored: a view effect in a traversal-only pass', () => {
  it('A-P5: the effect throw skips this boundary and lands on the nearest refreshing ancestor with an interceptor', async () => {
    const { fixture, container, handler, knobs, settle } = await setup(P5Host);
    const scope = scopeOf(fixture.debugElement.injector);
    expect(container.querySelector('.eff')).not.toBeNull();

    // the outer block refreshes (outerTick), the OnPush <er-mid> and the content view are only
    // traversed to reach the dirty effect
    knobs.effectBad.set(true);
    knobs.outerTick.update((n) => n + 1);
    await settle();

    expect(handler.viewErrors.map((r) => r.error.message)).toEqual([
      'effect-failed',
    ]);
    expect(handler.viewErrors[0].details.caughtBy).toBeDefined();
    expect(container.querySelector('.outer-error')).not.toBeNull();
    expect(container.querySelector('.fb')).toBeNull(); // *mmErrored never saw it
    expect(container.querySelector('.content')).toBeNull(); // the outer block removed it all
    expect(scope.errored()).toEqual([]);
  });

  it('A-P5 contrast: when the content view itself refreshes in the same pass, this boundary catches the effect throw', async () => {
    const { container, handler, knobs, settle } = await setup(P5Host);
    knobs.effectBad.set(true);
    knobs.contentTick.update((n) => n + 1); // dirties the content view's own bindings
    await settle();

    expect(handler.viewErrors.map((r) => r.error.message)).toEqual([
      'effect-failed',
    ]);
    expect(container.querySelector('.fb')?.textContent).toBe('mm-fallback');
    expect(isShown(container.querySelector('.content'))).toBe(false);
    expect(container.querySelector('.outer-error')).toBeNull();
  });
});

/** Exposes the scope it sees (the incoming branch's own) to the test. */
@Component({ selector: 'er-scope-probe', template: `` })
class ScopeProbe {
  constructor() {
    inject(Knobs).scopes.push(injectTransitionScope());
  }
}

/** Keeps the incoming branch held: a non-suspending registration still in flight. */
@Component({ selector: 'er-hold', template: `held` })
class Hold {
  constructor() {
    registerResource(inject(Knobs).hold, { suspends: false });
  }
}

@Component({ selector: 'er-a', template: `branch-a` })
class BranchA {}

const P6_TEMPLATE = `
  <div class="wrap" *mmTransition="tab(); let t">
    @switch (t) {
      @case ('a') {
        <er-a />
      }
      @case ('x') {
        <er-scope-probe />
        <er-hold />
        <ng-template [mmErrored]="fb">
          <div class="content"><er-child /></div>
        </ng-template>
        <ng-template #fb let-error let-retry="retry">
          <span class="x-fb">{{ error.message }}</span>
          <button class="retry" (click)="retry()">retry</button>
        </ng-template>
      }
    }
  </div>
`;

@Component({
  selector: 'er-p6-host',
  imports: [MmTransition, MmErrored, BranchA, Child, Hold, ScopeProbe],
  template: P6_TEMPLATE,
})
class P6Host {
  readonly tab = signal('a');
}

function visibleWraps(container: HTMLElement): string {
  return Array.from(container.querySelectorAll<HTMLElement>('.wrap'))
    .filter((el) => el.style.display !== 'none')
    .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .join('|');
}

describe('*mmErrored inside a *mmTransition branch', () => {
  it('A-P6: a faulting hidden incoming branch shows its fallback inside the branch, the scope settles, the swap commits', async () => {
    const knobs = new Knobs();
    knobs.bad.set(true);
    const { fixture, container, handler, settle } = await setup(P6Host, knobs);
    const outgoing = container.querySelector('er-a');
    expect(visibleWraps(container)).toBe('branch-a');

    fixture.componentInstance.tab.set('x');
    await settle();

    // caught inside the hidden branch while it is held
    const scope = knobs.scopes[0];
    expect(knobs.scopes.length).toBe(1);
    expect(handler.viewErrors.map((r) => r.error.message)).toEqual(['bad:one']);
    expect(container.querySelector('.x-fb')?.textContent).toBe('bad:one');
    expect(isShown(container.querySelector('.content'))).toBe(false);
    expect(container.querySelector('er-a')).toBe(outgoing);
    expect(visibleWraps(container)).toBe('branch-a');
    expect(scope.pending()).toBe(true); // the hold, not the fault
    expect(scope.failed()).toBe(false);
    expect(scope.errored().map((e) => e.failure.message)).toEqual(['bad:one']);

    knobs.hold.value.set({ ok: true });
    knobs.hold.status.set('resolved');
    await settle();

    // committed: the incoming branch, with its fallback, is the one visible view
    expect(scope.pending()).toBe(false);
    expect(container.querySelectorAll('.wrap').length).toBe(1);
    expect(container.querySelector('er-a')).toBeNull();
    expect(visibleWraps(container)).toContain('held');
    expect(visibleWraps(container)).toContain('bad:one');
    expect(await scope.settled()).toBe('error');

    knobs.bad.set(false);
    (container.querySelector('.retry') as HTMLButtonElement).click();
    await settle();
    expect(container.querySelector('.x-fb')).toBeNull();
    expect(isShown(container.querySelector('.content'))).toBe(true);
    expect(container.querySelector('.mid')?.textContent).toBe('ok:one');
    expect(knobs.instances.length).toBe(1);
    expect(scope.errored()).toEqual([]);
    expect(handler.viewErrors.length).toBe(1);
  });

  it('A-P6: with nothing loading, the faulting branch still commits on its first render', async () => {
    @Component({
      selector: 'er-p6-plain-host',
      imports: [MmTransition, MmErrored, BranchA, Child],
      template: `
        <div class="wrap" *mmTransition="tab(); let t">
          @if (t === 'a') {
            <er-a />
          } @else {
            <ng-template [mmErrored]="fb"><er-child /></ng-template>
            <ng-template #fb><span class="x-fb">x-fallback</span></ng-template>
          }
        </div>
      `,
    })
    class PlainHost {
      readonly tab = signal('a');
    }
    const knobs = new Knobs();
    knobs.bad.set(true);
    const { fixture, container, handler, settle } = await setup(
      PlainHost,
      knobs,
    );
    fixture.componentInstance.tab.set('x');
    await settle();
    expect(handler.viewErrors.length).toBe(1);
    expect(container.querySelectorAll('.wrap').length).toBe(1);
    expect(container.querySelector('er-a')).toBeNull();
    // the wrap is visible; inside it the kept content root is hidden beside the fallback
    expect(visibleWraps(container)).toContain('x-fallback');
    expect(container.querySelector('er-child')).not.toBeNull();
    expect(isShown(container.querySelector('er-child'))).toBe(false);
  });
});

const P7_TEMPLATE = `
  @if (show()) {
    <ng-template [mmErrored]="fb" mmErroredName="profile">
      <div class="content"><er-child /><er-child /></div>
    </ng-template>
  }
  <ng-template #fb let-error let-retry="retry">
    <p class="fb">{{ error.message }}</p>
  </ng-template>
`;

/** Two children read the same knobs, so one change faults both in the same pass. */
@Component({
  selector: 'er-p7-host',
  imports: [MmErrored, Child],
  providers: [provideTransitionScope()],
  template: P7_TEMPLATE,
})
class P7Host {
  readonly boundary = viewChild(MmErrored);
  readonly show = signal(true);
  readonly scope = injectTransitionScope();
  readonly trace: string[] = [];
  constructor() {
    effect(() => {
      const errored = this.scope.errored();
      this.trace.push(
        `${errored.map((e) => `${e.failure.displayName}:${e.failure.message}`).join(',') || '-'}/failed=${this.scope.failed()}`,
      );
    });
  }
}

describe('*mmErrored: reporting and the census', () => {
  it('A-P7: exactly one ErrorHandler report per catch across a fault, a failed retry, a good retry and a second fault', async () => {
    const { fixture, container, handler, knobs, settle } = await setup(P7Host);
    const host = fixture.componentInstance;
    const messages = () => handler.viewErrors.map((r) => r.error.message);

    knobs.bad.set(true);
    await settle();
    // two catches in one pass (both children threw): two reports, the first error is shown
    expect(handler.viewErrors[0].details.boundary?.type).toBe(P7Host); // declared inside an @if
    expect(messages()).toEqual(['bad:one', 'bad:one']);
    expect(container.querySelector('.fb')?.textContent).toBe('bad:one');

    boundaryOf(host).retry(); // still broken: both throw again
    expect(messages().length).toBe(4);
    await settle();
    expect(messages().length).toBe(4); // settling adds nothing

    knobs.bad.set(false);
    boundaryOf(host).retry();
    await settle();
    expect(messages().length).toBe(4);
    expect(isShown(container.querySelector('.content'))).toBe(true);

    knobs.label.set('two');
    knobs.bad.set(true);
    await settle();
    expect(messages()).toEqual([
      'bad:one',
      'bad:one',
      'bad:one',
      'bad:one',
      'bad:two',
      'bad:two',
    ]);
    expect(handler.handled).toEqual([]);
    expect(knobs.instances.length).toBe(2);

    // per-tick census readings: presented while faulted, never blanking, gone after a clean retry
    expect(host.trace).toEqual([
      '-/failed=false',
      'profile:bad:one/failed=false',
      '-/failed=false',
      'profile:bad:two/failed=false',
    ]);
  });

  it('without onViewError the report goes to handleError, once per catch', async () => {
    class PlainHandler extends ErrorHandler {
      readonly handled: unknown[] = [];
      override handleError(error: unknown): void {
        this.handled.push(error);
      }
    }
    const knobs = new Knobs();
    const { fixture, container } = await render(P1Host, {
      providers: [
        { provide: Knobs, useValue: knobs },
        { provide: ErrorHandler, useClass: PlainHandler },
      ],
    });
    const handler = fixture.debugElement.injector.get(
      ErrorHandler,
    ) as PlainHandler;
    const settle = () => flushWith(() => fixture.detectChanges());
    await settle();
    knobs.bad.set(true);
    await settle();
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(handler.handled.map((e) => (e as Error).message)).toEqual([
      'bad:one',
      'bad:one',
    ]);
    expect(container.querySelector('.fb')).not.toBeNull();
  });

  it('scope.retryAll() runs the boundary retry as one round', async () => {
    const { fixture, container, knobs, settle } = await setup(P7Host);
    const scope = fixture.componentInstance.scope;
    knobs.bad.set(true);
    await settle();
    expect(scope.errored()[0].member.retry).toBeDefined();
    expect(scope.errored()[0].member.readiness).toBe(false);

    knobs.bad.set(false);
    const round = scope.retryAll();
    expect(round.dispatched).toBe(1);
    expect(scope.errored()).toEqual([]); // the retry rendered synchronously
    await settle();
    await round.settled();
    expect(isShown(container.querySelector('.content'))).toBe(true);
    expect(knobs.instances.length).toBe(2);
  });

  it('destroying a faulted boundary takes its member out of the census', async () => {
    const { fixture, knobs, settle } = await setup(P7Host);
    const host = fixture.componentInstance;
    knobs.bad.set(true);
    await settle();
    expect(host.scope.errored().length).toBe(1);
    host.show.set(false);
    await settle();
    expect(host.boundary()).toBeUndefined();
    expect(host.scope.errored()).toEqual([]);
    expect(host.trace.at(-1)).toBe('-/failed=false');
  });
});

/** Registers a held resource into the nearest scope from its constructor. */
@Component({ selector: 'er-reg', template: `reg` })
class Registers {
  constructor() {
    registerResource(inject(Knobs).hold, { suspends: false });
  }
}

const NAMED_LIMITS_TEMPLATE = `
  <ng-template [mmErrored]="fb">
    <div class="content">
      <er-reg />
      @if (knobs.late()) {
        <er-ctor />
      }
      <er-ctor-sibling />
    </div>
  </ng-template>
  <ng-template #fb let-error><p class="fb">{{ error.message }}</p></ng-template>
`;

/** A second constructor-thrower, gated by `siblingThrows`, placed after a registering sibling. */
@Component({ selector: 'er-ctor-sibling', template: `sibling` })
class CtorSibling {
  constructor() {
    if (inject(Knobs).siblingThrows()) throw new Error('sibling-ctor-failed');
  }
}

@Component({
  selector: 'er-limits-host',
  imports: [MmErrored, Registers, CtorThrower, CtorSibling],
  providers: [provideTransitionScope()],
  template: NAMED_LIMITS_TEMPLATE,
})
class LimitsHost {
  readonly knobs = inject(Knobs);
  readonly boundary = viewChild.required(MmErrored);
}

describe('*mmErrored: named limits', () => {
  it('a creation throw cannot clean up what earlier siblings registered outside the half-built view', async () => {
    const knobs = new Knobs();
    knobs.siblingThrows.set(true);
    const { fixture, container, handler, settle } = await setup(
      LimitsHost,
      knobs,
    );
    const scope = scopeOf(fixture.debugElement.injector);
    expect(handler.viewErrors.map((r) => r.error.message)).toEqual([
      'sibling-ctor-failed',
    ]);
    expect(container.querySelector('.content')).toBeNull();
    // the half-built view is unreachable, so its registration stays (as with @boundary)
    expect(scope.resources()).toEqual([knobs.hold]);

    knobs.siblingThrows.set(false);
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(container.querySelector('.content')).not.toBeNull();
    expect(scope.resources()).toEqual([knobs.hold, knobs.hold]);
  });

  it('a block whose branch throws while being built in an update pass stays empty after retry until its condition changes', async () => {
    const { fixture, container, handler, knobs, settle } =
      await setup(LimitsHost);
    const content = container.querySelector('.content');
    knobs.ctorThrows.set(true);
    knobs.late.set(true);
    await settle();
    expect(handler.viewErrors.map((r) => r.error.message)).toEqual([
      'ctor-failed',
    ]);
    expect(container.querySelector('.content')).toBe(content);
    expect(isShown(content)).toBe(false);

    knobs.ctorThrows.set(false);
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(container.querySelector('.content')).toBe(content);
    expect(isShown(content)).toBe(true);
    expect(container.querySelector('.fb')).toBeNull();
    // the @if already recorded `true` before its branch threw, so the retry does not build it
    expect(container.querySelector('er-ctor')).toBeNull();
    expect(handler.viewErrors.length).toBe(1);

    knobs.late.set(false);
    await settle();
    knobs.late.set(true);
    await settle();
    expect(container.querySelector('er-ctor .ctor')?.textContent).toBe('built');
  });
});

describe('*mmErrored: microsyntax', () => {
  it('`*mmErrored="fb; name: ..."` binds the fallback and the census name', async () => {
    @Component({
      selector: 'er-star-host',
      imports: [MmErrored, Child],
      providers: [provideTransitionScope()],
      template: `
        <div class="content" *mmErrored="fb; name: 'card'"><er-child /></div>
        <ng-template #fb let-error let-retry="retry">
          <p class="fb">{{ error.message }}</p>
          <button class="retry" (click)="retry()">retry</button>
        </ng-template>
      `,
    })
    class StarHost {}
    const { fixture, container, knobs, settle } = await setup(StarHost);
    const scope = scopeOf(fixture.debugElement.injector);
    knobs.bad.set(true);
    await settle();
    expect(container.querySelector('.fb')?.textContent).toBe('bad:one');
    expect(scope.errored().map((e) => e.failure.displayName)).toEqual(['card']);
    knobs.bad.set(false);
    (container.querySelector('.retry') as HTMLButtonElement).click();
    await settle();
    expect(isShown(container.querySelector('.content'))).toBe(true);
    expect(container.querySelector('.fb')).toBeNull();
  });

  it('outside any transition scope it still catches, with no census to join', async () => {
    @Component({
      selector: 'er-unscoped-host',
      imports: [MmErrored, Child],
      template: `
        <div class="content" *mmErrored="fb"><er-child /></div>
        <ng-template #fb><p class="fb">fb</p></ng-template>
      `,
    })
    class UnscopedHost {}
    const { container, handler, knobs, settle } = await setup(UnscopedHost);
    knobs.bad.set(true);
    await settle();
    expect(handler.viewErrors.length).toBe(1);
    expect(isShown(container.querySelector('.content'))).toBe(false);
    expect(container.querySelector('.fb')).not.toBeNull();
  });
});

/**
 * Holds state of its own: once `poison()` runs, rendering throws until the instance is gone. Also
 * throws while `knobs.bad`, so a fresh instance can be made to fault too.
 */
@Component({
  selector: 'er-poisoned',
  template: `<span class="state">{{ shown() }}</span
    ><input class="field" />`,
})
class Poisoned implements OnDestroy {
  readonly knobs = inject(Knobs);
  private readonly state = signal('fresh');
  protected readonly shown = computed(() => {
    const state = this.state();
    if (state === 'poisoned') throw new Error('poisoned');
    if (this.knobs.bad()) throw new Error('bad');
    return state;
  });
  constructor() {
    if (this.knobs.ctorThrows()) throw new Error('ctor-failed');
    this.knobs.instances.push(this);
  }
  poison(): void {
    this.state.set('poisoned');
  }
  ngOnDestroy(): void {
    this.knobs.destroyed.push(this);
    if (this.knobs.destroyThrows()) throw new Error('destroy-failed');
  }
}

const REBUILD_TEMPLATE = `
  <ng-template [mmErrored]="fb" mmErroredName="poisoned-region">
    <div class="content"><er-poisoned /></div>
  </ng-template>
  <ng-template #fb let-error let-retry="retry">
    <p class="fb">{{ error.message }}</p>
    <button class="retry" (click)="retry()">retry</button>
    <button class="rebuild" (click)="retry({ rebuild: true })">rebuild</button>
  </ng-template>
`;

@Component({
  selector: 'er-rebuild-host',
  imports: [MmErrored, Poisoned],
  providers: [provideTransitionScope()],
  template: REBUILD_TEMPLATE,
})
class RebuildHost {
  readonly boundary = viewChild.required(MmErrored);
}

const hiddenIn = (container: Element): Element[] =>
  [...container.querySelectorAll('*')].filter(
    (el) => (el as HTMLElement).style.display === 'none',
  );

const hiddenCount = (boundary: MmErrored): number =>
  (boundary['hidden'] as Map<Node, unknown>).size;

async function poisonedSetup() {
  const ctx = await setup(RebuildHost);
  const first = ctx.knobs.instances[0] as Poisoned;
  const content = ctx.container.querySelector('.content');
  (ctx.container.querySelector('.field') as HTMLInputElement).value = 'typed';
  first.poison();
  await ctx.settle();
  return { ...ctx, first, content };
}

describe('*mmErrored: retry({ rebuild: true })', () => {
  it('poisoned state faults again on the default retry (same instance, as in A-P1); a rebuild renders a new instance clean', async () => {
    const { fixture, container, handler, knobs, settle, first, content } =
      await poisonedSetup();
    const scope = scopeOf(fixture.debugElement.injector);
    const boundary = boundaryOf(fixture.componentInstance);
    expect(handler.viewErrors.map((r) => r.error.message)).toEqual([
      'poisoned',
    ]);
    expect(isShown(content)).toBe(false);

    // default retry keeps the instance, and its state throws again
    (container.querySelector('.retry') as HTMLButtonElement).click();
    await settle();
    expect(knobs.instances).toEqual([first]);
    expect(container.querySelector('.content')).toBe(content);
    expect(isShown(content)).toBe(false);
    expect(handler.viewErrors.length).toBe(2);
    expect(scope.errored().length).toBe(1);

    boundary.retry({ rebuild: true });
    // synchronous, like the default retry
    expect(knobs.instances.length).toBe(2);
    const second = knobs.instances[1];
    expect(second).toBeInstanceOf(Poisoned);
    expect(second).not.toBe(first);
    expect(knobs.destroyed).toEqual([first]);
    expect(container.querySelector('.fb')).toBeNull();
    await settle();

    const fresh = container.querySelector('.content');
    expect(fresh).not.toBe(content);
    expect(content?.isConnected).toBe(false);
    expect(container.querySelectorAll('.content').length).toBe(1);
    expect(isShown(fresh)).toBe(true);
    expect(container.querySelector('.state')?.textContent).toBe('fresh');
    expect((container.querySelector('.field') as HTMLInputElement).value).toBe(
      '',
    );
    expect(handler.viewErrors.length).toBe(2);
    expect(handler.handled).toEqual([]);
    expect(scope.errored()).toEqual([]);
    expect(scope.failed()).toBe(false);
    expect(boundary.error()).toBeUndefined();

    // the rebuilt view is the one guarded now: a fault in it is caught and kept
    knobs.bad.set(true);
    await settle();
    expect(handler.viewErrors.length).toBe(3);
    expect(container.querySelector('.content')).toBe(fresh);
    expect(isShown(fresh)).toBe(false);
    knobs.bad.set(false);
    boundary.retry();
    await settle();
    expect(knobs.instances).toEqual([first, second]);
    expect(isShown(fresh)).toBe(true);
    expect(scope.errored()).toEqual([]);
  });

  it('a rebuild of faulted, hidden content leaves no hidden nodes or bookkeeping behind', async () => {
    const { fixture, container, settle, content } = await poisonedSetup();
    const boundary = boundaryOf(fixture.componentInstance);
    expect(hiddenIn(container)).toEqual([content]);
    expect(hiddenCount(boundary)).toBe(1);

    boundary.retry({ rebuild: true });
    await settle();
    expect(content?.isConnected).toBe(false);
    expect(hiddenIn(container)).toEqual([]);
    expect(hiddenCount(boundary)).toBe(0);
  });

  it('the fallback context retry takes the option: a template button rebuilds', async () => {
    const { fixture, container, handler, knobs, settle, first, content } =
      await poisonedSetup();
    const scope = scopeOf(fixture.debugElement.injector);
    (container.querySelector('.rebuild') as HTMLButtonElement).click();
    await settle();
    expect(knobs.instances.length).toBe(2);
    expect(knobs.instances[1]).not.toBe(first);
    expect(content?.isConnected).toBe(false);
    expect(isShown(container.querySelector('.content'))).toBe(true);
    expect(container.querySelector('.state')?.textContent).toBe('fresh');
    expect(container.querySelector('.fb')).toBeNull();
    expect(handler.viewErrors.length).toBe(1);
    expect(scope.errored()).toEqual([]);
  });

  it('a rebuilt view that faults again lands on the fallback, reports once more, and keeps the census member', async () => {
    const { fixture, container, handler, knobs, settle, first, content } =
      await poisonedSetup();
    const scope = scopeOf(fixture.debugElement.injector);
    const boundary = boundaryOf(fixture.componentInstance);
    const [entry] = scope.errored();
    expect(entry.failure.displayName).toBe('poisoned-region');

    knobs.bad.set(true);
    boundary.retry({ rebuild: true });
    await settle();
    expect(handler.viewErrors.map((r) => r.error.message)).toEqual([
      'poisoned',
      'bad',
    ]);
    expect(knobs.destroyed).toEqual([first]);
    expect(knobs.instances.length).toBe(2);
    const second = knobs.instances[1];
    expect(content?.isConnected).toBe(false);
    const rebuilt = container.querySelector('.content');
    expect(container.querySelectorAll('.content').length).toBe(1);
    expect(isShown(rebuilt)).toBe(false);
    expect(hiddenIn(container)).toEqual([rebuilt]);
    expect(container.querySelector('.fb')?.textContent).toBe('bad');
    expect(boundary.error()?.message).toBe('bad');
    expect(scope.errored().length).toBe(1);
    expect(scope.errored()[0].member).toBe(entry.member);
    expect(scope.errored()[0].failure.message).toBe('bad');

    // the rebuilt instance is kept: a default retry after the fix resumes it
    knobs.bad.set(false);
    boundary.retry();
    await settle();
    expect(knobs.instances).toEqual([first, second]);
    expect(container.querySelector('.content')).toBe(rebuilt);
    expect(isShown(rebuilt)).toBe(true);
    expect(handler.viewErrors.length).toBe(2);
    expect(scope.errored()).toEqual([]);
  });

  it('a rebuild whose new view throws while being built drops the old hide bookkeeping and keeps the member', async () => {
    const { fixture, container, handler, knobs, settle, first, content } =
      await poisonedSetup();
    const scope = scopeOf(fixture.debugElement.injector);
    const boundary = boundaryOf(fixture.componentInstance);
    const [entry] = scope.errored();
    knobs.ctorThrows.set(true);
    boundary.retry({ rebuild: true });
    await settle();
    expect(handler.viewErrors.map((r) => r.error.message)).toEqual([
      'poisoned',
      'ctor-failed',
    ]);
    expect(knobs.destroyed).toEqual([first]);
    expect(content?.isConnected).toBe(false);
    expect(container.querySelector('.content')).toBeNull();
    expect(hiddenCount(boundary)).toBe(0);
    expect(container.querySelector('.fb')?.textContent).toBe('ctor-failed');
    expect(scope.errored().map((e) => e.member)).toEqual([entry.member]);

    knobs.ctorThrows.set(false);
    boundary.retry();
    await settle();
    expect(knobs.instances.length).toBe(2);
    expect(isShown(container.querySelector('.content'))).toBe(true);
    expect(scope.errored()).toEqual([]);
  });

  it('a destroy hook that throws during a rebuild is reported and the rebuild goes on', async () => {
    const { fixture, container, handler, knobs, settle, first } =
      await poisonedSetup();
    const scope = scopeOf(fixture.debugElement.injector);
    knobs.destroyThrows.set(true);
    fixture.componentInstance.boundary().retry({ rebuild: true });
    knobs.destroyThrows.set(false);
    await settle();
    const reported = [
      ...handler.viewErrors.map((r) => r.error),
      ...(handler.handled as Error[]),
    ].map((e) => e.message);
    expect(reported).toEqual(['poisoned', 'destroy-failed']);
    expect(knobs.destroyed).toEqual([first]);
    expect(knobs.instances.length).toBe(2);
    expect(container.querySelectorAll('.content').length).toBe(1);
    expect(isShown(container.querySelector('.content'))).toBe(true);
    expect(container.querySelector('.fb')).toBeNull();
    expect(scope.errored()).toEqual([]);
  });

  it('on a creation throw a rebuild is the same path as the default retry', async () => {
    const knobs = new Knobs();
    knobs.ctorThrows.set(true);
    const { fixture, container, handler, settle } = await setup(P3Host, knobs);
    const scope = scopeOf(fixture.debugElement.injector);
    fixture.componentInstance.boundary().retry({ rebuild: true });
    await settle();
    expect(handler.viewErrors.length).toBe(2);
    expect(container.querySelector('.content')).toBeNull();
    expect(scope.errored().length).toBe(1);

    knobs.ctorThrows.set(false);
    fixture.componentInstance.boundary().retry({ rebuild: true });
    await settle();
    expect(knobs.instances.length).toBe(1);
    expect(container.querySelectorAll('.content').length).toBe(1);
    expect(container.querySelector('.fb')).toBeNull();
    expect(handler.viewErrors.length).toBe(2);
    expect(scope.errored()).toEqual([]);
  });

  it('a rebuild recovers a block whose branch threw while being built (the default retry leaves it empty)', async () => {
    const { fixture, container, handler, knobs, settle } =
      await setup(LimitsHost);
    const content = container.querySelector('.content');
    knobs.ctorThrows.set(true);
    knobs.late.set(true);
    await settle();
    expect(handler.viewErrors.length).toBe(1);

    knobs.ctorThrows.set(false);
    fixture.componentInstance.boundary().retry({ rebuild: true });
    await settle();
    expect(content?.isConnected).toBe(false);
    expect(container.querySelector('er-ctor .ctor')?.textContent).toBe('built');
    expect(container.querySelector('.fb')).toBeNull();
    expect(handler.viewErrors.length).toBe(1);
  });

  it('a rebuild with no fault does nothing', async () => {
    const { fixture, container, knobs, settle } = await setup(RebuildHost);
    const content = container.querySelector('.content');
    fixture.componentInstance.boundary().retry({ rebuild: true });
    await settle();
    expect(knobs.instances.length).toBe(1);
    expect(knobs.destroyed).toEqual([]);
    expect(container.querySelector('.content')).toBe(content);
  });
});
