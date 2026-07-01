import {
  createComponent,
  type ApplicationRef,
  type Binding,
  type EnvironmentInjector,
  type TemplateRef,
  type Type,
} from '@angular/core';
import { pointerOutsideOfPreview } from '@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';

/** Where to anchor the preview relative to the pointer: a fixed `{x,y}` offset, or `'pointer-outside'` to sit just off the cursor. */
export type PreviewOffset = 'pointer-outside' | { x: number; y: number };

/** Render a component as the drag preview. */
type ComponentPreview = {
  /** The component to instantiate as the preview. */
  component: Type<unknown>;
  /**
   * Bindings forwarded to the preview component. Use `inputBinding`,
   * `outputBinding` and `twoWayBinding` from `@angular/core` — inputs stay
   * reactive (no manual re-render) and outputs / two-way work out of the box.
   */
  bindings?: Binding[];
  offset?: PreviewOffset;
};

/** Render a `TemplateRef` as the drag preview. */
type TemplatePreview<TCtx> = {
  /** The template to render; a getter defers resolution to preview-render time. */
  template:
    | TemplateRef<{ $implicit: TCtx }>
    | (() => TemplateRef<{ $implicit: TCtx }> | undefined | null);
  /**
   * Value passed to the template as `$implicit`. Plain values or a getter that
   * resolves at preview-render time.
   */
  context?: TCtx | (() => TCtx);
  offset?: PreviewOffset;
};

/** Render anything imperatively into the preview container. */
type RenderPreview = {
  /** Escape hatch — raw access to the container element. Return a cleanup. */
  render: (container: HTMLElement) => (() => void) | void;
  offset?: PreviewOffset;
};

/** A custom drag preview: a component, a template, or a raw render callback. */
export type PreviewConfig<TCtx = unknown> =
  | ComponentPreview
  | TemplatePreview<TCtx>
  | RenderPreview;

function resolveOffset(offset: PreviewOffset | undefined) {
  if (!offset) return undefined;
  if (offset === 'pointer-outside')
    return pointerOutsideOfPreview({ x: '8px', y: '8px' });

  return () => ({ x: offset.x, y: offset.y });
}

function resolveTemplate<T>(
  source: TemplatePreview<T>['template'],
): TemplateRef<{ $implicit: T }> | undefined {
  if (!source) return undefined;
  if (typeof source === 'function') return source() ?? undefined;
  return source;
}

function resolveContext<T>(
  source: TemplatePreview<T>['context'],
): T | undefined {
  if (source === undefined) return undefined;
  if (typeof source === 'function') return (source as () => T)();
  return source;
}

/**
 * @internal Render a {@link PreviewConfig} into a container (component / template
 * / raw), returning a cleanup. Engine-agnostic: native mode passes pragmatic's
 * container, pointer mode passes its own floating one.
 */
export function renderPreviewContent<TCtx>(
  config: PreviewConfig<TCtx>,
  container: HTMLElement,
  envInjector: EnvironmentInjector,
  appRef: ApplicationRef,
): (() => void) | void {
  if ('component' in config) {
    const ref = createComponent(config.component, {
      environmentInjector: envInjector,
      hostElement: container,
      bindings: config.bindings,
    });
    appRef.attachView(ref.hostView);
    return () => {
      appRef.detachView(ref.hostView);
      ref.destroy();
    };
  }
  if ('template' in config) {
    const tpl = resolveTemplate(config.template);
    if (!tpl) return;
    const ctx = resolveContext(config.context);
    const view = tpl.createEmbeddedView({ $implicit: ctx as TCtx });
    appRef.attachView(view);
    for (const node of view.rootNodes) container.appendChild(node);
    return () => {
      appRef.detachView(view);
      view.destroy();
    };
  }
  const cleanup = config.render(container);
  return cleanup ?? undefined;
}

/** @internal Wires a `PreviewConfig` into pragmatic's custom-preview hook (NATIVE engine). */
export function registerCustomPreview<TCtx>(
  config: PreviewConfig<TCtx>,
  envInjector: EnvironmentInjector,
  appRef: ApplicationRef,
  args: {
    nativeSetDragImage: ((image: Element, x: number, y: number) => void) | null;
  },
): void {
  if (!args.nativeSetDragImage) return;
  setCustomNativeDragPreview({
    nativeSetDragImage: args.nativeSetDragImage,
    getOffset: resolveOffset(config.offset),
    render: ({ container }) =>
      renderPreviewContent(config, container, envInjector, appRef),
  });
}

/** A live pointer-mode preview element following the pointer. */
export type PointerPreview = {
  /** Position the preview at the pointer (+ the config's offset). */
  move(x: number, y: number): void;
  /** Tear down the rendered content + remove the container. */
  destroy(): void;
};

/**
 * @internal The POINTER-engine counterpart to {@link registerCustomPreview}:
 * there is no native drag image, so we own a fixed, pointer-transparent container
 * that follows the pointer and render the same `PreviewConfig` into it.
 */
export function createPointerPreview<TCtx>(
  config: PreviewConfig<TCtx>,
  envInjector: EnvironmentInjector,
  appRef: ApplicationRef,
): PointerPreview {
  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed;top:0;left:0;pointer-events:none;z-index:10000;will-change:transform;';
  document.body.appendChild(container);
  const cleanup = renderPreviewContent(config, container, envInjector, appRef);
  const off =
    config.offset === 'pointer-outside'
      ? { x: 8, y: 8 }
      : (config.offset ?? { x: 0, y: 0 });
  return {
    move: (x, y) => {
      container.style.transform = `translate(${x + off.x}px, ${y + off.y}px)`;
    },
    destroy: () => {
      cleanup?.();
      container.remove();
    },
  };
}
