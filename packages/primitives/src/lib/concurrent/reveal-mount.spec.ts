/* eslint-disable @angular-eslint/component-selector */
import { Component, input, resource, signal } from '@angular/core';
import { render } from '@testing-library/angular';
import { vi } from 'vitest';
import { registerResource } from '@mmstack/primitives/core';
import type { RevealOnError, RevealOrder } from '@mmstack/primitives/core';
import { MmReveal } from './reveal';
import { SuspenseBoundary } from './suspense-boundary';

/**
 * A slot counts only once its boundary has rendered. These hosts put state in front of the
 * coordinator before it is real: a required input not yet bound (the resource's params throw, so the
 * slot reads failed), content inside an `@if` that has not run yet (the scope is empty, so the slot
 * reads ready), and the static control, where every boundary renders before any of them mounts and
 * the release relies on the same-tick re-render after the mount writes. Change detection runs by
 * hand in dev mode, so a missed re-render surfaces as ExpressionChanged.
 */

const gates: Record<string, () => void> = {};
const order = signal<RevealOrder>('forwards');
const onError = signal<RevealOnError>('settled');

@Component({
  selector: 'gated-panel',
  template: `<b>content-{{ label() }}</b>`,
})
class GatedPanel {
  readonly label = input.required<string>();
  protected readonly data = registerResource(
    resource({
      params: () => this.label(),
      loader: ({ params }) =>
        new Promise<string>((r) => (gates[params] = () => r(params))),
    }),
    { suspends: true },
  );
}

@Component({
  selector: 'for-bound-host',
  imports: [MmReveal, SuspenseBoundary, GatedPanel],
  template: `
    <mm-reveal [order]="order()" [onError]="onError()">
      @for (p of panels; track p) {
        <mm-suspense>
          <i placeholder>ph-{{ p }}</i>
          <gated-panel [label]="p" />
        </mm-suspense>
      }
    </mm-reveal>
  `,
})
class ForBoundHost {
  protected readonly order = order;
  protected readonly onError = onError;
  protected readonly panels = ['a', 'b', 'c'];
}

@Component({
  selector: 'for-if-host',
  imports: [MmReveal, SuspenseBoundary, GatedPanel],
  template: `
    <mm-reveal [order]="order()" [onError]="onError()">
      @for (p of panels; track p) {
        <mm-suspense>
          <i placeholder>ph-{{ p }}</i>
          @if (true) {
            <gated-panel [label]="p" />
          }
        </mm-suspense>
      }
    </mm-reveal>
  `,
})
class ForIfHost {
  protected readonly order = order;
  protected readonly onError = onError;
  protected readonly panels = ['a', 'b', 'c'];
}

@Component({
  selector: 'static-host',
  imports: [MmReveal, SuspenseBoundary, GatedPanel],
  template: `
    <mm-reveal [order]="order()" [onError]="onError()">
      <mm-suspense
        ><i placeholder>ph-a</i><gated-panel label="a"
      /></mm-suspense>
      <mm-suspense
        ><i placeholder>ph-b</i><gated-panel label="b"
      /></mm-suspense>
      <mm-suspense
        ><i placeholder>ph-c</i><gated-panel label="c"
      /></mm-suspense>
    </mm-reveal>
  `,
})
class StaticHost {
  protected readonly order = order;
  protected readonly onError = onError;
}

const shown = (el: HTMLElement, names = ['a', 'b', 'c']) =>
  names
    .map((n) =>
      el.textContent?.includes(`content-${n}`)
        ? 'C'
        : el.textContent?.includes(`ph-${n}`)
          ? 'p'
          : '-',
    )
    .join('');

async function settle(fixture: { detectChanges: () => void }) {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
  }
}

async function traceOf(
  host: unknown,
  o: RevealOrder,
  e: RevealOnError,
  readyOrder: readonly string[],
) {
  order.set(o);
  onError.set(e);
  const { container, fixture } = await render(host as never, {
    autoDetectChanges: false,
  });
  await settle(fixture);
  const trace = [shown(container)];
  for (const k of readyOrder) {
    gates[k]();
    await settle(fixture);
    trace.push(shown(container));
  }
  return trace;
}

const HOSTS = [
  ['@for with a bound input', ForBoundHost],
  ['@for with the content under @if', ForIfHost],
  ['static siblings', StaticHost],
] as const;

