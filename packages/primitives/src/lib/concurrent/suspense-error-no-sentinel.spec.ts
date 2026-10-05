/* eslint-disable @angular-eslint/component-selector */
import {
  Component,
  computed,
  inject,
  InjectionToken,
  type ResourceRef,
  type ResourceStatus,
  signal,
  viewChild,
  type WritableSignal,
} from '@angular/core';
import { render } from '@testing-library/angular';
import {
  type ErrorMintReport,
  isError,
  isSentinel,
  outcomeOf,
  registerResource,
  setErrorReporter,
} from '@mmstack/primitives/core';
import { SuspenseBoundary } from './suspense-boundary';
import { MmSuspenseError, type MmSuspenseErrorContext } from './suspense-error';

type FailingRef = ResourceRef<unknown> & {
  status: WritableSignal<ResourceStatus>;
  error: WritableSignal<unknown>;
};

function makeRef(): FailingRef {
  const status = signal<ResourceStatus>('loading');
  const value = signal<unknown>(undefined);
  return {
    status,
    value,
    error: signal<unknown>(undefined),
    isLoading: computed(() => status() === 'loading'),
    hasValue: () => value() !== undefined,
    reload: () => true,
    destroy: () => undefined,
  } as unknown as FailingRef;
}

const REF = new InjectionToken<FailingRef>('ref');

@Component({ selector: 'ns-reg', template: `<span>content</span>` })
class Registers {
  constructor() {
    registerResource(inject(REF), { displayName: 'orders' });
  }
}

@Component({
  selector: 'ns-host',
  imports: [SuspenseBoundary, Registers, MmSuspenseError],
  template: `
    <mm-suspense>
      <ns-reg />
      <ul
        error
        *mmSuspenseError="
          let entries;
          retry as retry;
          dismiss as dismiss;
          dismissAll as dismissAll
        "
      >
        @for (e of entries; track e.member.id) {
          <li>{{ e.failure.displayName }}: {{ e.failure.message }}</li>
        }
      </ul>
    </mm-suspense>
  `,
})
class Host {
  readonly dir = viewChild(MmSuspenseError);
}

/** Every value reachable through plain data (arrays, plain objects), functions not called. */
function reachable(value: unknown, depth = 3): unknown[] {
  if (depth < 0 || typeof value !== 'object' || value === null) return [value];
  const own = Array.isArray(value) ? value : Object.values(value);
  return [value, ...own.flatMap((v) => reachable(v, depth - 1))];
}

describe('*mmSuspenseError never hands a sentinel to a binding (negative control)', () => {
  afterEach(() => setErrorReporter(undefined));

  it('its context carries entries and functions, never an outcome, while the failed ref outcome IS an error sentinel', async () => {
    const reports: ErrorMintReport[] = [];
    setErrorReporter((r) => reports.push(r));
    const ref = makeRef();
    const { fixture, container } = await render(Host, {
      providers: [{ provide: REF, useValue: ref }],
    });
    ref.error.set(new Error('404'));
    ref.status.set('error');
    fixture.detectChanges();

    expect(isError(outcomeOf(ref)())).toBe(true);
    expect(container.querySelector('li')?.textContent).toBe('orders: 404');

    const dir = fixture.componentInstance.dir();
    const ctx = (
      dir as unknown as { view: { context: MmSuspenseErrorContext } }
    ).view.context;
    expect(Object.keys(ctx).sort()).toEqual([
      '$implicit',
      'dismiss',
      'dismissAll',
      'retry',
    ]);
    expect(Array.isArray(ctx.$implicit)).toBe(true);
    expect(ctx.$implicit).toHaveLength(1);
    expect(typeof ctx.retry).toBe('function');
    expect(typeof ctx.dismiss).toBe('function');
    expect(typeof ctx.dismissAll).toBe('function');
    const [entry] = ctx.$implicit;
    expect(typeof entry.failure.displayName).toBe('string');
    expect(typeof entry.failure.message).toBe('string');
    expect(reachable(ctx).some(isSentinel)).toBe(false);
    // nothing in the rendered view coerced a sentinel
    expect(reports.filter((r) => r.origin === 'leak')).toHaveLength(0);
  });
});
