import { isPlatformServer } from '@angular/common';
import {
  booleanAttribute,
  computed,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  PLATFORM_ID,
  runInInjectionContext,
  untracked,
  type Signal,
} from '@angular/core';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { deriveHit } from '../internal/hit';
import {
  boxData,
  extractDragMeta,
  mapDropTargets,
  unboxData,
} from '../internal/payload';
import { resolveSignal } from '../internal/resolve';
import type {
  DragMeta,
  DropEvent,
  DropTargetEvent,
  DropTargetInfo,
  Edge,
  Resolvable,
} from '../internal/types';
import {
  missingPluginError,
  resolveHitbox,
  type HitboxPlugin,
} from '../provide';
import { DndSession } from '../session';

export type CreateDropTargetOptions<
  TAccept,
  TSelf = void,
  TMeta extends DragMeta = DragMeta,
> = {
  /** Pure type guard on the dragged payload (read untracked — use `canDrop`/`disabled` for reactive gating). */
  accepts: (data: unknown) => data is TAccept;
  /** This target's own data, surfaced on events as `self.data` (value, signal, or getter). */
  data?: Resolvable<TSelf>;
  /** Reactive gate evaluated at drag time; return `false` to reject an otherwise-accepted source. */
  canDrop?: (args: { source: { data: TAccept; meta: TMeta } }) => boolean;
  /** Disable this target (clears hover/edge when flipped mid-hover). */
  disabled?: Resolvable<boolean>;
  /** Edges to detect for `closestEdge` (needs the hitbox plugin); omit for whole-element drops. */
  edges?: Resolvable<Edge[] | undefined>;
  /** Stay the active drop target after the pointer leaves (pragmatic stickiness). */
  sticky?: Resolvable<boolean>;
  /** Native drop effect / cursor hint. @default 'move' */
  dropEffect?: Resolvable<'copy' | 'link' | 'move'>;
  /** Override the registered hitbox plugin (needed for `edges`/`closestEdge`). */
  hitbox?: HitboxPlugin | (() => HitboxPlugin | undefined | null);
  /** Injector to run in; defaults to the current injection context. */
  injector?: Injector;
  /** Fires when an accepted source enters this target. */
  onDragEnter?: (event: DropTargetEvent<TAccept, TSelf, TMeta>) => void;
  /** Fires when an accepted source leaves this target. */
  onDragLeave?: (event: DropTargetEvent<TAccept, TSelf, TMeta>) => void;
  /** Fires when an accepted source is dropped on this target. */
  onDrop?: (event: DropEvent<TAccept, TMeta>) => void;
};

export type DropTargetRef<TAccept> = {
  /** True while any accepted source is over this target (at any nesting depth). */
  isDragOver: Signal<boolean>;
  /** True only when this is the innermost (deepest) target under the pointer. */
  isInnermost: Signal<boolean>;
  /** The accepted source's payload while hovering, else `undefined`. */
  dragOverData: Signal<TAccept | undefined>;
  /** The closest edge while hovering (needs `edges` + the hitbox plugin), else `null`. */
  closestEdge: Signal<Edge | null>;
};

const NOOP: DropTargetRef<never> = {
  isDragOver: computed(() => false),
  isInnermost: computed(() => false),
  dragOverData: computed(() => undefined),
  closestEdge: computed(() => null),
};

/**
 * Makes the host element a drop target. `accepts` narrows the payload type;
 * `isDragOver`/`isInnermost`/`dragOverData`/`closestEdge` are all *derived* from
 * the ambient session. `edges`/`closestEdge` need the hitbox plugin.
 *
 * @example
 * ```ts
 * type Card = { id: string };
 * const isCard = (d: unknown): d is Card =>
 *   !!d && typeof d === 'object' && 'id' in d;
 *
 * protected readonly zone = dropTarget<Card>({
 *   accepts: isCard,
 *   edges: ['top', 'bottom'],                 // needs the hitbox plugin
 *   onDrop: ({ data, edge }) => this.insert(data, edge),
 * });
 * // zone.isDragOver() · zone.isInnermost() · zone.dragOverData() · zone.closestEdge()
 * ```
 */