describe('<mm-reveal>: a slot counts only once its boundary has rendered', () => {
  for (const [name, host] of HOSTS) {
    it(`${name}, backwards: b then c then a`, async () => {
      expect(
        await traceOf(host, 'backwards', 'settled', ['b', 'c', 'a']),
      ).toEqual(['ppp', 'ppp', 'pCC', 'CCC']);
    });

    it(`${name}, forwards: b then c then a`, async () => {
      expect(
        await traceOf(host, 'forwards', 'settled', ['b', 'c', 'a']),
      ).toEqual(['ppp', 'ppp', 'ppp', 'CCC']);
    });

    it(`${name}, backwards under blocks: same order`, async () => {
      expect(
        await traceOf(host, 'backwards', 'blocks', ['b', 'c', 'a']),
      ).toEqual(['ppp', 'ppp', 'pCC', 'CCC']);
    });
  }
});

@Component({
  selector: 'mixed-host',
  imports: [MmReveal, SuspenseBoundary, GatedPanel],
  template: `
    <mm-reveal order="forwards">
      @if (true) {
        <mm-suspense
          ><i placeholder>ph-x</i><gated-panel label="x"
        /></mm-suspense>
      }
      <mm-suspense
        ><i placeholder>ph-y</i><gated-panel label="y"
      /></mm-suspense>
    </mm-reveal>
  `,
})
class MixedHost {}

describe('<mm-reveal>: order is document order', () => {
  it('a boundary under @if comes first when it is first on the page, though it was created second', async () => {
    const { container, fixture } = await render(MixedHost, {
      autoDetectChanges: false,
    });
    await settle(fixture);
    expect(shown(container, ['x', 'y'])).toBe('pp');
    gates['y']();
    await settle(fixture);
    expect(shown(container, ['x', 'y'])).toBe('pp'); // y waits for x, which is above it
    gates['x']();
    await settle(fixture);
    expect(shown(container, ['x', 'y'])).toBe('CC');
  });

  it('x first in the document reveals as soon as it is ready', async () => {
    const { container, fixture } = await render(MixedHost, {
      autoDetectChanges: false,
    });
    await settle(fixture);
    gates['x']();
    await settle(fixture);
    expect(shown(container, ['x', 'y'])).toBe('Cp');
  });
});

const rowsOrder = signal(['a', 'b', 'c']);

@Component({
  selector: 'reorder-host',
  imports: [MmReveal, SuspenseBoundary, GatedPanel],
  template: `
    <mm-reveal order="forwards">
      @for (p of rows(); track p) {
        <section>
          <mm-suspense>
            <i placeholder>ph-{{ p }}</i>
            <gated-panel [label]="p" />
          </mm-suspense>
        </section>
      }
    </mm-reveal>
  `,
})
class ReorderHost {
  protected readonly rows = rowsOrder;
}

const showOnly = signal(true);

@Component({
  selector: 'leave-host',
  imports: [MmReveal, SuspenseBoundary, GatedPanel],
  template: `
    <mm-reveal order="forwards">
      @if (showOnly()) {
        <mm-suspense
          ><i placeholder>ph-a</i><gated-panel label="a"
        /></mm-suspense>
      }
      <mm-suspense
        ><i placeholder>ph-b</i><gated-panel label="b"
      /></mm-suspense>
    </mm-reveal>
  `,
})
class LeaveHost {
  protected readonly showOnly = showOnly;
}

describe('<mm-reveal>: placement changes with no slot changing', () => {
  it('rows reordered while waiting (wrapped in sections): the new first row is the frontier', async () => {
    rowsOrder.set(['a', 'b', 'c']);
    const { container, fixture } = await render(ReorderHost, {
      autoDetectChanges: false,
    });
    await settle(fixture);
    gates['c']();
    await settle(fixture);
    expect(shown(container)).toBe('ppp'); // c is last: it waits
    rowsOrder.set(['c', 'a', 'b']); // the boundaries' own siblings do not change, the order does
    await settle(fixture);
    expect(shown(container)).toBe('ppC'); // c is first now: nothing holds it
  });

  it('a pending first slot that leaves the page stops holding the rest', async () => {
    showOnly.set(true);
    const { container, fixture } = await render(LeaveHost, {
      autoDetectChanges: false,
    });
    await settle(fixture);
    gates['b']();
    await settle(fixture);
    expect(shown(container, ['a', 'b'])).toBe('pp');
    showOnly.set(false);
    await settle(fixture);
    expect(shown(container, ['a', 'b'])).toBe('-C');
  });
});

type Row = { readonly id: string };
const keyedRows = signal<readonly Row[]>([]);
const keyedCollapsed = signal(false);

@Component({
  selector: 'keyed-host',
  imports: [MmReveal, SuspenseBoundary, GatedPanel],
  template: `
    <mm-reveal
      [order]="order()"
      [onError]="onError()"
      [collapsed]="collapsed()"
      [items]="rows()"
      [track]="byId"
    >
      @for (row of rows(); track row.id) {
        <mm-suspense [item]="row">
          <i placeholder>ph-{{ row.id }}</i>
          <gated-panel [label]="row.id" />
        </mm-suspense>
      }
    </mm-reveal>
  `,
})
class KeyedHost {
  protected readonly order = order;
  protected readonly onError = onError;
  protected readonly collapsed = keyedCollapsed;
  protected readonly rows = keyedRows;
  protected readonly byId = (row: Row) => row.id;
}

