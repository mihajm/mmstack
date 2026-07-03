import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TelemetryScope } from './scope.directive';

@Component({
  template: `<div mmTelemetryScope="page">
    <span mmTelemetryScope="btn"></span>
  </div>`,
  imports: [TelemetryScope],
})
class Host {}

@Component({
  template: `<div [mmTelemetryScope]="root()">
    <section mmTelemetryScope="list">
      <span mmTelemetryScope="item"></span>
    </section>
    <aside mmTelemetryScope="sidebar"></aside>
  </div>`,
  imports: [TelemetryScope],
})
class DeepHost {
  readonly root = signal('page-a');
}

function scopes(fixture: { debugElement: { queryAll(p: unknown): { injector: { get(t: typeof TelemetryScope): TelemetryScope } }[] } }) {
  return fixture.debugElement
    .queryAll(By.directive(TelemetryScope))
    .map((d) => d.injector.get(TelemetryScope));
}

describe('TelemetryScope', () => {
  it('builds an ancestor lineage path via hierarchical DI', () => {
    TestBed.configureTestingModule({ imports: [Host] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const dirs = scopes(fixture);
    const page = dirs.find((d) => d.name() === 'page')!;
    const btn = dirs.find((d) => d.name() === 'btn')!;

    expect(page.path()).toEqual(['page']);
    expect(btn.path()).toEqual(['page', 'btn']);
  });

  it('nests to arbitrary depth and isolates siblings', () => {
    TestBed.configureTestingModule({ imports: [DeepHost] });
    const fixture = TestBed.createComponent(DeepHost);
    fixture.detectChanges();

    const dirs = scopes(fixture);
    const item = dirs.find((d) => d.name() === 'item')!;
    const sidebar = dirs.find((d) => d.name() === 'sidebar')!;

    expect(item.path()).toEqual(['page-a', 'list', 'item']);
    expect(sidebar.path()).toEqual(['page-a', 'sidebar']); // sibling branch untouched by 'list'
  });

  it('recomputes descendant paths reactively when an ancestor name changes', () => {
    TestBed.configureTestingModule({ imports: [DeepHost] });
    const fixture = TestBed.createComponent(DeepHost);
    fixture.detectChanges();

    const item = scopes(fixture).find((d) => d.name() === 'item')!;
    expect(item.path()).toEqual(['page-a', 'list', 'item']);

    fixture.componentInstance.root.set('page-b');
    fixture.detectChanges();
    expect(item.path()).toEqual(['page-b', 'list', 'item']); // no snapshotting at construction
  });
});
