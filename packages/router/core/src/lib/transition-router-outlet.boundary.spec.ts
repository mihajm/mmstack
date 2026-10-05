/* eslint-disable @angular-eslint/component-selector */
import { provideLocationMocks } from '@angular/common/testing';
import { Component, ErrorHandler, type ErrorDetails } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { render } from '@testing-library/angular';
import { TransitionRouterOutlet } from './transition-router-outlet';

// Angular 22 `@boundary` inside a routed component under the transition outlet. Master only.

class RecordingErrorHandler extends ErrorHandler {
  readonly viewErrors: ErrorDetails[] = [];
  readonly handled: unknown[] = [];
  override handleError(error: unknown): void {
    this.handled.push(error);
  }
  override onViewError(_error: Error, details: ErrorDetails): void {
    this.viewErrors.push(details);
  }
}

@Component({ selector: 'route-a', template: `route-A` })
class RouteA {}

@Component({ selector: 'route-thrower', template: `{{ read() }}` })
class Thrower {
  protected read(): string {
    throw new Error('render failed');
  }
}

// angular-eslint (22.5) cannot parse `@boundary` yet; a template held in a const is not extracted for template lint.
const ROUTE_X_TEMPLATE = `
    <h1>route-X</h1>
    @boundary {
      <route-thrower />
    } @error {
      <span class="x-error">x-error</span>
    }
  `;

@Component({
  selector: 'route-x',
  imports: [Thrower],
  template: ROUTE_X_TEMPLATE,
})
class RouteX {}

@Component({
  selector: 'test-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class Host {}

describe('TransitionRouterOutlet + @boundary in the routed component (Angular 22)', () => {
  it('the routed component catches its own throw; the outlet swaps and keeps routing', async () => {
    const { fixture, container } = await render(Host, {
      providers: [
        provideRouter([
          { path: 'a', component: RouteA },
          { path: 'x', component: RouteX },
        ]),
        provideLocationMocks(),
        { provide: ErrorHandler, useClass: RecordingErrorHandler },
      ],
    });
    const router = TestBed.inject(Router);
    const handler = TestBed.inject(ErrorHandler) as RecordingErrorHandler;
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        fixture.detectChanges();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r));
      }
      fixture.detectChanges();
    };

    await router.navigateByUrl('/a');
    await flush();
    const outlet = container.querySelector('mm-transition-outlet');
    expect(container.querySelector('route-a')).not.toBeNull();

    await router.navigateByUrl('/x');
    await flush();

    expect(handler.viewErrors.map((d) => d.boundary?.type)).toEqual([RouteX]);
    expect(handler.handled).toEqual([]);
    const routeX = container.querySelector('route-x') as HTMLElement | null;
    expect(routeX).not.toBeNull();
    expect(routeX?.style.display).not.toBe('none');
    expect(routeX?.textContent).toContain('route-X');
    expect(routeX?.querySelector('.x-error')).not.toBeNull();
    expect(container.querySelector('route-a')).toBeNull();
    expect(container.querySelector('mm-transition-outlet')).toBe(outlet);

    await router.navigateByUrl('/a');
    await flush();
    expect(container.querySelector('route-a')).not.toBeNull();
    expect(container.querySelector('route-x')).toBeNull();
    expect(handler.viewErrors.length).toBe(1);
  });
});
