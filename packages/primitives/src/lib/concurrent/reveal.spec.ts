/* eslint-disable @angular-eslint/component-selector */
import {
  Component,
  computed,
  DestroyRef,
  viewChild,
  inject,
  InjectionToken,
  HostAttributeToken,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { render } from '@testing-library/angular';
import { registerResource } from '@mmstack/primitives/core';
import { MmReveal } from './reveal';
import type { RevealOnError, RevealOrder } from '@mmstack/primitives/core';
import { SuspenseBoundary } from './suspense-boundary';
import { MmTransition } from './transition';

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
  ref.error.set(undefined);
  ref.value.set('v');
  ref.status.set('resolved');
};
const fail = (ref: FakeRef) => {
  ref.value.set(undefined);
  ref.error.set(new Error('boom'));
  ref.status.set('error');
};
const suspend = (ref: FakeRef) => {
  ref.value.set(undefined);
  ref.error.set(undefined);
  ref.status.set('loading');
};

const REFS = new InjectionToken<(key: string) => FakeRef>('refs');
let created: string[] = [];

/** Registers the ref named by its static `name` attribute into the nearest scope, at construction. */
@Component({
  selector: 'reg-cmp',
  template: `<b>content-{{ name }}</b>`,
})
class RegCmp {
  readonly name = inject(new HostAttributeToken('name'));
  constructor() {
    created.push(this.name);
    registerResource(inject(REFS)(this.name), { suspends: true });
  }
}

type Shown = 'content' | 'placeholder' | 'error' | 'none';

function shown(container: HTMLElement, names: readonly string[]): Shown[] {
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
}

function refs(...names: string[]): Record<string, FakeRef> {
  return Object.fromEntries(names.map((n) => [n, makeRef()]));
}

function provide(map: Record<string, FakeRef>) {
  return [{ provide: REFS, useValue: (k: string) => map[k] }];
}

beforeEach(() => {
  created = [];
});

const cfg = {
  order: signal<RevealOrder>('forwards'),
  onError: signal<RevealOnError>('settled'),
  collapsed: signal(false),
};

@Component({
  selector: 'three-host',
  imports: [MmReveal, SuspenseBoundary, RegCmp],
  template: `
    <mm-reveal
      [order]="cfg.order()"
      [onError]="cfg.onError()"
      [collapsed]="cfg.collapsed()"
    >
      <mm-suspense>
        <reg-cmp name="a" />
        <i placeholder>ph-a</i>
        <i error>err-a</i>
      </mm-suspense>
      <mm-suspense>
        <reg-cmp name="b" />
        <i placeholder>ph-b</i>
        <i error>err-b</i>
      </mm-suspense>
      <mm-suspense>
        <reg-cmp name="c" />
        <i placeholder>ph-c</i>
        <i error>err-c</i>
      </mm-suspense>
    </mm-reveal>
  `,
})
class ThreeHost {
  protected readonly cfg = cfg;
}

async function setup(
  order: RevealOrder,
  onError: RevealOnError,
  collapsed = false,
) {
  cfg.order.set(order);
  cfg.onError.set(onError);
  cfg.collapsed.set(collapsed);
  const r = refs('a', 'b', 'c');
  const { container, fixture } = await render(ThreeHost, {
    providers: provide(r),
  });
  const trace: Shown[][] = [shown(container, ['a', 'b', 'c'])];
  const step = async (fn: () => void) => {
    fn();
    fixture.detectChanges();
    await fixture.whenStable();
    trace.push(shown(container, ['a', 'b', 'c']));
  };
  return { r, trace, step, container };
}