const rowsOf = (...ids: string[]) => ids.map((id) => ({ id }));

describe('<mm-reveal>: order from the data with [items]', () => {
  beforeEach(() => {
    keyedRows.set(rowsOf('a', 'b', 'c'));
    keyedCollapsed.set(false);
  });

  it('rows reordered while waiting, collapsed: the placeholder moves to the new first row in the same tick, no relayout', async () => {
    order.set('forwards');
    onError.set('settled');
    keyedCollapsed.set(true);
    const relayout = vi.spyOn(MmReveal.prototype, 'relayout');
    try {
      const { container, fixture } = await render(KeyedHost, {
        autoDetectChanges: false,
      });
      await settle(fixture);
      expect(shown(container)).toBe('p--');
      keyedRows.set(rowsOf('c', 'a', 'b')); // new row objects, same keys
      fixture.detectChanges();
      expect(shown(container)).toBe('--p');
      expect(relayout).not.toHaveBeenCalled();
    } finally {
      relayout.mockRestore();
    }
  });

  it('backwards: b then c then a', async () => {
    expect(
      await traceOf(KeyedHost, 'backwards', 'settled', ['b', 'c', 'a']),
    ).toEqual(['ppp', 'ppp', 'pCC', 'CCC']);
  });

  it('forwards: b then c then a', async () => {
    expect(
      await traceOf(KeyedHost, 'forwards', 'settled', ['b', 'c', 'a']),
    ).toEqual(['ppp', 'ppp', 'ppp', 'CCC']);
  });

  it('a row that leaves the array stops holding the rest and comes back with what it had', async () => {
    order.set('forwards');
    onError.set('settled');
    const { container, fixture } = await render(KeyedHost, {
      autoDetectChanges: false,
    });
    await settle(fixture);
    gates['b']();
    await settle(fixture);
    expect(shown(container)).toBe('ppp'); // b waits on a
    keyedRows.set(rowsOf('b', 'c'));
    fixture.detectChanges();
    expect(shown(container)).toBe('-Cp');
    keyedRows.set(rowsOf('a', 'b', 'c'));
    await settle(fixture);
    expect(shown(container)).toBe('pCp'); // b stays shown, c waits on a again
  });
});

@Component({
  selector: 'dup-keys-host',
  imports: [MmReveal, SuspenseBoundary, GatedPanel],
  template: `
    <mm-reveal [items]="keys">
      @for (row of rows(); track row.id) {
        <mm-suspense [item]="row.id">
          <i placeholder>ph-{{ row.id }}</i>
          <gated-panel [label]="row.id" />
        </mm-suspense>
      }
    </mm-reveal>
  `,
})
class DupKeysHost {
  protected readonly rows = keyedRows;
  protected readonly keys = ['a', 'b', 'a', 'c'];
}

@Component({
  selector: 'no-item-host',
  imports: [MmReveal, SuspenseBoundary, GatedPanel],
  template: `
    <mm-reveal [items]="rows()" [track]="byId">
      @for (row of rows(); track row.id) {
        <mm-suspense>
          <i placeholder>ph-{{ row.id }}</i>
          <gated-panel [label]="row.id" />
        </mm-suspense>
      }
    </mm-reveal>
  `,
})
class NoItemHost {
  protected readonly rows = keyedRows;
  protected readonly byId = (row: Row) => row.id;
}

describe('<mm-reveal>: keyed dev warnings, once per reveal', () => {
  const warnings = (spy: { mock: { calls: unknown[][] } }, text: string) =>
    spy.mock.calls.filter((c) => String(c[0]).includes(text)).length;

  beforeEach(() => keyedRows.set(rowsOf('a', 'b', 'c')));

  it('duplicate keys in items', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { fixture } = await render(DupKeysHost, {
        autoDetectChanges: false,
      });
      await settle(fixture);
      expect(warnings(warn, 'duplicate key')).toBe(1);
      expect(warnings(warn, 'no [item]')).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('a boundary without [item] under a reveal with [items]', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { container, fixture } = await render(NoItemHost, {
        autoDetectChanges: false,
      });
      await settle(fixture);
      expect(warnings(warn, 'no [item]')).toBe(1);
      expect(warnings(warn, 'duplicate key')).toBe(0);
      expect(shown(container)).toBe('ppp'); // held: no slot takes part
    } finally {
      warn.mockRestore();
    }
  });
});
