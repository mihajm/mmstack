/* eslint-disable @angular-eslint/component-selector */

import {
  ChangeDetectorRef,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { render } from '@testing-library/angular';

// PROBE (zoneless): does detaching a view's ChangeDetectorRef pause the work inside it?
// Counts re-runs of a template-read computed and a component effect after the view is
// detached and a dependency changes. Determines the real suspension contract for Activity.

@Component({ selector: 'probe-child', template: `{{ tmpl() }}` })
class Child {
  readonly cdr = inject(ChangeDetectorRef);
  readonly src = signal(0);
  tmplRuns = 0;
  effectRuns = 0;
  readonly tmpl = computed(() => {
    this.tmplRuns++;
    return this.src();
  });
  constructor() {
    effect(() => {
      this.src(); // track
      this.effectRuns++;
    });
  }
}

@Component({
  selector: 'probe-parent',
  imports: [Child],
  template: `{{ other() }}<probe-child />`,
})
class Parent {
  readonly child = viewChild.required(Child);
  readonly other = signal(0);
}

describe('CD-detach suspension probe (zoneless)', () => {
  it('detaching a view CD: does its template computed / effect keep running on a signal change?', async () => {
    const { fixture, container } = await render(Parent);
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        fixture.detectChanges();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r));
      }
      fixture.detectChanges();
    };
    await flush();

    const child = fixture.componentInstance.child();
    expect(container.textContent).toContain('0');

    const tmpl0 = child.tmplRuns;
    const eff0 = child.effectRuns;

    // detach this view's CD, then change a dependency
    child.cdr.detach();
    child.src.set(1);
    await flush();

    const tmplDelta = child.tmplRuns - tmpl0;
    const effDelta = child.effectRuns - eff0;

    // VERIFIED behavior (zoneless, Angular 21): detach pauses PULL-based work (the template and
    // the computeds it reads → tmplDelta 0, DOM stale) but NOT PUSH-scheduled work (the effect
    // still flushes → effDelta 1). The Activity suspension contract therefore must explicitly
    // gate effect-driven work (the RxJS `refresh` interval + connector request fns), not rely on
    // detach to pause it. Pure-display computeds suspend for free.
    expect({
      tmplDelta,
      effDelta,
      domStale: container.textContent?.includes('0') && !container.textContent?.includes('1'),
    }).toEqual({ tmplDelta: 0, effDelta: 1, domStale: true });
  });

  it('a detached view effect is DEPENDENCY-driven: an unrelated global tick does NOT run it', async () => {
    const { fixture } = await render(Parent);
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        fixture.detectChanges();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r));
      }
      fixture.detectChanges();
    };
    await flush();
    const child = fixture.componentInstance.child();

    child.cdr.detach();
    const eff0 = child.effectRuns;

    // change an UNRELATED signal (parent's) → triggers an app-wide CD tick, but the child
    // effect's own dependency (child.src) did not change.
    fixture.componentInstance.other.set(1);
    await flush();

    // The detached view's effect stays dormant — a global tick does NOT wake it; only a write
    // to a signal IT reads would. So a hidden subtree is quiescent w.r.t. unrelated app activity.
    expect(child.effectRuns - eff0).toBe(0);
  });

  it('after reattach + signal change, work resumes', async () => {
    const { fixture, container } = await render(Parent);
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        fixture.detectChanges();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r));
      }
      fixture.detectChanges();
    };
    await flush();
    const child = fixture.componentInstance.child();

    child.cdr.detach();
    child.src.set(1);
    await flush();

    child.cdr.reattach();
    child.src.set(2);
    await flush();

    expect(container.textContent).toContain('2'); // resumed
  });
});
