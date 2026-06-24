/* eslint-disable @angular-eslint/component-selector   */
import { Component, computed, inject, PLATFORM_ID, signal } from '@angular/core';
import { render } from '@testing-library/angular';
import { MmActivity, PAUSED_CONTEXT } from './activity';

@Component({ selector: 'ab-ka-child', template: `{{ tmpl() }}|{{ vis() }}` })
class Child {
  static created = 0;
  static last: Child | null = null;

  readonly instance = ++Child.created;
  readonly src = signal(0);
  tmplRuns = 0;
  readonly tmpl = computed(() => {
    this.tmplRuns++;
    return this.src();
  });
  // What the directive provides to the kept subtree (PAUSED_CONTEXT: true while hidden).
  readonly paused = inject(PAUSED_CONTEXT);
  readonly vis = computed(() => (this.paused() ? 'off' : 'on'));

  constructor() {
    Child.last = this;
  }
}

@Component({
  selector: 'ab-ka-host',
  imports: [MmActivity, Child],
  template: `<ab-ka-child *mmActivity="show()" />`,
})
class Host {
  readonly show = signal(true);
}

const flush = async (detect: () => void) => {
  for (let i = 0; i < 5; i++) {
    detect();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
  }
  detect();
};

describe('MmActivity (keep-alive)', () => {
  beforeEach(() => {
    Child.created = 0;
    Child.last = null;
  });

  it('keeps the subtree mounted across hide/show (state preserved, not re-created)', async () => {
    const { fixture, container } = await render(Host);
    await flush(() => fixture.detectChanges());

    expect(Child.created).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const child = Child.last!;
    child.src.set(7);
    await flush(() => fixture.detectChanges());
    expect(container.textContent).toContain('7');

    // hide → kept, not destroyed
    fixture.componentInstance.show.set(false);
    await flush(() => fixture.detectChanges());
    expect(Child.created).toBe(1); // no new instance
    const host = container.querySelector('ab-ka-child') as HTMLElement | null;
    expect(host?.style.display).toBe('none'); // hidden, still in the DOM

    // show again → same instance, state intact (no refetch / reset)
    fixture.componentInstance.show.set(true);
    await flush(() => fixture.detectChanges());
    expect(Child.created).toBe(1);
    expect(Child.last).toBe(child);
    expect(container.textContent).toContain('7');
    expect(host?.style.display).toBe('');
  });

  it('pauses change detection while hidden (pull-based work suspends)', async () => {
    const { fixture } = await render(Host);
    await flush(() => fixture.detectChanges());
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const child = Child.last!;

    fixture.componentInstance.show.set(false);
    await flush(() => fixture.detectChanges());
    const runs0 = child.tmplRuns;

    // change a dependency of the kept-but-hidden subtree
    child.src.set(99);
    await flush(() => fixture.detectChanges());
    expect(child.tmplRuns).toBe(runs0); // template did not re-run while detached

    // reattach → resumes and picks up the change
    fixture.componentInstance.show.set(true);
    await flush(() => fixture.detectChanges());
    expect(child.tmplRuns).toBeGreaterThan(runs0);
  });

  it('on the server, renders hidden content without crashing or detaching/hiding it', async () => {
    const { fixture, container } = await render(Host, {
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    fixture.componentInstance.show.set(false);
    await flush(() => fixture.detectChanges());

    expect(Child.created).toBe(1);
    expect(container.textContent).toContain('0'); // content rendered, not detached
    const host = container.querySelector('ab-ka-child') as HTMLElement | null;
    expect(host?.style.display).toBe(''); // not hidden — SSR renders the full tree
  });

  it('provides PAUSED_CONTEXT to the content, tracking the visible input (inverted)', async () => {
    const { fixture, container } = await render(Host);
    await flush(() => fixture.detectChanges());
    expect(container.textContent).toContain('on');

    fixture.componentInstance.show.set(false);
    await flush(() => fixture.detectChanges());
    // CD is paused while hidden, so the rendered text is stale — read the signal directly.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(Child.last!.paused()).toBe(true);

    fixture.componentInstance.show.set(true);
    await flush(() => fixture.detectChanges());
    expect(container.textContent).toContain('on');
  });
});
