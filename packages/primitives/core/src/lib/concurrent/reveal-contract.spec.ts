import {
  createEnvironmentInjector,
  EnvironmentInjector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createRevealCoordinator,
  injectRevealSlot,
  REVEAL,
  type RevealCoordinator,
  type RevealOptions,
  type RevealSlotState,
} from './reveal';

function slotOf(
  c: RevealCoordinator,
  initial: RevealSlotState = 'pending',
  item?: () => unknown,
) {
  const state = signal<RevealSlotState>(initial);
  const slot = c.register(state, null, item ?? null);
  slot.mount();
  return { state, slot };
}

const releasedOf = (...slots: { slot: { released: () => boolean } }[]) =>
  slots.map((s) => s.slot.released());

describe('createRevealCoordinator defaults', () => {
  it.each([
    ['no options', undefined],
    ['empty options', {}],
  ] as [string, RevealOptions | undefined][])(
    'with %s: forwards order, settled errors, not collapsed',
    (_, opts) => {
      const c = createRevealCoordinator(opts);
      const a = slotOf(c);
      const b = slotOf(c);
      expect(c.collapsed()).toBe(false);
      expect(b.slot.collapsed()).toBe(false);
      b.state.set('ready');
      expect(releasedOf(a, b)).toEqual([false, false]);
      expect(b.slot.gated()).toBe(true);
      a.state.set('failed');
      expect(releasedOf(a, b)).toEqual([true, true]);
    },
  );
});

describe('createRevealCoordinator keyed', () => {
  it('with no track, keys are the items themselves', () => {
    const a = { n: 'a' };
    const b = { n: 'b' };
    const c = createRevealCoordinator({ keyed: { items: () => [b, a] } });
    const sa = slotOf(c, 'ready', () => a);
    const sb = slotOf(c, 'pending', () => b);
    expect(releasedOf(sa, sb)).toEqual([false, false]);
    sb.state.set('ready');
    expect(releasedOf(sa, sb)).toEqual([true, true]);
  });

  it('a given track places slots whose items are different objects', () => {
    const c = createRevealCoordinator({
      keyed: {
        items: () => [{ id: 2 }, { id: 1 }],
        track: (r) => (r as { id: number }).id,
      },
    });
    const one = slotOf(c, 'ready', () => ({ id: 1 }));
    const two = slotOf(c, 'pending', () => ({ id: 2 }));
    expect(releasedOf(one, two)).toEqual([false, false]);
    two.state.set('ready');
    expect(releasedOf(one, two)).toEqual([true, true]);
  });

  it('a key that appears twice takes the place of its first appearance', () => {
    const c = createRevealCoordinator({
      keyed: { items: () => ['x', 'y', 'x'] },
    });
    const x = slotOf(c, 'pending', () => 'x');
    const y = slotOf(c, 'ready', () => 'y');
    expect(releasedOf(x, y)).toEqual([false, false]);
  });

  it('a slot that becomes ready while another leaves in the same batch is released', () => {
    const items = signal(['a', 'x', 'b']);
    const c = createRevealCoordinator({ keyed: { items } });
    const a = slotOf(c, 'ready', () => 'a');
    const x = slotOf(c, 'ready', () => 'x');
    const b = slotOf(c, 'pending', () => 'b');
    expect(releasedOf(a, x, b)).toEqual([true, true, false]);
    items.set(['x', 'b']);
    expect(releasedOf(x, b)).toEqual([true, false]);
    a.slot.unregister();
    b.state.set('ready');
    expect(releasedOf(x, b)).toEqual([true, true]);
  });
});

describe('injectRevealSlot', () => {
  function envWith(coordinator: RevealCoordinator) {
    const root = TestBed.inject(EnvironmentInjector);
    const parent = createEnvironmentInjector(
      [{ provide: REVEAL, useValue: coordinator }],
      root,
    );
    return () => createEnvironmentInjector([], parent);
  }

  it('joins with no options, and leaves when its injector is destroyed', () => {
    const c = createRevealCoordinator();
    const child = envWith(c)();
    const first = runInInjectionContext(child, () =>
      injectRevealSlot(() => 'pending'),
    );
    expect(first).not.toBeNull();
    first?.mount();
    const second = slotOf(c, 'ready');
    expect(second.slot.released()).toBe(false);
    child.destroy();
    expect(second.slot.released()).toBe(true);
  });
});
