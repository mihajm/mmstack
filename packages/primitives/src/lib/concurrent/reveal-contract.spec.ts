import {
  ApplicationRef,
  Component,
  computed,
  HostAttributeToken,
  inject,
  InjectionToken,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { registerResource } from '@mmstack/primitives/core';
import { MmReveal } from './reveal';
import { SuspenseBoundary } from './suspense-boundary';

type FakeRef = ResourceRef<unknown> & {
  status: WritableSignal<ResourceStatus>;
  value: WritableSignal<unknown>;
  error: WritableSignal<unknown>;
};

function makeRef(): FakeRef {
  const status = signal<ResourceStatus>('loading');
  const value = signal<unknown>(undefined);
  return {
    status,
    value,
    isLoading: computed(() => status() === 'loading'),
    hasValue: () => value() !== undefined,
    error: signal<unknown>(undefined),
    reload: () => true,
    destroy: () => undefined,
  } as unknown as FakeRef;
}

const ready = (ref: FakeRef) => {
  ref.value.set('v');
  ref.status.set('resolved');
};
const fail = (ref: FakeRef) => {
  ref.error.set(new Error('boom'));
  ref.status.set('error');
};

const REFS = new InjectionToken<Record<string, FakeRef>>('refs');

@Component({ selector: 'reg-cmp', template: `<b>content-{{ name }}</b>` })
class RegCmp {
  readonly name = inject(new HostAttributeToken('name'));
  constructor() {
    registerResource(inject(REFS)[this.name], { suspends: true });
  }
}

@Component({
  selector: 'doc-host',
  imports: [MmReveal, SuspenseBoundary, RegCmp],
  template: `<s class="render">{{ renders() }}</s
    ><mm-reveal [order]="order()">
      <mm-suspense class="s-a">
        <reg-cmp name="a" /><i placeholder>ph-a</i><i error>err-a</i>
      </mm-suspense>
      <mm-suspense class="s-b">
        <reg-cmp name="b" /><i placeholder>ph-b</i><i error>err-b</i>
      </mm-suspense>
      <mm-suspense class="s-c">
        <reg-cmp name="c" /><i placeholder>ph-c</i><i error>err-c</i>
      </mm-suspense>
    </mm-reveal>`,
})
class DocHost {
  readonly order = signal<'forwards' | 'together'>('forwards');
  /** Bumped to make the next tick render, as any app update would. */
  readonly renders = signal(0);
}

type Row = { readonly id: string; readonly show: boolean };

@Component({
  selector: 'keyed-reg',
  template: `<b>content-{{ id }}</b>`,
})
class KeyedReg {
  readonly id = inject(new HostAttributeToken('data-id'));
  constructor() {
    registerResource(inject(REFS)[this.id], { suspends: true });
  }
}

@Component({
  selector: 'keyed-host',
  imports: [MmReveal, SuspenseBoundary, KeyedReg],
  template: `
    <mm-reveal [items]="rows()">
      @for (row of rows(); track row.id) {
        @if (row.show) {
          <mm-suspense [item]="row">
            @switch (row.id) {
              @case ('a') {
                <keyed-reg data-id="a" />
              }
              @case ('b') {
                <keyed-reg data-id="b" />
              }
              @case ('c') {
                <keyed-reg data-id="c" />
              }
            }
            <i placeholder>ph-{{ row.id }}</i>
          </mm-suspense>
        }
      }
    </mm-reveal>
  `,
})
class KeyedHost {
  readonly rows = signal<readonly Row[]>([
    { id: 'a', show: true },
    { id: 'b', show: true },
    { id: 'c', show: true },
  ]);
}

const shownOf = (container: HTMLElement, names: readonly string[]) => {
  const text = container.textContent ?? '';
  return names.map((n) =>
    text.includes(`content-${n}`)
      ? 'content'
      : text.includes(`err-${n}`)
        ? 'error'
        : text.includes(`ph-${n}`)
          ? 'placeholder'
          : 'none',
  );
};

async function mount<T>(host: new () => T) {
  const r = { a: makeRef(), b: makeRef(), c: makeRef() };
  const { container, fixture } = await render(host, {
    providers: [{ provide: REFS, useValue: r }],
  });
  const step = async (fn: () => void = () => undefined) => {
    fn();
    const app = TestBed.inject(ApplicationRef);
    for (let i = 0; i < 3; i++) {
      app.tick();
      await fixture.whenStable();
    }
  };
  const shown = () => shownOf(container, ['a', 'b', 'c']);
  return { r, container, fixture, step, shown };
}

describe('<mm-reveal> defaults', () => {
  it('with no onError bound, a failed first slot lets the ready slots after it show', async () => {
    const { r, step, shown } = await mount(DocHost);
    await step(() => {
      fail(r.a);
      ready(r.b);
      ready(r.c);
    });
    expect(shown()).toEqual(['error', 'content', 'content']);
  });

  it('a plain document-order reveal logs no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { r, step } = await mount(DocHost);
      await step(() => ready(r.a));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('<mm-reveal> keyed', () => {
  it('a pending boundary taken away while its row stays in items stops holding', async () => {
    const { r, fixture, step, shown } = await mount(KeyedHost);
    await step(() => {
      ready(r.b);
      ready(r.c);
    });
    expect(shown()).toEqual(['placeholder', 'placeholder', 'placeholder']);
    await step(() =>
      fixture.componentInstance.rows.update((rows) =>
        rows.map((row) => (row.id === 'a' ? { ...row, show: false } : row)),
      ),
    );
    expect(shown()).toEqual(['none', 'content', 'content']);
  });

  it('with no track, the release order follows the data by identity', async () => {
    const { r, fixture, step, shown } = await mount(KeyedHost);
    const [a, b, c] = fixture.componentInstance.rows();
    await step(() => fixture.componentInstance.rows.set([c, b, a]));
    await step(() => ready(r.c));
    expect(shown()).toEqual(['placeholder', 'placeholder', 'content']);
    await step(() => ready(r.a));
    expect(shown()).toEqual(['placeholder', 'placeholder', 'content']);
    await step(() => ready(r.b));
    expect(shown()).toEqual(['content', 'content', 'content']);
  });
});

describe('<mm-reveal> placement', () => {
  const host = (container: HTMLElement, n: string) =>
    container.querySelector(`.s-${n}`) as HTMLElement;

  it('a slot host taken out of the document stops holding after the next render', async () => {
    const { r, fixture, container, step, shown } = await mount(DocHost);
    await step(() => {
      ready(r.b);
      ready(r.c);
    });
    expect(shown()).toEqual(['placeholder', 'placeholder', 'placeholder']);
    await step(() => {
      host(container, 'a').remove();
      fixture.componentInstance.renders.update((n) => n + 1);
    });
    expect(shown()).toEqual(['none', 'content', 'content']);
  });

  it('the last host leaving the document is seen too', async () => {
    const { r, fixture, container, step, shown } = await mount(DocHost);
    await step(() => {
      fixture.componentInstance.order.set('together');
      ready(r.a);
      ready(r.b);
    });
    expect(shown()).toEqual(['placeholder', 'placeholder', 'placeholder']);
    await step(() => {
      host(container, 'c').remove();
      fixture.componentInstance.renders.update((n) => n + 1);
    });
    expect(shown()).toEqual(['content', 'content', 'none']);
  });

  it('a reorder that keeps one slot in place still reorders the release', async () => {
    const { r, fixture, container, step, shown } = await mount(DocHost);
    await step(() => {
      ready(r.b);
      ready(r.c);
    });
    expect(shown()).toEqual(['placeholder', 'placeholder', 'placeholder']);
    await step(() => {
      const a = host(container, 'a');
      const parent = a.parentNode as Node;
      parent.insertBefore(host(container, 'c'), a);
      parent.appendChild(a);
      fixture.componentInstance.renders.update((n) => n + 1);
    });
    expect(shown()).toEqual(['placeholder', 'content', 'content']);
  });
});
