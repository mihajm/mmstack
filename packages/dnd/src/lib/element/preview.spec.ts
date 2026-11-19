import {
  ApplicationRef,
  Component,
  DestroyRef,
  EnvironmentInjector,
  inject,
  TemplateRef,
  input,
  inputBinding,
  signal,
  viewChild,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { pointerOutsideOfPreview } from '@atlaskit/pragmatic-drag-and-drop/utils/pointer-outside-of-preview';

import { createPointerPreview, registerCustomPreview } from './preview';

type PreviewNativeConfig = {
  render: (args: { container: HTMLElement }) => (() => void) | void;
  getOffset?: (args: { container: HTMLElement }) => { x: number; y: number };
};
let renderFn: PreviewNativeConfig['render'] | undefined;
let lastConfig: PreviewNativeConfig | undefined;

vi.mock(
  '@atlaskit/pragmatic-drag-and-drop/utils/set-custom-native-drag-preview',
  () => ({
    setCustomNativeDragPreview: (cfg: PreviewNativeConfig) => {
      lastConfig = cfg;
      renderFn = cfg.render;
      return () => undefined;
    },
  }),
);

vi.mock(
  '@atlaskit/pragmatic-drag-and-drop/utils/pointer-outside-of-preview',
  () => ({
    pointerOutsideOfPreview: vi.fn(() => () => ({ x: 0, y: 0 })),
  }),
);

@Component({ selector: 'mm-prev', template: `{{ count() }}|{{ label() }}` })
class Prev {
  readonly count = input(0);
  readonly label = input('');
}

@Component({
  template: `<ng-template #t let-v>tpl:{{ v }}</ng-template>`,
})
class TplHost {
  readonly t = viewChild.required('t', { read: TemplateRef });
}

describe('preview — bindings (#14)', () => {
  beforeEach(() => ((renderFn = undefined), (lastConfig = undefined)));

  it('forwards reactive input bindings (signal + getter) to the preview', () => {
    const envInjector = TestBed.inject(EnvironmentInjector);
    const appRef = TestBed.inject(ApplicationRef);
    const count = signal(5);

    registerCustomPreview(
      {
        component: Prev,
        bindings: [
          inputBinding('count', count), // a signal is a value getter
          inputBinding('label', () => 'hi'),
        ],
      },
      envInjector,
      appRef,
      { nativeSetDragImage: vi.fn() },
    );

    const container = document.createElement('div');
    const cleanup = renderFn?.({ container });
    appRef.tick();
    expect(container.textContent).toBe('5|hi');

    // the binding stays live — updating the signal reflects without a re-render
    count.set(9);
    appRef.tick();
    expect(container.textContent).toBe('9|hi');
    cleanup?.();
  });
});

describe('preview — config variants, cleanup & offset', () => {
  beforeEach(() => ((renderFn = undefined), (lastConfig = undefined)));

  function env() {
    return {
      envInjector: TestBed.inject(EnvironmentInjector),
      appRef: TestBed.inject(ApplicationRef),
    };
  }

  it('no-ops when there is no nativeSetDragImage (e.g. the external adapter)', () => {
    const { envInjector, appRef } = env();
    registerCustomPreview({ render: () => undefined }, envInjector, appRef, {
      nativeSetDragImage: null,
    });
    expect(renderFn).toBeUndefined(); // never reached pragmatic
  });

  it('component preview: cleanup detaches the view and destroys it', () => {
    const { envInjector, appRef } = env();
    registerCustomPreview({ component: Prev }, envInjector, appRef, {
      nativeSetDragImage: vi.fn(),
    });
    const container = document.createElement('div');
    const cleanup = renderFn?.({ container });
    appRef.tick();
    expect(container.textContent).toBe('0|'); // rendered
    const detach = vi.spyOn(appRef, 'detachView');
    cleanup?.();
    expect(detach).toHaveBeenCalled(); // view torn down
  });

  it('template preview: renders the context, cleans the nodes on cleanup', () => {
    const { envInjector, appRef } = env();
    const fix = TestBed.createComponent(TplHost);
    fix.detectChanges();
    const tpl = fix.componentInstance.t();

    registerCustomPreview(
      { template: tpl, context: 'X' },
      envInjector,
      appRef,
      { nativeSetDragImage: vi.fn() },
    );
    const container = document.createElement('div');
    const cleanup = renderFn?.({ container });
    appRef.tick();
    expect(container.textContent).toContain('tpl:X');
    cleanup?.();
    expect(container.textContent).toBe(''); // embedded view destroyed
  });

  it('template getter resolving to null → render no-ops with no cleanup', () => {
    const { envInjector, appRef } = env();
    registerCustomPreview({ template: () => null }, envInjector, appRef, {
      nativeSetDragImage: vi.fn(),
    });
    const container = document.createElement('div');
    const cleanup = renderFn?.({ container });
    expect(container.textContent).toBe('');
    expect(cleanup).toBeUndefined();
  });

  it('raw render: forwards the container and returns the caller cleanup', () => {
    const { envInjector, appRef } = env();
    const cleanupSpy = vi.fn();
    const renderSpy = vi.fn((c: HTMLElement) => {
      c.textContent = 'raw';
      return cleanupSpy;
    });
    registerCustomPreview({ render: renderSpy }, envInjector, appRef, {
      nativeSetDragImage: vi.fn(),
    });
    const container = document.createElement('div');
    const cleanup = renderFn?.({ container });
    expect(renderSpy).toHaveBeenCalledWith(container);
    expect(container.textContent).toBe('raw');
    cleanup?.();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves offset: fixed {x,y}, pointer-outside (fn), and none', () => {
    const { envInjector, appRef } = env();
    const reg = (offset?: 'pointer-outside' | { x: number; y: number }) =>
      registerCustomPreview(
        { render: () => undefined, offset },
        envInjector,
        appRef,
        {
          nativeSetDragImage: vi.fn(),
        },
      );

    reg({ x: 4, y: 6 });
    expect(
      lastConfig?.getOffset?.({ container: document.createElement('div') }),
    ).toEqual({
      x: 4,
      y: 6,
    });

    reg('pointer-outside');
    expect(typeof lastConfig?.getOffset).toBe('function');

    reg(undefined);
    expect(lastConfig?.getOffset).toBeUndefined();
  });
});

@Component({ selector: 'mm-prev-life', template: 'life' })
class LifePrev {
  static destroyed = 0;
  constructor() {
    inject(DestroyRef).onDestroy(() => LifePrev.destroyed++);
  }
}

@Component({
  imports: [LifePrev],
  template: `<ng-template #t let-v><mm-prev-life />{{ v }}</ng-template>`,
})
class LifeTplHost {
  readonly t = viewChild.required('t', { read: TemplateRef });
}

describe('preview: contract details', () => {
  const env = () => ({
    envInjector: TestBed.inject(EnvironmentInjector),
    appRef: TestBed.inject(ApplicationRef),
  });
  beforeEach(() => {
    renderFn = undefined;
    lastConfig = undefined;
    LifePrev.destroyed = 0;
  });

  it("'pointer-outside' uses pragmatic's helper with an 8px gap", () => {
    const { envInjector, appRef } = env();
    const sentinel = () => ({ x: 1, y: 2 });
    vi.mocked(pointerOutsideOfPreview).mockReturnValueOnce(sentinel);
    registerCustomPreview(
      { render: () => undefined, offset: 'pointer-outside' },
      envInjector,
      appRef,
      { nativeSetDragImage: vi.fn() },
    );
    expect(pointerOutsideOfPreview).toHaveBeenLastCalledWith({
      x: '8px',
      y: '8px',
    });
    expect(lastConfig?.getOffset).toBe(sentinel);
  });

  it('a template getter and a context getter are both resolved', () => {
    const { envInjector, appRef } = env();
    const fix = TestBed.createComponent(TplHost);
    fix.detectChanges();
    const tpl = fix.componentInstance.t();
    registerCustomPreview(
      { template: () => tpl, context: () => 'Y' },
      envInjector,
      appRef,
      { nativeSetDragImage: vi.fn() },
    );
    const container = document.createElement('div');
    renderFn?.({ container });
    appRef.tick();
    expect(container.textContent).toContain('tpl:Y');
  });

  it('cleanup destroys a component preview and the views inside a template preview', () => {
    const { envInjector, appRef } = env();
    registerCustomPreview({ component: LifePrev }, envInjector, appRef, {
      nativeSetDragImage: vi.fn(),
    });
    const c1 = document.createElement('div');
    const cleanup1 = renderFn?.({ container: c1 });
    appRef.tick();
    cleanup1?.();
    expect(LifePrev.destroyed).toBe(1);

    const fix = TestBed.createComponent(LifeTplHost);
    fix.detectChanges();
    registerCustomPreview(
      { template: fix.componentInstance.t(), context: 'Z' },
      envInjector,
      appRef,
      { nativeSetDragImage: vi.fn() },
    );
    const c2 = document.createElement('div');
    const cleanup2 = renderFn?.({ container: c2 });
    appRef.tick();
    cleanup2?.();
    expect(LifePrev.destroyed).toBe(2);
  });

  it.each([
    [{ x: 4, y: 6 }, 'translate(34px, 16px)'],
    ['pointer-outside', 'translate(38px, 18px)'],
    [undefined, 'translate(30px, 10px)'],
  ] as const)(
    'a pointer preview is fixed, pointer-transparent, and offset by %j',
    (offset, transform) => {
      const { envInjector, appRef } = env();
      let container: HTMLElement | undefined;
      const p = createPointerPreview(
        { render: (c) => void (container = c), offset },
        envInjector,
        appRef,
      );
      p.move(30, 10);
      expect(container?.style.position).toBe('fixed');
      expect(container?.style.pointerEvents).toBe('none');
      expect(container?.style.transform).toBe(transform);
      p.destroy();
      expect(document.body.contains(container as HTMLElement)).toBe(false);
    },
  );
});
