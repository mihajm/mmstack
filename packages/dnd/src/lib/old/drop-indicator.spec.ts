import { Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { DropIndicator, DropIndicatorComponent } from './drop-indicator';
import type { Edge } from './types';

@Component({
  selector: 'mm-host-directive',
  imports: [DropIndicator],
  template: `<div mmDropIndicator [edge]="edge" [disabled]="disabled" [thickness]="thickness"></div>`,
})
class DirectiveHost {
  edge: Edge | null = null;
  disabled = false;
  thickness = 2;
}

@Component({
  selector: 'mm-host-component',
  imports: [DropIndicatorComponent],
  template: `<mm-drop-indicator [edge]="edge" [disabled]="disabled" />`,
})
class ComponentHost {
  edge: Edge | null = null;
  disabled = false;
}

function getHostDiv(fixture: ComponentFixture<DirectiveHost>): HTMLElement {
  return fixture.nativeElement.querySelector('[mmDropIndicator]') as HTMLElement;
}

describe('DropIndicator directive', () => {
  beforeEach(() => {
    document.getElementById('mm-drop-indicator-styles')?.remove();
  });

  it('injects the indicator stylesheet on first use', () => {
    expect(document.getElementById('mm-drop-indicator-styles')).toBeNull();
    const fixture = TestBed.createComponent(DirectiveHost);
    fixture.detectChanges();
    const style = document.getElementById('mm-drop-indicator-styles');
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain('[data-mm-drop-indicator-edge="top"]::before');
  });

  it('does not duplicate the stylesheet across instances', () => {
    TestBed.createComponent(DirectiveHost).detectChanges();
    TestBed.createComponent(DirectiveHost).detectChanges();
    const styles = document.querySelectorAll('#mm-drop-indicator-styles');
    expect(styles.length).toBe(1);
  });

  it('sets the edge data attribute from the edge input', () => {
    const fixture = TestBed.createComponent(DirectiveHost);
    fixture.componentInstance.edge = 'top';
    fixture.detectChanges();
    expect(getHostDiv(fixture).getAttribute('data-mm-drop-indicator-edge')).toBe('top');
  });

  it('omits the edge data attribute when edge is null', () => {
    const fixture = TestBed.createComponent(DirectiveHost);
    fixture.detectChanges();
    expect(getHostDiv(fixture).hasAttribute('data-mm-drop-indicator-edge')).toBe(false);
  });

  it('omits the edge data attribute when disabled', () => {
    const fixture = TestBed.createComponent(DirectiveHost);
    fixture.componentInstance.edge = 'bottom';
    fixture.componentInstance.disabled = true;
    fixture.detectChanges();
    expect(getHostDiv(fixture).hasAttribute('data-mm-drop-indicator-edge')).toBe(false);
  });

  it('writes thickness and offset custom properties', () => {
    const fixture = TestBed.createComponent(DirectiveHost);
    fixture.componentInstance.edge = 'top';
    fixture.componentInstance.thickness = 6;
    fixture.detectChanges();
    const host = getHostDiv(fixture);
    expect(host.style.getPropertyValue('--mm-drop-indicator-thickness')).toBe('6px');
    expect(host.style.getPropertyValue('--mm-drop-indicator-offset')).toBe('-3px');
  });
});

describe('DropIndicatorComponent', () => {
  it('forwards edge into the underlying directive (host attribute)', () => {
    const fixture = TestBed.createComponent(ComponentHost);
    fixture.componentInstance.edge = 'left';
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('mm-drop-indicator') as HTMLElement;
    expect(host.getAttribute('data-mm-drop-indicator-edge')).toBe('left');
  });
});
