/* eslint-disable @angular-eslint/component-selector */
import {
  Component,
  computed,
  inject,
  InjectionToken,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { render } from '@testing-library/angular';
import {
  type ErroredEntry,
  injectTransitionScope,
  memberId,
  provideTransitionScope,
  registerResource,
  type RetryRound,
} from '@mmstack/primitives/core';
import { SuspenseBoundary } from './suspense-boundary';
import { MmRetryFailed, MmSuspenseError } from './suspense-error';

type FailingRef = ResourceRef<unknown> & {
  status: WritableSignal<ResourceStatus>;
  value: WritableSignal<unknown>;
  error: WritableSignal<unknown>;
  readonly reloads: () => number;
};

function makeFailingRef(status: ResourceStatus): FailingRef {
  const status$ = signal<ResourceStatus>(status);
  const value$ = signal<unknown>(undefined);
  let reloads = 0;
  return {
    status: status$,
    value: value$,
    error: signal<unknown>(undefined),
    isLoading: computed(() => status$() === 'loading'),
    hasValue: () => value$() !== undefined,
    reload: () => {
      reloads++;
      status$.set('loading');
      return true;
    },
    reloads: () => reloads,
    destroy: () => undefined,
  } as unknown as FailingRef;
}

const REF = new InjectionToken<FailingRef>('ref');

@Component({ selector: 'reg-cmp', template: `<span>real-content</span>` })
class Registers {
  constructor() {
    registerResource(inject(REF), { displayName: 'orders' });
  }
}

/** Two failed actions without a retry: dismissable, indicator-only (content stays). */
@Component({ selector: 'facades-cmp', template: `<span>real-content</span>` })
class FailsTwoActions {
  constructor() {
    const census = injectTransitionScope().census;
    for (const displayName of ['save', 'publish']) {
      const id = memberId('action', displayName);
      const facade = census.enroll({ id, displayName, retry: undefined });
      facade.started(1);
      facade.settled(1, {
        kind: 'error',
        error: {
          id,
          displayName,
          message: `${displayName} failed`,
          generation: 1,
        },
      });
    }
  }
}

type Seen = { retry?: () => RetryRound; entries?: readonly ErroredEntry[] };
const SEEN = new InjectionToken<Seen>('seen');

@Component({
  selector: 'error-host',
  imports: [SuspenseBoundary, Registers, MmSuspenseError],
  template: `
    <mm-suspense>
      <reg-cmp />
      <ul error *mmSuspenseError="let entries; retry as retry">
        @for (e of entries; track e.member.id) {
          <li>{{ e.failure.displayName }}: {{ e.failure.message }}</li>
        }
        <button
          class="retry"
          (click)="seen.retry = retry; seen.entries = entries; retry()"
        >
          retry
        </button>
      </ul>
    </mm-suspense>
  `,
})
class ErrorHost {
  protected readonly seen = inject(SEEN);
}

@Component({
  selector: 'dismiss-host',
  imports: [SuspenseBoundary, FailsTwoActions, MmSuspenseError],
  template: `
    <mm-suspense>
      <facades-cmp />
      <ul
        failed
        *mmSuspenseError="
          let entries;
          dismiss as dismiss;
          dismissAll as dismissAll
        "
      >
        @for (e of entries; track e.member.id) {
          <li>
            {{ e.failure.displayName }}
            <button
              [class]="'dismiss-' + e.failure.displayName"
              (click)="dismiss(e)"
            >
              x
            </button>
          </li>
        }
        <button class="dismiss-all" (click)="dismissAll()">all</button>
      </ul>
    </mm-suspense>
  `,
})
class DismissHost {}

/** No boundary around it: only the directive itself can take the view down. */
@Component({
  selector: 'bare-host',
  imports: [FailsTwoActions, MmSuspenseError],
  providers: [provideTransitionScope()],
  template: `
    <facades-cmp />
    <ul *mmSuspenseError="let entries; dismissAll as dismissAll">
      <li>{{ entries.length }}</li>
      <button class="dismiss-all" (click)="dismissAll()">all</button>
    </ul>
  `,
})
class BareHost {}

@Component({
  selector: 'retry-host',
  imports: [SuspenseBoundary, Registers, MmRetryFailed],
  template: `
    <mm-suspense>
      <reg-cmp />
      <button error mmRetryFailed>retry</button>
    </mm-suspense>
  `,
})
class RetryHost {}

const items = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('li')).map((li) =>
    (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

describe('*mmSuspenseError', () => {
  it('renders while the scope has failures, with the entries and a retry that runs one round', async () => {
    const ref = makeFailingRef('loading');
    const seen: Seen = {};
    const { container, fixture } = await render(ErrorHost, {
      providers: [
        { provide: REF, useValue: ref },
        { provide: SEEN, useValue: seen },
      ],
    });
    expect(container.querySelector('ul')).toBeNull();

    ref.error.set(new Error('404'));
    ref.status.set('error');
    fixture.detectChanges();

    expect(items(container)).toEqual(['orders: 404']);

    container.querySelector<HTMLButtonElement>('.retry')?.click();
    fixture.detectChanges();

    expect(ref.reloads()).toBe(1);
    expect(seen.entries?.map((e) => e.failure.displayName)).toEqual(['orders']);
    expect(seen.retry?.().dispatched).toBe(0); // the round already in flight is not re-run
    expect(ref.reloads()).toBe(1);
    expect(container.querySelector('ul')).toBeNull(); // no failures, no view
  });

  it('updates the entries in place and exposes dismiss and dismissAll', async () => {
    const { container, fixture } = await render(DismissHost);

    expect(container.textContent).toContain('real-content'); // indicator-only: content stays
    expect(items(container)).toEqual(['save x', 'publish x']);
    const list = container.querySelector('ul');

    container.querySelector<HTMLButtonElement>('.dismiss-save')?.click();
    fixture.detectChanges();
    expect(items(container)).toEqual(['publish x']);
    expect(container.querySelector('ul')).toBe(list); // same view, new context

    container.querySelector<HTMLButtonElement>('.dismiss-all')?.click();
    fixture.detectChanges();
    expect(container.querySelector('ul')).toBeNull();
    expect(
      container.querySelector('mm-suspense')?.getAttribute('data-failed'),
    ).toBeNull();
  });
});

describe('*mmSuspenseError outside a boundary slot', () => {
  it('clears its own view when the failures leave', async () => {
    const { container, fixture } = await render(BareHost);
    expect(items(container)).toEqual(['2']);

    container.querySelector<HTMLButtonElement>('.dismiss-all')?.click();
    fixture.detectChanges();

    expect(container.querySelector('ul')).toBeNull();
    expect(container.textContent).toContain('real-content');
  });
});

describe('mmRetryFailed', () => {
  it('a click dispatches one retryAll round; a second click while in flight dispatches nothing', async () => {
    const ref = makeFailingRef('loading');
    const { container, fixture } = await render(RetryHost, {
      providers: [{ provide: REF, useValue: ref }],
    });
    ref.status.set('error');
    fixture.detectChanges();

    const button =
      container.querySelector<HTMLButtonElement>('[mmRetryFailed]');
    button?.click();
    button?.click();

    expect(ref.reloads()).toBe(1);
  });
});
