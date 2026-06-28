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

/** @internal Wires a `PreviewConfig` into pragmatic's custom-preview hook; driven by `draggable`'s `preview` option. */
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
    render: ({ container }) => {
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
    },
  });
}