describe('<mm-reveal> (DOM, per tick)', () => {
  it('forwards: the last slot readies first and waits behind the others', async () => {
    const { r, trace, step } = await setup('forwards', 'settled');
    await step(() => ready(r['c']));
    await step(() => ready(r['b']));
    await step(() => ready(r['a']));
    expect(trace).toEqual([
      ['placeholder', 'placeholder', 'placeholder'],
      ['placeholder', 'placeholder', 'placeholder'],
      ['placeholder', 'placeholder', 'placeholder'],
      ['content', 'content', 'content'],
    ]);
    expect(created).toEqual(['a', 'b', 'c']);
  });

  it('forwards, settled: a failing middle slot shows its error and the last slot goes on', async () => {
    const { r, trace, step } = await setup('forwards', 'settled');
    await step(() => ready(r['c']));
    await step(() => ready(r['a']));
    await step(() => fail(r['b']));
    expect(trace).toEqual([
      ['placeholder', 'placeholder', 'placeholder'],
      ['placeholder', 'placeholder', 'placeholder'],
      ['content', 'placeholder', 'placeholder'],
      ['content', 'error', 'content'],
    ]);
  });

  it('forwards, blocks: a failing middle slot shows its error and holds the last slot until a retry succeeds', async () => {
    const { r, trace, step } = await setup('forwards', 'blocks');
    await step(() => {
      ready(r['a']);
      ready(r['c']);
    });
    await step(() => fail(r['b']));
    await step(() => suspend(r['b']));
    await step(() => ready(r['b']));
    expect(trace).toEqual([
      ['placeholder', 'placeholder', 'placeholder'],
      ['content', 'placeholder', 'placeholder'],
      ['content', 'error', 'placeholder'],
      ['content', 'placeholder', 'placeholder'],
      ['content', 'content', 'content'],
    ]);
  });

  it('together, settled: one failing slot does not hold the group; it shows its error with the rest', async () => {
    const { r, trace, step } = await setup('together', 'settled');
    await step(() => ready(r['a']));
    await step(() => ready(r['c']));
    await step(() => fail(r['b']));
    expect(trace).toEqual([
      ['placeholder', 'placeholder', 'placeholder'],
      ['placeholder', 'placeholder', 'placeholder'],
      ['placeholder', 'placeholder', 'placeholder'],
      ['content', 'error', 'content'],
    ]);
  });

  it('together, blocks: only the failed slot shows (its error) until its retry succeeds', async () => {
    const { r, trace, step } = await setup('together', 'blocks');
    await step(() => {
      ready(r['a']);
      ready(r['c']);
    });
    await step(() => fail(r['b']));
    await step(() => ready(r['b']));
    expect(trace).toEqual([
      ['placeholder', 'placeholder', 'placeholder'],
      ['placeholder', 'placeholder', 'placeholder'],
      ['placeholder', 'error', 'placeholder'],
      ['content', 'content', 'content'],
    ]);
  });

  it('collapsed: only the next slot in line shows a placeholder, held slots render nothing', async () => {
    const { r, trace, step } = await setup('forwards', 'settled', true);
    await step(() => ready(r['c']));
    await step(() => ready(r['a']));
    await step(() => ready(r['b']));
    expect(trace).toEqual([
      ['placeholder', 'none', 'none'],
      ['placeholder', 'none', 'none'],
      ['content', 'placeholder', 'none'],
      ['content', 'content', 'content'],
    ]);
  });

  it('a shown slot that suspends again stays shown and does not hold the slots after it', async () => {
    const { r, trace, step } = await setup('forwards', 'settled');
    await step(() => ready(r['c']));
    await step(() => ready(r['a']));
    await step(() => suspend(r['a']));
    await step(() => ready(r['b']));
    expect(trace).toEqual([
      ['placeholder', 'placeholder', 'placeholder'],
      ['placeholder', 'placeholder', 'placeholder'],
      ['content', 'placeholder', 'placeholder'],
      ['placeholder', 'placeholder', 'placeholder'],
      ['placeholder', 'content', 'content'],
    ]);
  });
});

@Component({
  selector: 'nested-host',
  imports: [MmReveal, SuspenseBoundary, RegCmp],
  template: `
    <mm-reveal order="forwards">
      <mm-suspense>
        <reg-cmp name="a" />
        <i placeholder>ph-a</i>
        <mm-suspense>
          <reg-cmp name="inner" />
          <i placeholder>ph-inner</i>
        </mm-suspense>
      </mm-suspense>
      <mm-suspense>
        <reg-cmp name="c" />
        <i placeholder>ph-c</i>
      </mm-suspense>
    </mm-reveal>
  `,
})
class NestedHost {}

