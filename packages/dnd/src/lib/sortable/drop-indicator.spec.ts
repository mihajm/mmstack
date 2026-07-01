import { TestBed } from '@angular/core/testing';

import type { Edge } from '../internal/types';
import { DropIndicator } from './drop-indicator';

type Inputs = {
  edge: Edge | null;
  indicated: boolean;
  thickness: number;
  gap: number;
};

function setup(inputs: Partial<Inputs> = {}) {
  const fixture = TestBed.createComponent(DropIndicator);
  for (const [k, v] of Object.entries(inputs))
    fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  return fixture;
}

const line = (f: ReturnType<typeof setup>): HTMLElement | null =>
  f.nativeElement.querySelector('.line');
const cssVar = (f: ReturnType<typeof setup>, name: string): string =>
  (f.nativeElement as HTMLElement).style.getPropertyValue(name);

describe('DropIndicator', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders a line on the given edge', () => {
    const f = setup({ edge: 'top' });
    expect(line(f)).not.toBeNull();
    expect(line(f)?.getAttribute('data-edge')).toBe('top');
  });

  it('renders no line when the edge is null', () => {
    expect(line(setup({ edge: null }))).toBeNull();
  });

  it('tracks the edge reactively (top → bottom → null)', () => {
    const f = setup({ edge: 'top' });
    expect(line(f)?.getAttribute('data-edge')).toBe('top');

    f.componentRef.setInput('edge', 'bottom');
    f.detectChanges();
    expect(line(f)?.getAttribute('data-edge')).toBe('bottom');

    f.componentRef.setInput('edge', null);
    f.detectChanges();
    expect(line(f)).toBeNull();
  });

  it('indicated=false hides the line even with an edge', () => {
    expect(line(setup({ edge: 'top', indicated: false }))).toBeNull();
  });

  it('supports horizontal edges', () => {
    expect(line(setup({ edge: 'left' }))?.getAttribute('data-edge')).toBe('left');
    expect(line(setup({ edge: 'right' }))?.getAttribute('data-edge')).toBe(
      'right',
    );
  });

  it('offset = -floor(thickness/2) - gap; thickness var reflects the input', () => {
    const f = setup({ edge: 'top', thickness: 4, gap: 6 });
    expect(cssVar(f, '--mm-dnd-offset')).toBe('-8px'); // -2 - 6
    expect(cssVar(f, '--mm-dnd-thickness')).toBe('4px');
  });

  it('non-happy: thickness 0 / gap 0 → offset 0px (no NaN, no throw)', () => {
    const f = setup({ edge: 'top', thickness: 0, gap: 0 });
    expect(cssVar(f, '--mm-dnd-offset')).toBe('0px');
    expect(cssVar(f, '--mm-dnd-thickness')).toBe('0px');
  });

  it('non-happy: odd thickness floors the half-offset', () => {
    const f = setup({ edge: 'top', thickness: 3, gap: 0 });
    expect(cssVar(f, '--mm-dnd-offset')).toBe('-1px'); // -floor(3/2)
  });
});
