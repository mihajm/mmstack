import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  Router,
  RouterLink,
  type UrlTree,
} from '@angular/router';
import { Subject } from 'rxjs';
import { Link, injectTriggerPreload, provideMMLinkDefaultConfig } from './link';
import { PreloadRequester } from './preloading';

@Component({
  selector: 'mm-test-host',
  template: `
    <a
      [mmLink]="url"
      [preloadOn]="preloadOn"
      [useMouseDown]="useMouseDown"
      [beforeNavigate]="beforeNavigate"
      (preloading)="preloading.next($event)"
      class="test-link"
    >
      Link
    </a>
  `,
  imports: [Link],
})
class TestHostComponent {
  url: any = '/test';
  preloadOn: 'hover' | 'visible' | null = 'hover';
  useMouseDown = false;
  beforeNavigate = vi.fn();
  preloading = new Subject<void>();
}

class MmHrefEl extends HTMLElement {
  static readonly observedAttributes = ['href'];
}
class MmPlainEl extends HTMLElement {}
if (!customElements.get('mm-href-link'))
  customElements.define('mm-href-link', MmHrefEl);
if (!customElements.get('mm-plain-link'))
  customElements.define('mm-plain-link', MmPlainEl);

@Component({
  template: `<mm-href-link [mmLink]="'/x'" [beforeNavigate]="bn">h</mm-href-link>`,
  imports: [Link],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
class HrefElHost {
  bn = vi.fn();
}

@Component({
  template: `<mm-plain-link [mmLink]="'/x'" [beforeNavigate]="bn">p</mm-plain-link>`,
  imports: [Link],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
class PlainElHost {
  bn = vi.fn();
}

describe('link primitives & directive', () => {
  let routerMock: Partial<Router>;
  let reqMock: Partial<PreloadRequester>;
  let observerCallbacks: any[] = [];

  class MockIntersectionObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    constructor(public callback: any) {
      observerCallbacks.push(callback);
    }
  }

  beforeEach(() => {
    observerCallbacks = [];
    (window as any).IntersectionObserver = MockIntersectionObserver;

    routerMock = {
      createUrlTree: vi.fn().mockImplementation((arr) => {
        return { asString: () => arr.join('/') } as unknown as UrlTree;
      }),
      serializeUrl: vi.fn().mockImplementation((tree) => {
        return (tree as any).asString();
      }),
      navigateByUrl: vi.fn().mockResolvedValue(true),
      events: new Subject<any>(),
    };

    reqMock = {
      startPreload: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: routerMock },
        { provide: PreloadRequester, useValue: reqMock },
        { provide: ActivatedRoute, useValue: {} },
      ],
    });
  });

  describe('injectTriggerPreload', () => {
    it('should inject function and call preload on startPreload', () => {
      TestBed.runInInjectionContext(() => {
        const trigger = injectTriggerPreload();

        trigger('/my-path');

        expect(routerMock.createUrlTree).toHaveBeenCalledWith(['/my-path'], {
          relativeTo: undefined,
          queryParams: undefined,
          fragment: undefined,
          queryParamsHandling: undefined,
        });

        expect(reqMock.startPreload).toHaveBeenCalledWith('/my-path', 'all');
      });
    });

    it('should ignore if link is null', () => {
      TestBed.runInInjectionContext(() => {
        const trigger = injectTriggerPreload();

        trigger(null);

        expect(routerMock.createUrlTree).not.toHaveBeenCalled();
        expect(reqMock.startPreload).not.toHaveBeenCalled();
      });
    });
  });

  describe('provideMMLinkDefaultConfig', () => {
    it('should provide config with defaults merged', () => {
      const provider = provideMMLinkDefaultConfig({ useMouseDown: true });
      expect((provider as any).useValue).toEqual({
        preloadOn: 'hover',
        preload: 'all',
        useMouseDown: true,
      });
    });
  });

  describe('Link Directive', () => {
    let fixture: any;
    let component: TestHostComponent;
    let linkElement: HTMLElement;
    let routerLinkMock: Partial<RouterLink>;

    beforeEach(() => {
      routerLinkMock = {
        onClick: vi.fn().mockReturnValue(true),
        urlTree: { asString: () => '/test' } as any,
      };

      TestBed.overrideComponent(TestHostComponent, {
        add: {
          providers: [{ provide: RouterLink, useValue: routerLinkMock }],
        },
      });

      fixture = TestBed.createComponent(TestHostComponent);
      component = fixture.componentInstance;
      linkElement = fixture.nativeElement.querySelector('.test-link');
    });

    it('should trigger preload on hover if preloadOn is hover', () => {
      fixture.detectChanges();

      let emitted = false;
      component.preloading.subscribe(() => (emitted = true));

      linkElement.dispatchEvent(new MouseEvent('mouseenter'));

      expect(reqMock.startPreload).toHaveBeenCalledWith('/test', 'all');
      expect(emitted).toBe(true);
    });

    it('should ignore hover if preloadOn is visible', () => {
      component.preloadOn = 'visible';
      fixture.detectChanges();

      linkElement.dispatchEvent(new MouseEvent('mouseenter'));

      expect(reqMock.startPreload).not.toHaveBeenCalled();
    });

    it('should call routeLink.onClick and beforeNavigate on mousedown if useMouseDown = true', () => {
      component.useMouseDown = true;
      fixture.detectChanges();

      linkElement.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));

      expect(component.beforeNavigate).toHaveBeenCalled();
    });

    it('should ignore mousedown if useMouseDown = false', () => {
      component.useMouseDown = false;
      fixture.detectChanges();

      linkElement.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));

      expect(component.beforeNavigate).not.toHaveBeenCalled();
    });

    it('should call beforeNavigate and navigate exactly once on click if useMouseDown = false', () => {
      component.useMouseDown = false;
      fixture.detectChanges();

      linkElement.dispatchEvent(new MouseEvent('click', { button: 0 }));

      expect(component.beforeNavigate).toHaveBeenCalledTimes(1);
      expect(routerMock.navigateByUrl).toHaveBeenCalledTimes(1);
    });

    it('should swallow the click that follows a mousedown navigation if useMouseDown = true', () => {
      component.useMouseDown = true;
      fixture.detectChanges();

      linkElement.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      expect(component.beforeNavigate).toHaveBeenCalledTimes(1);
      expect(routerMock.navigateByUrl).toHaveBeenCalledTimes(1);

      const click = new MouseEvent('click', { button: 0, cancelable: true });
      linkElement.dispatchEvent(click);

      expect(component.beforeNavigate).toHaveBeenCalledTimes(1);
      expect(routerMock.navigateByUrl).toHaveBeenCalledTimes(1);
      expect(click.defaultPrevented).toBe(true);
    });

    it('should still navigate on a bare click (keyboard activation) if useMouseDown = true', () => {
      component.useMouseDown = true;
      fixture.detectChanges();

      linkElement.dispatchEvent(
        new MouseEvent('click', { button: 0, cancelable: true }),
      );

      expect(component.beforeNavigate).toHaveBeenCalledTimes(1);
      expect(routerMock.navigateByUrl).toHaveBeenCalledTimes(1);
    });

    it('should not fire beforeNavigate for modified clicks', () => {
      component.useMouseDown = false;
      fixture.detectChanges();

      linkElement.dispatchEvent(
        new MouseEvent('click', { button: 0, ctrlKey: true }),
      );
      linkElement.dispatchEvent(new MouseEvent('click', { button: 1 }));

      expect(component.beforeNavigate).not.toHaveBeenCalled();
    });

    it('should trigger preload when intersection visibility goes to true if preloadOn = visible', async () => {
      component.preloadOn = 'visible';
      fixture.detectChanges();

      const linkNativeEl = fixture.debugElement.query(
        (de: any) => de.name === 'a',
      ).nativeElement;

      if (observerCallbacks.length > 0) {
        observerCallbacks[0]([{ target: linkNativeEl, isIntersecting: true }]);
      }

      fixture.detectChanges();
      TestBed.tick();

      expect(reqMock.startPreload).toHaveBeenCalledWith('/test', 'all');
    });
  });

  describe('anchor-detection parity (custom-element hosts)', () => {
    const ctrlClick = (el: Element) =>
      el.dispatchEvent(new MouseEvent('click', { button: 0, ctrlKey: true }));
    const plainClick = (el: Element) =>
      el.dispatchEvent(new MouseEvent('click', { button: 0 }));

    it('gates a modified click on a custom element that observes href (treated as an anchor)', () => {
      const fixture = TestBed.createComponent(HrefElHost);
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('mm-href-link');

      ctrlClick(el);
      expect(fixture.componentInstance.bn).not.toHaveBeenCalled();

      plainClick(el);
      expect(fixture.componentInstance.bn).toHaveBeenCalledTimes(1);
    });

    it('does NOT gate a custom element that does not observe href (navigates on any click)', () => {
      const fixture = TestBed.createComponent(PlainElHost);
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('mm-plain-link');

      ctrlClick(el);
      expect(fixture.componentInstance.bn).toHaveBeenCalledTimes(1);
    });
  });
});