describe('<mm-reveal> membership and scope', () => {
  it('a boundary inside a slot is not a slot: it never holds the slots after its parent', async () => {
    const r = refs('a', 'inner', 'c');
    const { container, fixture } = await render(NestedHost, {
      providers: provide(r),
    });
    ready(r['a']);
    ready(r['c']);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(created).toEqual(['a', 'inner', 'c']);
    expect(shown(container, ['a', 'inner', 'c'])).toEqual([
      'content',
      'placeholder',
      'content',
    ]);
  });

  it('a held slot still creates and loads its content; only display waits', async () => {
    const { r, step, container } = await setup('forwards', 'settled');
    const third = () =>
      container.querySelectorAll('mm-suspense')[2].getAttribute('aria-busy');
    expect(created).toEqual(['a', 'b', 'c']);
    expect(third()).toBe('true');
    await step(() => ready(r['c']));
    expect(shown(container, ['c'])).toEqual(['placeholder']);
    expect(third()).toBeNull();
  });
});

const key = signal('x');
let transitionDestroyed: string[] = [];

@Component({
  selector: 'gate-cmp',
  template: '',
})
class GateCmp {
  readonly name = inject(new HostAttributeToken('name'));
  constructor() {
    registerResource(inject(REFS)(`${this.name}-gate`), { suspends: true });
    inject(DestroyRef).onDestroy(() => transitionDestroyed.push(this.name));
  }
}

@Component({
  selector: 'transition-host',
  imports: [MmTransition, MmReveal, SuspenseBoundary, GateCmp, RegCmp],
  template: `
    <div *mmTransition="key(); let k">
      @if (k === 'x') {
        <gate-cmp name="x" />
        <mm-reveal>
          <mm-suspense
            ><reg-cmp name="x1" /><i placeholder>ph-x1</i></mm-suspense
          >
          <mm-suspense
            ><reg-cmp name="x2" /><i placeholder>ph-x2</i></mm-suspense
          >
        </mm-reveal>
      } @else {
        <gate-cmp name="y" />
        <mm-reveal>
          <mm-suspense
            ><reg-cmp name="y1" /><i placeholder>ph-y1</i></mm-suspense
          >
          <mm-suspense
            ><reg-cmp name="y2" /><i placeholder>ph-y2</i></mm-suspense
          >
        </mm-reveal>
      }
    </div>
  `,
})
class TransitionHost {
  protected readonly key = key;
  readonly transition = viewChild.required(MmTransition);
}

function visibleText(container: HTMLElement): string {
  return [...container.querySelectorAll('div')]
    .filter((d) => d.style.display !== 'none')
    .map((d) => d.textContent ?? '')
    .join('|');
}

describe('<mm-reveal> inside *mmTransition', () => {
  it('a reveal in the hidden incoming view orders its slots while hidden and commits with the one swap', async () => {
    key.set('x');
    transitionDestroyed = [];
    const r = refs('x-gate', 'x1', 'x2', 'y-gate', 'y1', 'y2');
    for (const n of ['x-gate', 'x1', 'x2']) ready(r[n]);
    const { container, fixture } = await render(TransitionHost, {
      providers: provide(r),
    });
    const host = fixture.componentInstance;
    const frames: { visible: string; pending: boolean; y: Shown[] }[] = [];
    const step = async (fn: () => void) => {
      fn();
      fixture.detectChanges();
      await fixture.whenStable();
      frames.push({
        visible: visibleText(container).replace(/\s+/g, ''),
        pending: host.transition().pending(),
        y: shown(container, ['y1', 'y2']),
      });
    };
    await step(() => undefined);
    await step(() => key.set('y'));
    await step(() => ready(r['y2']));
    await step(() => ready(r['y1']));
    await step(() => ready(r['y-gate']));
    await step(() => undefined);

    expect(frames.map((f) => f.visible)).toEqual([
      'content-x1content-x2',
      'content-x1content-x2',
      'content-x1content-x2',
      'content-x1content-x2',
      'content-y1content-y2',
      'content-y1content-y2',
    ]);
    expect(frames.map((f) => f.pending)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
    // the hidden view's own reveal state, read from the whole DOM including the hidden subtree
    expect(frames.map((f) => f.y)).toEqual([
      ['none', 'none'],
      ['placeholder', 'placeholder'],
      ['placeholder', 'placeholder'],
      ['content', 'content'],
      ['content', 'content'],
      ['content', 'content'],
    ]);
    expect(transitionDestroyed).toEqual(['x']);
  });
});
