import { Component, ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { boxDragData } from './internal';
import { dropTarget, DropTarget } from './drop-target';

type CapturedArgs = Parameters<typeof dropTargetForElements>[0];

const dropTargetMock = vi.fn();
const cleanupMock = vi.fn();

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: vi.fn(() => () => undefined),
  dropTargetForElements: (args: CapturedArgs) => {
    dropTargetMock(args);
    return cleanupMock;
  },
  monitorForElements: vi.fn(() => () => undefined),
}));

const EDGE_KEY = Symbol.for('closestEdge');
vi.mock('@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge', () => ({
  attachClosestEdge: (data: Record<string | symbol, unknown>) => ({
    ...data,
    [EDGE_KEY]: 'top',
  }),
  extractClosestEdge: (data: Record<string | symbol, unknown>) =>
    (data[EDGE_KEY] as string | undefined) ?? null,
}));

type Card = { id: string };
const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in d;

function createHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function lastArgs(): CapturedArgs {
  return dropTargetMock.mock.calls.at(-1)?.[0] as CapturedArgs;
}

describe('dropTarget', () => {
  beforeEach(() => {
    dropTargetMock.mockReset();
    cleanupMock.mockReset();
  });

  it('canDrop returns false when accepts typeguard fails', () => {
    const element = createHost();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    TestBed.runInInjectionContext(() => {
      dropTarget<Card>({ accepts: isCard });
      TestBed.tick();
    });

    const args = lastArgs();
    const ok = args.canDrop?.({
      input: {} as never,
      source: { element, dragHandle: null, data: boxDragData('not-a-card') },
      element,
    });
    expect(ok).toBe(false);
  });

  it('canDrop returns true when typeguard passes', () => {
    const element = createHost();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    TestBed.runInInjectionContext(() => {
      dropTarget<Card>({ accepts: isCard });
      TestBed.tick();
    });
    const args = lastArgs();
    const ok = args.canDrop?.({
      input: {} as never,
      source: { element, dragHandle: null, data: boxDragData({ id: 'a' }) },
      element,
    });
    expect(ok).toBe(true);
  });

  it('passes accepted data to consumer canDrop', () => {
    const consumer = vi.fn(() => true);
    const element = createHost();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    TestBed.runInInjectionContext(() => {
      dropTarget<Card>({ accepts: isCard, canDrop: consumer });
      TestBed.tick();
    });
    lastArgs().canDrop?.({
      input: {} as never,
      source: { element, dragHandle: null, data: boxDragData({ id: 'b' }) },
      element,
    });
    expect(consumer).toHaveBeenCalledWith({ source: { data: { id: 'b' }, meta: {} } });
  });

  it('updates isDragOver and dragOverData on dragEnter / dragLeave', () => {
    const element = createHost();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    const ref = TestBed.runInInjectionContext(() => {
      const r = dropTarget<Card>({ accepts: isCard });
      TestBed.tick();
      return r;
    });
    const args = lastArgs();

    const selfRec = { element, data: {}, dropEffect: 'move' as const, isActiveDueToStickiness: false };
    args.onDragEnter?.({
      source: { element, dragHandle: null, data: boxDragData({ id: 'q' }) },
      self: selfRec,
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [selfRec] },
        previous: { dropTargets: [] },
      },
    });
    expect(ref.isDragOver()).toBe(true);
    expect(ref.dragOverData()).toEqual({ id: 'q' });

    args.onDragLeave?.({
      source: { element, dragHandle: null, data: boxDragData({ id: 'q' }) },
      self: selfRec,
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [selfRec] },
      },
    });
    expect(ref.isDragOver()).toBe(false);
    expect(ref.dragOverData()).toBeUndefined();
  });

  it('re-registers when disabled toggles', () => {
    const element = createHost();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    const disabled = signal(false);
    TestBed.runInInjectionContext(() => {
      dropTarget<Card>({ accepts: isCard, disabled });
      TestBed.tick();
    });
    expect(dropTargetMock).toHaveBeenCalledTimes(1);

    disabled.set(true);
    TestBed.tick();
    expect(cleanupMock).toHaveBeenCalled();

    disabled.set(false);
    TestBed.tick();
    expect(dropTargetMock).toHaveBeenCalledTimes(2);
  });

  it('attaches closestEdge to self data when edges set, surfacing it via signal', () => {
    const element = createHost();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(element) }],
    });
    const ref = TestBed.runInInjectionContext(() => {
      const r = dropTarget<Card>({ accepts: isCard, edges: ['top', 'bottom'] });
      TestBed.tick();
      return r;
    });
    const args = lastArgs();
    const enrichedSelf = args.getData?.({
      input: {} as never,
      element,
      source: { element, dragHandle: null, data: boxDragData({ id: 'e' }) },
    });
    if (!enrichedSelf) throw new Error('expected getData to return enriched self data');

    args.onDrag?.({
      source: { element, dragHandle: null, data: boxDragData({ id: 'e' }) },
      self: { element, data: enrichedSelf, dropEffect: 'move', isActiveDueToStickiness: false },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    expect(ref.closestEdge()).toBe('top');
  });

  it('returns inert signals on the server platform', () => {
    const element = createHost();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(element) },
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    TestBed.runInInjectionContext(() => {
      const ref = dropTarget<Card>({ accepts: isCard });
      expect(ref.isDragOver()).toBe(false);
      expect(ref.dragOverData()).toBeUndefined();
      expect(ref.closestEdge()).toBeNull();
    });
    expect(dropTargetMock).not.toHaveBeenCalled();
  });
});

