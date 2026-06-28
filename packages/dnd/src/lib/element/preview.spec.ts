import {
  ApplicationRef,
  Component,
  EnvironmentInjector,
  input,
  inputBinding,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { registerCustomPreview } from './preview';

let renderFn:
  | ((args: { container: HTMLElement }) => (() => void) | void)
  | undefined;

vi.mock(
  '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview',
  () => ({
    setCustomNativeDragPreview: (cfg: {
      render: (args: { container: HTMLElement }) => (() => void) | void;
    }) => {
      renderFn = cfg.render;
      return () => undefined;
    },
  }),
);

vi.mock(
  '@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview',
  () => ({ pointerOutsideOfPreview: () => () => ({ x: 0, y: 0 }) }),
);

@Component({ selector: 'mm-prev', template: `{{ count() }}|{{ label() }}` })
class Prev {
  readonly count = input(0);
  readonly label = input('');
}

describe('preview — bindings (#14)', () => {
  beforeEach(() => (renderFn = undefined));

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
