/* eslint-disable @angular-eslint/component-selector */
import {
  Component,
  computed,
  ErrorHandler,
  type ErrorDetails,
  inject,
  InjectionToken,
  input,
  resource,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { registerResource } from '@mmstack/primitives/core';
import { render } from '@testing-library/angular';
import { MmTransition } from './transition';

// Angular 22 `@boundary` composed with the swap primitive. Master only: `@boundary` does not
// exist on Angular 21.

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

/** Records what Angular's `@boundary` reports, and keeps the console quiet. */
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

const flush = async (detect: () => void) => {
  for (let i = 0; i < 5; i++) {
    detect();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
  }
  detect();
};

function visibleText(container: HTMLElement): string {
  return Array.from(container.querySelectorAll<HTMLElement>('.wrap'))
    .filter((el) => el.style.display !== 'none')
    .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .join('|');
}

const HOLD_REF = new InjectionToken<FakeRef>('hold-ref');

@Component({ selector: 'bc-a', template: `branch-a` })
class BranchA {}

@Component({ selector: 'bc-thrower', template: `{{ read() }}` })
class Thrower {
  protected read(): string {
    throw new Error('render failed');
  }
}

/** Keeps the incoming branch held: a non-suspending registration still in flight. */
@Component({ selector: 'bc-hold', template: `held` })
class Hold {
  constructor() {
    registerResource(inject(HOLD_REF), { suspends: false });
  }
}

// angular-eslint (22.5) cannot parse `@boundary` yet; a template held in a const is not extracted for template lint.
const INSIDE_HOST_TEMPLATE = `
    <div class="wrap" *mmTransition="tab(); let t">
      @switch (t) {
        @case ('a') {
          <bc-a />
        }
        @case ('x') {
          <bc-hold />
          @boundary {
            <bc-thrower />
          } @error {
            <span class="x-error">x-error</span>
          }
        }
      }
    </div>
  `;

@Component({
  selector: 'bc-inside-host',
  imports: [MmTransition, BranchA, Thrower, Hold],
  template: INSIDE_HOST_TEMPLATE,
})
class InsideHost {
  readonly tab = signal('a');
}

const AROUND_HOST_TEMPLATE = `
    @boundary {
      <div class="wrap" *mmTransition="tab(); let t">
        @switch (t) {
          @case ('a') {
            <bc-a />
          }
          @case ('x') {
            <bc-thrower />
          }
        }
      </div>
    } @error {
      <span class="outer-error">outer-error</span>
    }
  `;

@Component({
  selector: 'bc-around-host',
  imports: [MmTransition, BranchA, Thrower],
  template: AROUND_HOST_TEMPLATE,
})
class AroundHost {
  readonly tab = signal('a');
}

describe('@boundary composition with *mmTransition (Angular 22)', () => {
  it('inside a branch: the throw is caught there, the outgoing view is untouched during the hold, the swap commits', async () => {
    const hold = makeRef('loading');
    const { fixture, container } = await render(InsideHost, {
      providers: [
        { provide: HOLD_REF, useValue: hold },
        { provide: ErrorHandler, useClass: RecordingErrorHandler },
      ],
    });
    const handler = fixture.debugElement.injector.get(
      ErrorHandler,
    ) as RecordingErrorHandler;
    await flush(() => fixture.detectChanges());
    const outgoing = container.querySelector('bc-a');
    expect(visibleText(container)).toBe('branch-a');

    fixture.componentInstance.tab.set('x');
    await flush(() => fixture.detectChanges());

    // caught by the branch's own boundary, while the branch is still held hidden
    expect(handler.viewErrors.length).toBe(1);
    expect(handler.viewErrors[0].details.boundary?.type).toBe(InsideHost);
    expect(handler.handled).toEqual([]);
    expect(container.querySelector('.x-error')).not.toBeNull();
    expect(container.querySelector('bc-thrower')).toBeNull();
    // the outgoing view: same node, still the only visible one
    expect(container.querySelector('bc-a')).toBe(outgoing);
    expect(visibleText(container)).toBe('branch-a');

    hold.value.set({ ok: true });
    hold.status.set('resolved');
    await flush(() => fixture.detectChanges());

    // committed: the incoming branch is the one visible view, with its @error block
    expect(container.querySelectorAll('.wrap').length).toBe(1);
    expect(visibleText(container)).toContain('held');
    expect(visibleText(container)).toContain('x-error');
    expect(container.querySelector('bc-a')).toBeNull();
  });

  it('around the directive (the anti-pattern): a throw in the incoming branch removes the whole block, outgoing view included', async () => {
    const { fixture, container } = await render(AroundHost, {
      providers: [{ provide: ErrorHandler, useClass: RecordingErrorHandler }],
    });
    const handler = fixture.debugElement.injector.get(
      ErrorHandler,
    ) as RecordingErrorHandler;
    await flush(() => fixture.detectChanges());
    expect(visibleText(container)).toBe('branch-a');

    fixture.componentInstance.tab.set('x');
    await flush(() => fixture.detectChanges());

    expect(handler.viewErrors.length).toBe(1);
    expect(container.querySelectorAll('.wrap').length).toBe(0); // both views gone
    expect(container.querySelector('bc-a')).toBeNull();
    expect(container.querySelector('.outer-error')).not.toBeNull();
  });
});

// ── the `reload(); $reset()` idiom ───────────────────────────────────────────
// The block throws on bad data from a resource owned OUTSIDE the block. `$reset()` re-renders
// from the same inputs and fetches nothing, so the handler reloads the resource as well.

@Component({ selector: 'bc-row', template: `{{ label() }}` })
class Row {
  readonly item = input.required<string>();
  protected readonly label = computed(() => {
    if (this.item() === 'bad') throw new Error('bad data');
    return `row:${this.item()}`;
  });
}

const ANSWERS = new InjectionToken<string[]>('answers');

const IDIOM_HOST_TEMPLATE = `
    @boundary {
      @if (data.isLoading()) {
        <span class="loading">loading</span>
      } @else {
        <bc-row [item]="data.value() ?? ''" />
      }
    } @error {
      <button class="both" (click)="data.reload(); $reset()">retry</button>
      <button class="reset" (click)="$reset()">reset</button>
      <button class="reload" (click)="data.reload()">reload</button>
    }
  `;

@Component({
  selector: 'bc-idiom-host',
  imports: [Row],
  template: IDIOM_HOST_TEMPLATE,
})
class IdiomHost {
  private readonly answers = inject(ANSWERS);
  readonly loads = signal(0);
  readonly data = resource({
    loader: async () => {
      const i = this.loads();
      this.loads.set(i + 1);
      return this.answers[Math.min(i, this.answers.length - 1)];
    },
  });
}

async function idiom() {
  const { fixture, container } = await render(IdiomHost, {
    providers: [
      { provide: ANSWERS, useValue: ['bad', 'good'] },
      { provide: ErrorHandler, useClass: RecordingErrorHandler },
    ],
  });
  const handler = fixture.debugElement.injector.get(
    ErrorHandler,
  ) as RecordingErrorHandler;
  const settle = () => flush(() => fixture.detectChanges());
  await settle();
  const click = async (selector: string) => {
    (container.querySelector(selector) as HTMLButtonElement).click();
    await settle();
  };
  return { fixture, container, handler, settle, click };
}

describe('@boundary: the reload(); $reset() idiom (Angular 22)', () => {
  it('reload + $reset in one handler: after the reload resolves with good data the block renders', async () => {
    const { container, handler, click } = await idiom();
    expect(handler.viewErrors.length).toBe(1); // first answer is bad
    expect(container.querySelector('.both')).not.toBeNull();

    await click('.both');

    expect(container.textContent).toContain('row:good');
    expect(container.querySelector('.both')).toBeNull();
    expect(handler.viewErrors.length).toBe(1);
  });

  it('$reset alone re-renders from the same bad data and lands on @error again', async () => {
    const { container, handler, click } = await idiom();
    await click('.reset');
    expect(handler.viewErrors.length).toBe(2);
    expect(container.querySelector('.both')).not.toBeNull();
    expect(container.textContent).not.toContain('row:');
  });

  it('reload alone fetches good data but the block stays on @error until reset', async () => {
    const { fixture, container, click } = await idiom();
    await click('.reload');
    expect(fixture.componentInstance.data.value()).toBe('good');
    expect(container.querySelector('.both')).not.toBeNull();
    expect(container.textContent).not.toContain('row:good');
  });
});
