import {
  createComponent,
  isSignal,
  type ApplicationRef,
  type EnvironmentInjector,
  type TemplateRef,
  type Type,
} from '@angular/core';
import { pointerOutsideOfPreview } from '@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';

export type PreviewOffset = 'pointer-outside' | { x: number; y: number };

type ComponentPreview = {
  component: Type<unknown>;
  /**
   * Component inputs. Plain values are forwarded as-is; signals (`signal()`,
   * `computed()`, `input()`) are read at preview-render time so the preview
   * captures their current value.
   */
  inputs?: Record<string, unknown>;
  offset?: PreviewOffset;
};

type TemplatePreview<TCtx> = {
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

type RenderPreview = {
  /** Escape hatch — raw access to the container element. Return a cleanup. */
  render: (container: HTMLElement) => (() => void) | void;
  offset?: PreviewOffset;
};

export type PreviewConfig<TCtx = unknown> =
  | ComponentPreview
  | TemplatePreview<TCtx>
  | RenderPreview;

function resolveOffset(offset: PreviewOffset | undefined) {
  if (!offset) return undefined;
  if (offset === 'pointer-outside') {
    return pointerOutsideOfPreview({ x: '8px', y: '8px' });
  }
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

function resolveInput(value: unknown): unknown {
  if (isSignal(value)) return (value as () => unknown)();
  return value;
}

export function registerCustomPreview<TCtx>(
  config: PreviewConfig<TCtx>,
  envInjector: EnvironmentInjector,
  appRef: ApplicationRef,
  args: {
    nativeSetDragImage:
      | ((image: Element, x: number, y: number) => void)
      | null;
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
        });
        if (config.inputs) {
          for (const [k, v] of Object.entries(config.inputs)) {
            ref.setInput(k, resolveInput(v));
          }
        }
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
