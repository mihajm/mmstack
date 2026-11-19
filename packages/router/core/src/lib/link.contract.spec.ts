import { provideLocationMocks } from '@angular/common/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterLinkActive } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { injectTriggerPreload, Link, provideMMLinkDefaultConfig } from './link';
import { PreloadRequester } from './preloading';

@Component({ selector: 'mm-blank', template: `` })
class Blank {}

@Component({
  selector: 'mm-contract-link-host',
  imports: [Link, RouterLinkActive],
  template: `<a
      class="l"
      [mmLink]="link()"
      [preloadOn]="preloadOn()"
      [useMouseDown]="useMouseDown()"
      [beforeNavigate]="beforeNavigate()"
      [target]="target()"
      [queryParamsHandling]="handling()"
      routerLinkActive="on"
      (preloading)="preloads = preloads + 1"
      >go</a
    ><map
      ><area class="area" [mmLink]="link()" [beforeNavigate]="beforeNavigate()"
    /></map>`,
})
class Host {
  readonly link = signal<string | null>('/x');
  readonly preloadOn = signal<'hover' | 'visible' | null>('hover');
  readonly useMouseDown = signal(false);
  readonly beforeNavigate = signal<(() => void) | undefined>(undefined);
  readonly target = signal<string | undefined>(undefined);
  readonly handling = signal<'merge' | 'preserve' | '' | undefined>(undefined);
  preloads = 0;
}

@Component({
  selector: 'mm-default-link-host',
  imports: [Link],
  template: `<a class="d" mmLink="/x">d</a>`,
})
class DefaultHost {}

@Component({
  selector: 'mm-button-link-host',
  imports: [Link],
  template: `<button class="b" mmLink="/x" [beforeNavigate]="bn">b</button>`,
})
class ButtonHost {
  readonly bn = vi.fn();
}

@Component({
  selector: 'mm-self-page',
  imports: [Link],
  template: `<a class="self" mmLink="#install">self</a
    ><a class="rel" mmLink="child">rel</a>`,
})
class SelfPage {}

let startPreload: ReturnType<typeof vi.fn>;

function configure(providers: unknown[] = []) {
  startPreload = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'docs/page', component: SelfPage },
        { path: '**', component: Blank },
      ]),
      provideLocationMocks(),
      { provide: PreloadRequester, useValue: { startPreload } },
      ...(providers as never[]),
    ],
  });
}

function mount<T>(cmp: new () => T, init?: (h: T) => void) {
  const fixture = TestBed.createComponent(cmp);
  init?.(fixture.componentInstance);
  fixture.detectChanges();
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
  return { fixture, host: fixture.componentInstance, navigate };
}

const q = (f: { nativeElement: HTMLElement }, sel: string) =>
  f.nativeElement.querySelector(sel) as HTMLElement;

const fire = (el: Element, type: string, init: MouseEventInit = {}) => {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  el.dispatchEvent(e);
  return e;
};

describe('mmLink contract: preloading', () => {
  beforeEach(() => configure());

  it('a hover after the URL changed preloads the current merged URL', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/x?page=1');
    const { fixture } = mount(Host, (h) => {
      h.link.set('/list');
      h.handling.set('merge');
    });
    fire(q(fixture, '.l'), 'mouseenter');
    expect(startPreload).toHaveBeenLastCalledWith('/list?page=1', 'all');

    await router.navigateByUrl('/x?page=2');
    fixture.detectChanges();
    expect(q(fixture, '.l').getAttribute('href')).toBe('/list?page=2');
    fire(q(fixture, '.l'), 'mouseenter');
    expect(startPreload).toHaveBeenLastCalledWith('/list?page=2', 'all');
  });

  it('a relative link preloads against the route hosting it', async () => {
    const harness = await RouterTestingHarness.create('/docs/page');
    const a = harness.routeNativeElement?.querySelector('.self') as HTMLElement;
    fire(a, 'mouseenter');
    expect(startPreload).toHaveBeenLastCalledWith('/docs/page#install', 'all');
    const rel = harness.routeNativeElement?.querySelector(
      '.rel',
    ) as HTMLElement;
    fire(rel, 'mouseenter');
    expect(startPreload).toHaveBeenLastCalledWith('/docs/page/child', 'all');
  });

  it('injectTriggerPreload accepts a UrlTree', () => {
    const router = TestBed.inject(Router);
    const trigger = TestBed.runInInjectionContext(() => injectTriggerPreload());
    trigger(router.parseUrl('/docs/page?x=1'));
    expect(startPreload).toHaveBeenCalledWith('/docs/page?x=1', 'all');
  });

  it('a null link neither preloads nor emits preloading', () => {
    const { fixture, host } = mount(Host, (h) => h.link.set(null));
    fire(q(fixture, '.l'), 'mouseenter');
    expect(startPreload).not.toHaveBeenCalled();
    expect(host.preloads).toBe(0);
  });
});

