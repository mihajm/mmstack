import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { focusWithin } from './focus-within';

function mount() {
  const root = document.createElement('div');
  const child = document.createElement('button');
  const outside = document.createElement('button');
  root.appendChild(child);
  document.body.append(root, outside);
  return {
    root,
    child,
    outside,
    cleanup: () => (root.remove(), outside.remove()),
  };
}

const microtask = () => Promise.resolve();

describe('focusWithin', () => {
  let dom: ReturnType<typeof mount>;
  beforeEach(() => (dom = mount()));
  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    dom.cleanup();
  });

  it('reflects focus inside the target subtree', async () => {
    const { root, child } = dom;
    await TestBed.runInInjectionContext(async () => {
      const sig = focusWithin(root);

      expect(sig()).toBe(false);

      root.dispatchEvent(new FocusEvent('focusin'));
      expect(sig()).toBe(true);

      child.focus();
      root.dispatchEvent(new FocusEvent('focusout'));
      await microtask();
      expect(sig()).toBe(true);

      child.blur();
      root.dispatchEvent(new FocusEvent('focusout'));
      await microtask();
      expect(sig()).toBe(false);
    });
  });

  it('reads true at creation when focus is already inside', () => {
    dom.child.focus();
    const sig = TestBed.runInInjectionContext(() => focusWithin(dom.root));
    expect(sig()).toBe(true);
  });

  it('is a constant false on the server, even with focus inside', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    dom.child.focus();
    const sig = TestBed.runInInjectionContext(() => focusWithin(dom.root));
    expect(sig()).toBe(false);
    dom.root.dispatchEvent(new FocusEvent('focusin'));
    expect(sig()).toBe(false);
  });

  it('stops tracking a static target once its injector is destroyed', async () => {
    const parent = TestBed.inject(EnvironmentInjector);
    const child = createEnvironmentInjector([], parent);
    const sig = focusWithin(dom.root, { injector: child });

    dom.root.dispatchEvent(new FocusEvent('focusin'));
    expect(sig()).toBe(true);

    child.destroy();
    dom.outside.focus();
    dom.root.dispatchEvent(new FocusEvent('focusout'));
    await microtask();
    expect(sig()).toBe(true);
  });

  it('stops reacting to focusin after destroy', () => {
    const parent = TestBed.inject(EnvironmentInjector);
    const child = createEnvironmentInjector([], parent);
    const sig = focusWithin(dom.root, { injector: child });
    expect(sig()).toBe(false);
    child.destroy();
    dom.root.dispatchEvent(new FocusEvent('focusin'));
    expect(sig()).toBe(false);
  });

  describe('signal target', () => {
    it('reads false for a null target, before and after the effect runs', () => {
      const target = signal<Element | null>(null);
      const sig = TestBed.runInInjectionContext(() => focusWithin(target));
      expect(sig()).toBe(false);
      TestBed.tick();
      expect(sig()).toBe(false);
    });

    it('reads false before the first effect run, even with focus inside', () => {
      dom.child.focus();
      const target = signal<Element | null>(dom.root);
      const sig = TestBed.runInInjectionContext(() => focusWithin(target));
      expect(sig()).toBe(false);
      TestBed.tick();
      expect(sig()).toBe(true);
    });

    it('attaches to the element once the target resolves', () => {
      const target = signal<Element | null>(null);
      const sig = TestBed.runInInjectionContext(() => focusWithin(target));
      TestBed.tick();

      target.set(dom.root);
      TestBed.tick();
      expect(sig()).toBe(false);

      dom.root.dispatchEvent(new FocusEvent('focusin'));
      expect(sig()).toBe(true);
    });

    it('drops to false when the target becomes null', () => {
      dom.child.focus();
      const target = signal<Element | null>(dom.root);
      const sig = TestBed.runInInjectionContext(() => focusWithin(target));
      TestBed.tick();
      expect(sig()).toBe(true);

      target.set(null);
      TestBed.tick();
      expect(sig()).toBe(false);

      dom.root.dispatchEvent(new FocusEvent('focusin'));
      expect(sig()).toBe(false);
    });

    it('follows the new element when the target flips', () => {
      const other = document.createElement('div');
      document.body.appendChild(other);
      try {
        const target = signal<Element | null>(dom.root);
        const sig = TestBed.runInInjectionContext(() => focusWithin(target));
        TestBed.tick();

        target.set(other);
        TestBed.tick();
        expect(sig()).toBe(false);

        dom.root.dispatchEvent(new FocusEvent('focusin'));
        expect(sig()).toBe(false);

        other.dispatchEvent(new FocusEvent('focusin'));
        expect(sig()).toBe(true);
      } finally {
        other.remove();
      }
    });
  });

  describe('inside a shadow root', () => {
    function shadowMount() {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      const root = document.createElement('div');
      const a = document.createElement('button');
      const b = document.createElement('button');
      root.append(a, b);
      shadow.appendChild(root);
      return { host, root, a, b };
    }

    it('reads true at creation when focus is inside', () => {
      const s = shadowMount();
      try {
        s.a.focus();
        const sig = TestBed.runInInjectionContext(() => focusWithin(s.root));
        expect(sig()).toBe(true);
      } finally {
        s.host.remove();
      }
    });

    it('stays true when script moves focus between two children', async () => {
      const s = shadowMount();
      try {
        s.a.focus();
        const sig = TestBed.runInInjectionContext(() => focusWithin(s.root));
        s.b.focus();
        s.root.dispatchEvent(new FocusEvent('focusout'));
        s.root.dispatchEvent(new FocusEvent('focusin'));
        await microtask();
        expect(sig()).toBe(true);

        s.b.blur();
        s.root.dispatchEvent(new FocusEvent('focusout'));
        await microtask();
        expect(sig()).toBe(false);
      } finally {
        s.host.remove();
      }
    });
  });
});