export function dropTarget<
  TAccept,
  TSelf = void,
  TMeta extends DragMeta = DragMeta,
>(
  opts: CreateDropTargetOptions<TAccept, TSelf, TMeta>,
): DropTargetRef<TAccept> {
  const injector = opts.injector ?? inject(Injector);
  return runInInjectionContext(injector, () => {
    if (isPlatformServer(inject(PLATFORM_ID))) {
      return NOOP as DropTargetRef<TAccept>;
    }

    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const session = inject(DndSession);
    const diHitbox = resolveHitbox();
    const getHitbox = (): HitboxPlugin | null =>
      (typeof opts.hitbox === 'function' ? opts.hitbox() : opts.hitbox) ??
      diHitbox;

    const selfData = opts.data ? resolveSignal(opts.data) : undefined;
    const disabled = opts.disabled ? resolveSignal(opts.disabled) : undefined;
    const edgesSig = opts.edges ? resolveSignal(opts.edges) : undefined;
    const sticky = opts.sticky ? resolveSignal(opts.sticky) : undefined;
    const dropEffect = opts.dropEffect
      ? resolveSignal(opts.dropEffect)
      : undefined;

    const readEdges = (): Edge[] | undefined =>
      edgesSig ? untracked(edgesSig) : undefined;

    if (readEdges()?.length && !getHitbox()) {
      throw missingPluginError(
        'hitbox',
        '@atlaskit/pragmatic-drag-and-drop-hitbox',
      );
    }

    const accept = (
      data: Record<string | symbol, unknown>,
    ): { data: TAccept; meta: TMeta } | null => {
      const unboxed = unboxData<unknown>(data);
      if (!untracked(() => opts.accepts(unboxed))) return null;
      return { data: unboxed as TAccept, meta: extractDragMeta<TMeta>(data) };
    };

    const selfInfo = (record: {
      element: Element;
      data: Record<string | symbol, unknown>;
    }): DropTargetInfo<TSelf> => ({
      element: record.element,
      data: (selfData ? untracked(selfData) : undefined) as TSelf,
    });

    const hitIndex = computed(() => {
      if (disabled?.()) return -1;
      return session.targetEls().indexOf(element);
    });

    const { isDragOver, isInnermost } = deriveHit(hitIndex);

    const dragOverData = computed<TAccept | undefined>(() => {
      if (hitIndex() < 0) return undefined;
      const src = session.source();
      return src ? accept(src.data)?.data : undefined;
    });

    const closestEdge = computed<Edge | null>(() => {
      const hb = untracked(getHitbox);
      if (!hb) return null;
      const i = hitIndex();
      if (i < 0) return null;
      return hb.extractClosestEdge(session.targets()[i].data);
    });

    const cleanup = dropTargetForElements({
      element,
      getIsSticky: sticky ? () => untracked(sticky) : undefined,
      getDropEffect: dropEffect ? () => untracked(dropEffect) : undefined,
      getData: ({ input, element: el }) => {
        const base = selfData
          ? boxData(untracked(selfData))
          : ({} as Record<string | symbol, unknown>);
        const edges = readEdges();
        if (edges?.length) {
          const hb = getHitbox();
          if (!hb)
            throw missingPluginError(
              'hitbox',
              '@atlaskit/pragmatic-drag-and-drop-hitbox',
            );

          return hb.attachClosestEdge(base, {
            element: el,
            input,
            allowedEdges: edges,
          });
        }
        return base;
      },
      canDrop: ({ source }) => {
        if (disabled && untracked(disabled)) return false;
        const accepted = accept(source.data);
        if (accepted === null) return false;
        return opts.canDrop?.({ source: accepted }) ?? true;
      },
      onDragEnter: ({ source, self }) => {
        const accepted = accept(source.data);
        if (accepted === null) return;
        opts.onDragEnter?.({ source: accepted, self: selfInfo(self) });
      },
      onDragLeave: ({ source, self }) => {
        const accepted = accept(source.data);
        if (accepted === null) return;
        opts.onDragLeave?.({ source: accepted, self: selfInfo(self) });
      },
      onDrop: ({ source, self, location }) => {
        const accepted = accept(source.data);
        if (accepted === null) return;
        const hb = getHitbox();
        const edge =
          hb && readEdges()?.length ? hb.extractClosestEdge(self.data) : null;
        opts.onDrop?.({
          data: accepted.data,
          meta: accepted.meta,
          edge,
          location: {
            current: mapDropTargets(location.current.dropTargets),
            previous: mapDropTargets(location.previous.dropTargets),
          },
        });
      },
    });
    inject(DestroyRef).onDestroy(cleanup);

    return { isDragOver, isInnermost, dragOverData, closestEdge };
  });
}

