import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import type { Edge } from '@mmstack/dnd';
import { DropIndicator } from './drop-indicator';

@Component({
  selector: 'mm-indicator-host',
  imports: [DropIndicator],
  template: `<mm-drop-indicator [edge]="edge()" [indicated]="indicated()" />`,
})
class Host {
  readonly edge = signal<Edge | null>('top');
  readonly indicated = signal(true);
}

function render() {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture;
}

function line(fixture: ReturnType<typeof render>): HTMLElement | null {
  return fixture.nativeElement.querySelector('.line');
}

describe('DropIndicator (contained component)', () => {
  it('renders a line element only when an edge is active', () => {
    const fixture = render();
    expect(line(fixture)?.getAttribute('data-edge')).toBe('top');

    fixture.componentInstance.edge.set('bottom');
    fixture.detectChanges();
    expect(line(fixture)?.getAttribute('data-edge')).toBe('bottom');

    fixture.componentInstance.edge.set(null);
    fixture.detectChanges();
    expect(line(fixture)).toBeNull();
  });

  it('hides the line when not indicated', () => {
    const fixture = render();
    fixture.componentInstance.indicated.set(false);
    fixture.detectChanges();
    expect(line(fixture)).toBeNull();
  });

  it('injects NO global stylesheet (encapsulated styles)', () => {
    render();
    // the old implementation appended <style id="mm-drop-indicator-styles">
    expect(document.getElementById('mm-drop-indicator-styles')).toBeNull();
  });

  it('drives the edge from an edgeSource signal', () => {
    @Component({
      selector: 'mm-indicator-src-host',
      imports: [DropIndicator],
      template: `<mm-drop-indicator [edgeSource]="src" />`,
    })
    class SrcHost {
      readonly src = signal<Edge | null>('left');
    }
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(SrcHost);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement.querySelector('.line') as HTMLElement).getAttribute(
        'data-edge',
      ),
    ).toBe('left');

    fixture.componentInstance.src.set(null);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.line')).toBeNull();
  });
});
