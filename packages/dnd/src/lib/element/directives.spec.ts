import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { draggable as PDDraggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { Draggable } from './draggable';
import { DropTarget } from './drop-target';
import { boxData } from '../internal/payload';
import { type HitboxPlugin } from '../provide';
import { DndSession, type DragSession, type DropTargetHit } from '../session';

type DraggableConfig = Parameters<typeof PDDraggable>[0];

const draggableMock = vi.fn();
const draggableCleanup = vi.fn();
const dropTargetMock = vi.fn();

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: (config: DraggableConfig) => {
    draggableMock(config);
    return draggableCleanup;
  },
  dropTargetForElements: (config: unknown) => {
    dropTargetMock(config);
    return () => undefined;
  },
  monitorForElements: vi.fn(() => () => undefined),
}));

type Card = { id: number };
const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in (d as object);

const stubHitbox: HitboxPlugin = {
  attachClosestEdge: (data) => ({ ...data, __edge: 'top' }),
  extractClosestEdge: () => 'top',
};

function makeSession(targets: DropTargetHit[], data: unknown): DragSession {
  return {
    sourceEl: document.createElement('div'),
    sourceData: boxData(data),
    targets,
    pointer: { x: 0, y: 0 },
    kind: 'transfer',
  };
}

beforeEach(() => {
  TestBed.resetTestingModule();
  draggableMock.mockReset();
  draggableCleanup.mockReset();
  dropTargetMock.mockReset();
});

@Component({
  selector: 'mm-drag-host',
  imports: [Draggable],
  template: `
    <span #a></span>
    <span #b></span>
    <div mmDraggable [data]="card" [dragHandle]="useB() ? b : a"></div>
  `,
})
class DragHost {
  readonly card: Card = { id: 1 };
  readonly useB = signal(false);
}

describe('Draggable directive', () => {
  it('registers via the render phase with the chosen handle', async () => {
    const fixture = TestBed.createComponent(DragHost);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(draggableMock).toHaveBeenCalledTimes(1);
    const spanA = fixture.nativeElement.querySelectorAll('span')[0];
    expect(draggableMock.mock.calls[0][0].dragHandle).toBe(spanA);
  });

  it('re-registers only when the handle element changes', async () => {
    const fixture = TestBed.createComponent(DragHost);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(draggableMock).toHaveBeenCalledTimes(1);

    fixture.componentInstance.useB.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(draggableMock).toHaveBeenCalledTimes(2);
    expect(draggableCleanup).toHaveBeenCalledTimes(1);
    const spanB = fixture.nativeElement.querySelectorAll('span')[1];
    expect(draggableMock.mock.calls[1][0].dragHandle).toBe(spanB);
  });

  it('cleans up the pragmatic registration on destroy', async () => {
    const fixture = TestBed.createComponent(DragHost);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(draggableCleanup).not.toHaveBeenCalled();
    fixture.destroy();
    expect(draggableCleanup).toHaveBeenCalledTimes(1);
  });
});

@Component({
  selector: 'mm-drop-host',
  imports: [DropTarget],
  template: `
    <div mmDropTarget [accepts]="isCard">
      <div mmDropTarget [accepts]="isCard"></div>
    </div>
  `,
})
class DropHost {
  readonly isCard = isCard;
}

describe('DropTarget directive — nested independence', () => {
  it('each nested target derives its own state from one session', () => {
    const fixture = TestBed.createComponent(DropHost);
    fixture.detectChanges();
    const session = TestBed.inject(DndSession).session;

    const des = fixture.debugElement.queryAll(By.directive(DropTarget));
    const [outerDe, innerDe] = des; // DOM order: outer first
    const outer = outerDe.injector.get(DropTarget);
    const inner = innerDe.injector.get(DropTarget);
    const outerEl = outerDe.nativeElement as HTMLElement;
    const innerEl = innerDe.nativeElement as HTMLElement;

    expect(inner.isDragOver()).toBe(false);
    expect(outer.isDragOver()).toBe(false);

    // innermost-first: [inner, outer]
    session.set(
      makeSession(
        [
          { element: innerEl, data: {} },
          { element: outerEl, data: {} },
        ],
        { id: 7 },
      ),
    );

    expect(inner.isDragOver()).toBe(true);
    expect(outer.isDragOver()).toBe(true);
    expect(inner.isInnermost()).toBe(true);
    expect(outer.isInnermost()).toBe(false);
    expect(inner.dragOverData()).toEqual({ id: 7 });

    session.set(null);
    expect(inner.isDragOver()).toBe(false);
    expect(outer.isDragOver()).toBe(false);
  });
});

@Component({
  selector: 'mm-drop-cfg-host',
  imports: [DropTarget],
  template: `
    <div
      mmDropTarget
      [accepts]="isCard"
      [edges]="['top']"
      [sticky]="true"
      dropEffect="copy"
      [hitbox]="hitbox"
    ></div>
  `,
})
class DropCfgHost {
  readonly isCard = isCard;
  readonly hitbox = stubHitbox;
}

describe('DropTarget directive — forwards sticky / dropEffect / hitbox (#13)', () => {
  it('forwards sticky → getIsSticky and dropEffect → getDropEffect', () => {
    const fixture = TestBed.createComponent(DropCfgHost);
    fixture.detectChanges();
    const cfg = dropTargetMock.mock.calls.at(-1)?.[0];
    expect(cfg.getIsSticky?.({})).toBe(true);
    expect(cfg.getDropEffect?.({})).toBe('copy');
  });

  it('derives closestEdge from the directive-provided hitbox', () => {
    const fixture = TestBed.createComponent(DropCfgHost);
    fixture.detectChanges();
    const de = fixture.debugElement.query(By.directive(DropTarget));
    const dt = de.injector.get(DropTarget);
    const el = de.nativeElement as HTMLElement;
    const session = TestBed.inject(DndSession).session;

    session.set(makeSession([{ element: el, data: { __edge: 'top' } }], { id: 1 }));
    expect(dt.closestEdge()).toBe('top');
  });
});
