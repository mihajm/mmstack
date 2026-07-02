import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MmViewTransitionName } from './view-transition-name';

describe('MmViewTransitionName', () => {
  @Component({
    imports: [MmViewTransitionName],
    template: `<div [mmViewTransitionName]="name()"></div>`,
  })
  class Host {
    readonly name = signal('hero-1');
  }

  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector('div') as HTMLElement;
    const read = () => el.style.getPropertyValue('view-transition-name');
    return { fixture, read, name: fixture.componentInstance.name };
  }

  it('assigns the name and tracks changes reactively (per-item morphs)', () => {
    const { fixture, read, name } = setup();
    expect(read()).toBe('hero-1');

    name.set('hero-2');
    fixture.detectChanges();
    expect(read()).toBe('hero-2');
  });

  it('normalizes to a valid custom-ident (invalid chars, leading digit)', () => {
    const { fixture, read, name } = setup();
    name.set('user avatar #7');
    fixture.detectChanges();
    expect(read()).toBe('user-avatar--7');

    name.set('42-hero');
    fixture.detectChanges();
    expect(read()).toBe('_42-hero'); // idents can't start with a digit
  });

  it("'' and 'none' clear the name — the conditional opt-out", () => {
    const { fixture, read, name } = setup();
    expect(read()).toBe('hero-1');

    name.set('');
    fixture.detectChanges();
    expect(read()).toBe('');

    name.set('none');
    fixture.detectChanges();
    expect(read()).toBe('');
  });
});
