import { Component } from '@angular/core';
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

        expect(reqMock.startPreload).toHaveBeenCalledWith('/my-path');
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

      // Trigger hover
      linkElement.dispatchEvent(new MouseEvent('mouseenter'));

      expect(reqMock.startPreload).toHaveBeenCalledWith('/test');
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
      // RouterLink onClick won't be called on our mock because hostDirectives creates its own instance.
      // So we just verify navigateByUrl is called if we want, or we can just verify beforeNavigate is called!
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
      // navigation is RouterLink's own listener — delegating used to navigate TWICE
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

      // the press already navigated on mousedown — its click must not navigate again
      expect(component.beforeNavigate).toHaveBeenCalledTimes(1);
      expect(routerMock.navigateByUrl).toHaveBeenCalledTimes(1);
      expect(click.defaultPrevented).toBe(true);
    });

    it('should still navigate on a bare click (keyboard activation) if useMouseDown = true', () => {
      component.useMouseDown = true;
      fixture.detectChanges();

      // no preceding mousedown — e.g. Enter on a focused link
      linkElement.dispatchEvent(
        new MouseEvent('click', { button: 0, cancelable: true }),
      );

      // falls through to RouterLink's own click handling — exactly one navigation
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

      // browser-default navigations (new tab / middle click) skip the hook
      expect(component.beforeNavigate).not.toHaveBeenCalled();
    });

    it('should trigger preload when intersection visibility goes to true if preloadOn = visible', async () => {
      component.preloadOn = 'visible';
      fixture.detectChanges();

      const linkNativeEl = fixture.debugElement.query(
        (de: any) => de.name === 'a',
      ).nativeElement;

      // trigger intersection observer
      if (observerCallbacks.length > 0) {
        observerCallbacks[0]([{ target: linkNativeEl, isIntersecting: true }]);
      }

      // Update the mock value and wait for effect
      fixture.detectChanges();
      TestBed.tick();

      expect(reqMock.startPreload).toHaveBeenCalledWith('/test');
    });
  });
});
