import {
  Component,
  inject,
  InjectionToken,
  type OnInit,
  resource,
  type ResourceStatus,
  signal,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  injectTransitionScope,
  provideTransitionScope,
  type TransitionScope,
} from '@mmstack/primitives/core';
import { MmOutcome, type MmOutcomeSource } from './outcome-view';

type Src = MmOutcomeSource<string> & {
  resolve(v: string): void;
  fail(e: unknown): void;
};

function makeSrc(opts: { withError?: boolean } = {}): Src {
  const status = signal<ResourceStatus>('loading');
  const value = signal<string | undefined>(undefined);
  const error = signal<unknown>(undefined);
  return {
    status,
    value,
    ...(opts.withError === false ? {} : { error }),
    isLoading: () => status() === 'loading',
    hasValue: () => status() !== 'error' && value() !== undefined,
    resolve: (v: string) => {
      value.set(v);
      status.set('resolved');
    },
    fail: (e: unknown) => {
      error.set(e);
      status.set('error');
    },
  } as unknown as Src;
}

const SRC = new InjectionToken<Src>('src');
const SCOPE = new InjectionToken<{ scope?: TransitionScope }>('scope');

@Component({ selector: 'probe', template: '' })
class Probe implements OnInit {
  private readonly scope = injectTransitionScope();
  private readonly box = inject(SCOPE);
  ngOnInit(): void {
    this.box.scope = this.scope;
  }
}

@Component({
  selector: 'named-host',
  imports: [MmOutcome, Probe],
  providers: [provideTransitionScope()],
  template: `
    <probe />
    <p *mmOutcome="src; let v; error: er; name: label()">
      <input class="v" [value]="v" />
    </p>
    <p *mmOutcome="plain; error: er"></p>
    <ng-template #er let-e
      ><span class="er">{{ e?.message ?? 'none' }}</span></ng-template
    >
  `,
})
class NamedHost {
  readonly src = inject(SRC);
  readonly label = signal('profile');
  readonly plain = makeSrc();
}

@Component({
  selector: 'default-host',
  imports: [MmOutcome, Probe],
  providers: [provideTransitionScope()],
  template: `<probe />
    <p *mmOutcome="src"></p>`,
})
class DefaultNameHost {
  readonly src = inject(SRC);
}

@Component({
  selector: 'angular-host',
  imports: [MmOutcome, Probe],
  providers: [provideTransitionScope()],
  template: `<probe />
    <p *mmOutcome="res; error: er"></p>
    <ng-template #er><span class="er">failed</span></ng-template>`,
})
class AngularResourceHost {
  readonly res = resource({
    loader: () => Promise.reject(new Error('down')),
  });
}

const settle = async (fixture: ComponentFixture<unknown>) => {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
  }
  fixture.detectChanges();
};

async function mount<T>(host: new () => T, src: Src = makeSrc()) {
  const box: { scope?: TransitionScope } = {};
  TestBed.configureTestingModule({
    providers: [
      { provide: SRC, useValue: src },
      { provide: SCOPE, useValue: box },
    ],
  });
  const fixture = TestBed.createComponent(host);
  await settle(fixture);
  const scope = box.scope;
  if (!scope) throw new Error('probe did not run');
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, scope, el, src };
}

const failures = (scope: TransitionScope) =>
  scope.errored().map((e) => e.failure);

describe('*mmOutcome contract', () => {
  it('names a failure "resource" when no name is bound', async () => {
    const { fixture, scope, src } = await mount(DefaultNameHost);
    src.fail(new Error('x'));
    await settle(fixture);
    expect(failures(scope).map((f) => f.displayName)).toEqual(['resource']);
  });

  it('a changed name is picked up while the source stays the same', async () => {
    const { fixture, scope, src } = await mount(NamedHost);
    src.fail(new Error('x'));
    await settle(fixture);
    expect(failures(scope).map((f) => f.displayName)).toEqual(['profile']);
    fixture.componentInstance.label.set('account');
    await settle(fixture);
    expect(failures(scope).map((f) => f.displayName)).toEqual(['account']);
  });

  it('an error-like value that is not an Error gives its string message', async () => {
    const { fixture, scope, el, src } = await mount(NamedHost);
    src.fail({ status: 500, message: 'server said no' });
    await settle(fixture);
    expect(failures(scope).map((f) => f.message)).toEqual(['server said no']);
    expect(el.querySelector('.er')?.textContent).toBe('server said no');
  });

  it('a source with no error signal fails with no message and shows its error slot', async () => {
    const src = makeSrc({ withError: false });
    const { fixture, scope, el } = await mount(NamedHost, src);
    src.fail(new Error('unseen'));
    await settle(fixture);
    expect(failures(scope)).toEqual([
      expect.objectContaining({ displayName: 'profile', message: undefined }),
    ]);
    expect(el.querySelector('.er')?.textContent).toBe('none');
  });

  it('an Angular resource() with no hasContent fails the scope without a throw', async () => {
    const { scope, el } = await mount(AngularResourceHost);
    expect(scope.failed()).toBe(true);
    expect(failures(scope)).toEqual([
      expect.objectContaining({ displayName: 'resource', message: 'down' }),
    ]);
    expect(el.querySelector('.er')?.textContent).toBe('failed');
  });

  it('a new value updates the value view in place', async () => {
    const { fixture, el, src } = await mount(NamedHost);
    src.resolve('a');
    await settle(fixture);
    const first = el.querySelector('.v') as HTMLInputElement;
    expect(first.value).toBe('a');
    src.resolve('b');
    await settle(fixture);
    const second = el.querySelector('.v') as HTMLInputElement;
    expect(second).toBe(first);
    expect(second.value).toBe('b');
  });
});