/** Directive form of {@link dropTarget}: `<div mmDropTarget [accepts]="isCard" (dropped)="…">`. */
@Directive({
  selector: '[mmDropTarget]',
  exportAs: 'mmDropTarget',
})
export class DropTarget<
  TAccept = unknown,
  TSelf = void,
  TMeta extends DragMeta = DragMeta,
> {
  /** Type guard narrowing which payloads this target accepts. */
  readonly accepts = input.required<(data: unknown) => data is TAccept>();
  /** This target's own data, surfaced on events as `self.data`. */
  readonly data = input<TSelf | undefined>(undefined);
  /** Reactive gate; return `false` to reject an otherwise-accepted source. */
  readonly canDrop = input<
    ((args: { source: { data: TAccept; meta: TMeta } }) => boolean) | undefined
  >(undefined);
  /** Disable this target (attribute-coerced). */
  readonly dropDisabled = input(false, { transform: booleanAttribute });
  /** Edges to detect for `closestEdge` (needs the hitbox plugin). */
  readonly edges = input<Edge[] | undefined>(undefined);
  /** Stay the active target after the pointer leaves (attribute-coerced). */
  readonly sticky = input(false, { transform: booleanAttribute });
  /** Native drop effect / cursor hint. */
  readonly dropEffect = input<'copy' | 'link' | 'move'>('move');
  /** Override the registered hitbox plugin. */
  readonly hitbox = input<HitboxPlugin | undefined>(undefined);

  /** Emits when an accepted source enters this target. */
  readonly dragEnter = output<DropTargetEvent<TAccept, TSelf, TMeta>>();
  /** Emits when an accepted source leaves this target. */
  readonly dragLeave = output<DropTargetEvent<TAccept, TSelf, TMeta>>();
  /** Emits when an accepted source is dropped on this target. */
  readonly dropped = output<DropEvent<TAccept, TMeta>>();

  private readonly ref = dropTarget<TAccept, TSelf, TMeta>({
    accepts: (d): d is TAccept => this.accepts()(d),
    data: () => this.data() as TSelf,
    canDrop: (args) => this.canDrop()?.(args) ?? true,
    disabled: this.dropDisabled,
    edges: this.edges,
    sticky: this.sticky,
    dropEffect: this.dropEffect,
    hitbox: () => this.hitbox(),
    onDragEnter: (e) => this.dragEnter.emit(e),
    onDragLeave: (e) => this.dragLeave.emit(e),
    onDrop: (e) => this.dropped.emit(e),
  });

  /** True while any accepted source is over this target. */
  readonly isDragOver = this.ref.isDragOver;
  /** True only when this is the innermost target under the pointer. */
  readonly isInnermost = this.ref.isInnermost;
  /** The accepted source's payload while hovering, else `undefined`. */
  readonly dragOverData = this.ref.dragOverData;
  /** The closest edge while hovering, else `null`. */
  readonly closestEdge = this.ref.closestEdge;
}
