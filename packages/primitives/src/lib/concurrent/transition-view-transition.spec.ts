import {
  Component,
  computed,
  inject,
  InjectionToken,
  type OnInit,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { render } from '@testing-library/angular';
import {
  injectStartTransaction,
  registerResource,
} from '@mmstack/primitives/core';
import { MmTransition } from './transition';

type FakeRef = ResourceRef<unknown> & {
  status: WritableSignal<ResourceStatus>;
};

function loadingRef(): FakeRef {
  const status = signal<ResourceStatus>('loading');
  return {
    status,
    value: signal(undefined),
    isLoading: computed(() => status() === 'loading'),
    hasValue: () => status() === 'resolved',
    error: signal(undefined),
    reload: () => true,
    destroy: () => undefined,
  } as unknown as FakeRef;
}

const LOAD = new InjectionToken<FakeRef>('load');

@Component({ selector: 'vt-loads', template: `loads` })
class Loads {
  constructor() {
    registerResource(inject(LOAD), { suspends: false });
  }
}

// a transaction holds the incoming scope from creation and lets go in the first update pass
@Component({ selector: 'vt-brief-hold', template: `brief` })
class BriefHold implements OnInit {
  private release = () => undefined as void;

  constructor() {
    injectStartTransaction()((tx) => {
      this.release = tx.retain();
    });
  }

  ngOnInit() {
    this.release();
  }
}

@Component({
  selector: 'vt-host',
  imports: [MmTransition, Loads],
  template: `
    <div class="wrap" *mmTransition="tab(); viewTransition: vt(); let t">
      @switch (t) {
        @case ('loads') {
          <vt-loads />
        }
        @default {
          {{ t }}
        }
      }
    </div>
  `,
})
class Host {
  readonly tab = signal('a');
  readonly vt = signal(true);
}

@Component({
  selector: 'vt-default-host',
  imports: [MmTransition],
  template: `<div class="wrap" *mmTransition="tab(); let t">{{ t }}</div>`,
})
class DefaultHost {
  readonly tab = signal('a');
}

@Component({
  selector: 'vt-brief-host',
  imports: [MmTransition, BriefHold],
  template: `
    <div class="wrap" *mmTransition="tab(); viewTransition: true; let t">
      <vt-brief-hold />{{ t }}
    </div>
  `,
})
class BriefHost {
  readonly tab = signal('a');
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
    .map((el) => el.textContent?.trim() ?? '')
    .join('|');
}

type Doc = { startViewTransition?: unknown };

function stubViewTransitions(mode: 'sync' | 'deferred') {
  const queued: (() => void)[] = [];
  const start = vi.fn((cb: () => void) => {
    if (mode === 'sync') cb();
    else queued.push(cb);
    return {};
  });
  (document as unknown as Doc).startViewTransition = start;
  const runQueued = () => queued.splice(0).forEach((cb) => cb());
  return { start, runQueued };
}

describe('MmTransition with view transitions', () => {
  afterEach(() => {
    delete (document as unknown as Doc).startViewTransition;
  });

  it('is off by default: no view transition starts and the swap commits', async () => {
    const { start } = stubViewTransitions('sync');
    const { fixture, container } = await render(DefaultHost);
    await flush(() => fixture.detectChanges());
    fixture.componentInstance.tab.set('b');
    await flush(() => fixture.detectChanges());
    expect([visibleText(container), start.mock.calls.length]).toEqual(['b', 0]);
  });

  it('with the input set to false no view transition starts', async () => {
    const { start } = stubViewTransitions('sync');
    const { fixture, container } = await render(Host);
    fixture.componentInstance.vt.set(false);
    await flush(() => fixture.detectChanges());
    fixture.componentInstance.tab.set('b');
    await flush(() => fixture.detectChanges());
    expect([visibleText(container), start.mock.calls.length]).toEqual(['b', 0]);
  });

  it('when on, the swap runs inside one view transition', async () => {
    const { start, runQueued } = stubViewTransitions('deferred');
    const { fixture, container } = await render(Host);
    await flush(() => fixture.detectChanges());
    expect(start).not.toHaveBeenCalled();

    fixture.componentInstance.tab.set('b');
    await flush(() => fixture.detectChanges());
    expect([visibleText(container), start.mock.calls.length]).toEqual(['a', 1]);

    runQueued();
    await flush(() => fixture.detectChanges());
    expect(visibleText(container)).toBe('b');
    expect(container.textContent).not.toContain('a');
  });

  it('a swap superseded before its view transition callback runs never commits', async () => {
    const ref = loadingRef();
    const { start, runQueued } = stubViewTransitions('deferred');
    const { fixture, container } = await render(Host, {
      providers: [{ provide: LOAD, useValue: ref }],
    });
    await flush(() => fixture.detectChanges());

    fixture.componentInstance.tab.set('b');
    await flush(() => fixture.detectChanges());
    expect(start).toHaveBeenCalledTimes(1);

    fixture.componentInstance.tab.set('loads');
    await flush(() => fixture.detectChanges());
    runQueued();
    await flush(() => fixture.detectChanges());
    expect(visibleText(container)).toBe('a');
    expect(container.textContent).not.toContain('b');

    ref.status.set('resolved');
    await flush(() => fixture.detectChanges());
    expect(start).toHaveBeenCalledTimes(2);
    runQueued();
    await flush(() => fixture.detectChanges());
    expect(visibleText(container)).toBe('loads');
  });

  it('a hold that ends before the first render starts one view transition for the swap', async () => {
    const { start, runQueued } = stubViewTransitions('deferred');
    const { fixture, container } = await render(BriefHost);
    await flush(() => fixture.detectChanges());

    fixture.componentInstance.tab.set('b');
    await flush(() => fixture.detectChanges());
    await flush(() => fixture.detectChanges());
    expect(start).toHaveBeenCalledTimes(1);

    runQueued();
    await flush(() => fixture.detectChanges());
    expect(visibleText(container)).toBe('briefb');
  });
});