describe('mmLink contract: clicks and mousedown', () => {
  const reached: Event[] = [];
  const stopBrowserNavigation = (e: Event) => {
    reached.push(e);
    e.preventDefault();
  };
  beforeEach(() => {
    configure();
    reached.length = 0;
    document.addEventListener('click', stopBrowserNavigation);
  });
  afterEach(() => document.removeEventListener('click', stopBrowserNavigation));

  it('an area host is an anchor: a ctrl-click is left to the browser', () => {
    const bn = vi.fn();
    const { fixture } = mount(Host, (h) => h.beforeNavigate.set(bn));
    const area = q(fixture, '.area');
    fire(area, 'click', { ctrlKey: true });
    expect(bn).not.toHaveBeenCalled();
    fire(area, 'click');
    expect(bn).toHaveBeenCalledTimes(1);
  });

  it('a non-anchor host renders and navigates on any click, also without customElements', () => {
    vi.stubGlobal('customElements', undefined);
    try {
      const { fixture, host, navigate } = mount(ButtonHost);
      fire(q(fixture, '.b'), 'click', { ctrlKey: true });
      expect(host.bn).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a plain button host navigates on click', () => {
    const { fixture, host, navigate } = mount(ButtonHost);
    fire(q(fixture, '.b'), 'click');
    expect(host.bn).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('navigates on click, not mousedown, by default', () => {
    const { fixture, navigate } = mount(DefaultHost);
    fire(q(fixture, '.d'), 'mousedown');
    expect(navigate).not.toHaveBeenCalled();
    fire(q(fixture, '.d'), 'click');
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('useMouseDown leaves a ctrl mousedown to the browser', () => {
    const bn = vi.fn();
    const { fixture, navigate } = mount(Host, (h) => {
      h.useMouseDown.set(true);
      h.beforeNavigate.set(bn);
    });
    const a = q(fixture, '.l');
    fire(a, 'mousedown', { ctrlKey: true });
    const click = fire(a, 'click', { ctrlKey: true });
    expect(bn).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(reached).toContain(click);
  });

  it('useMouseDown navigates without a beforeNavigate binding', () => {
    const { fixture, navigate } = mount(Host, (h) => h.useMouseDown.set(true));
    fire(q(fixture, '.l'), 'mousedown');
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('a press that ends off the link does not swallow the next click on it', () => {
    const { fixture, navigate } = mount(Host, (h) => h.useMouseDown.set(true));
    const a = q(fixture, '.l');
    fire(a, 'mousedown');
    fire(document.body, 'click');
    fire(a, 'click');
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('only the click of the press itself is swallowed', () => {
    const { fixture, navigate } = mount(Host, (h) => h.useMouseDown.set(true));
    const a = q(fixture, '.l');
    fire(a, 'mousedown');
    fire(a, 'click');
    expect(navigate).toHaveBeenCalledTimes(1);
    fire(a, 'click');
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('a null link fires no beforeNavigate', () => {
    const bn = vi.fn();
    const { fixture } = mount(Host, (h) => {
      h.link.set(null);
      h.beforeNavigate.set(bn);
    });
    fire(q(fixture, '.l'), 'click');
    expect(bn).not.toHaveBeenCalled();
  });

  it('target _blank is left to the browser, target _self navigates', () => {
    const bn = vi.fn();
    const blank = mount(Host, (h) => {
      h.target.set('_blank');
      h.beforeNavigate.set(bn);
    });
    fire(q(blank.fixture, '.l'), 'click');
    expect(bn).not.toHaveBeenCalled();
    blank.fixture.componentInstance.target.set('_self');
    blank.fixture.detectChanges();
    fire(q(blank.fixture, '.l'), 'click');
    expect(bn).toHaveBeenCalledTimes(1);
  });

  it('routerLinkActive follows a changed link without waiting for a navigation', async () => {
    await TestBed.inject(Router).navigateByUrl('/docs/other');
    const { fixture, host } = mount(Host, (h) => h.link.set('/elsewhere'));
    expect(q(fixture, '.l').classList.contains('on')).toBe(false);
    host.link.set('/docs/other');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(q(fixture, '.l').classList.contains('on')).toBe(true);
  });
});

describe('mmLink contract: config defaults', () => {
  it('provideMMLinkDefaultConfig keeps useMouseDown off unless set', () => {
    const p = provideMMLinkDefaultConfig({ preloadOn: 'visible' }) as {
      useValue: { useMouseDown: boolean; preloadOn: string; preload: string };
    };
    expect(p.useValue).toEqual({
      preloadOn: 'visible',
      preload: 'all',
      useMouseDown: false,
    });
  });
});