@Component({
  selector: 'mm-target-host',
  imports: [DropTarget],
  template: `
    <div mmDropTarget
         [accepts]="isCard"
         [edges]="['top', 'bottom']"
         [indicated]="indicated">x</div>
  `,
})
class TargetHost {
  readonly isCard = isCard;
  indicated = false;
}

describe('DropTarget host indicator bridge', () => {
  beforeEach(() => {
    dropTargetMock.mockReset();
    cleanupMock.mockReset();
  });

  it('enables the indicator host attribute when indicated is true and closestEdge updates', () => {
    const fixture = TestBed.createComponent(TargetHost);
    fixture.componentInstance.indicated = true;
    fixture.detectChanges();

    const args = lastArgs();
    const host = fixture.nativeElement.querySelector('[mmDropTarget]') as HTMLElement;

    // simulate a hovered edge from pragmatic-dnd
    const enrichedSelf = args.getData?.({
      input: {} as never,
      element: host,
      source: { element: host, dragHandle: null, data: boxDragData({ id: 'a' }) },
    });
    if (!enrichedSelf) throw new Error('getData returned undefined');
    args.onDrag?.({
      source: { element: host, dragHandle: null, data: boxDragData({ id: 'a' }) },
      self: {
        element: host,
        data: enrichedSelf,
        dropEffect: 'move',
        isActiveDueToStickiness: false,
      },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    fixture.detectChanges();

    expect(host.getAttribute('data-mm-drop-indicator-edge')).toBe('top');
  });

  it('does not enable the indicator when indicated is false', () => {
    const fixture = TestBed.createComponent(TargetHost);
    fixture.detectChanges();

    const args = lastArgs();
    const host = fixture.nativeElement.querySelector('[mmDropTarget]') as HTMLElement;

    const enrichedSelf = args.getData?.({
      input: {} as never,
      element: host,
      source: { element: host, dragHandle: null, data: boxDragData({ id: 'a' }) },
    });
    if (!enrichedSelf) throw new Error('getData returned undefined');
    args.onDrag?.({
      source: { element: host, dragHandle: null, data: boxDragData({ id: 'a' }) },
      self: {
        element: host,
        data: enrichedSelf,
        dropEffect: 'move',
        isActiveDueToStickiness: false,
      },
      location: {
        initial: {} as never,
        current: { input: {} as never, dropTargets: [] },
        previous: { dropTargets: [] },
      },
    });
    fixture.detectChanges();

    expect(host.hasAttribute('data-mm-drop-indicator-edge')).toBe(false);
  });
});
