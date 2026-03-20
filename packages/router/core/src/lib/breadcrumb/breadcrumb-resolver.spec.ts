import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { createBreadcrumb } from './breadcrumb-resolver';
import { BreadcrumbStore } from './breadcrumb-store';

@Component({ template: '' })
class DummyComponent {}

describe('breadcrumb-resolver', () => {
  let mockStore: { register: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockStore = { register: vi.fn() };
  });

  async function setupRouter(resolveConfig: any) {
    TestBed.configureTestingModule({
      providers: [
        { provide: BreadcrumbStore, useValue: mockStore },
        provideRouter([
          {
            path: 'test',
            component: DummyComponent,
            resolve: {
              breadcrumb: createBreadcrumb(resolveConfig),
            },
          },
        ]),
      ],
    });

    const router = TestBed.inject(Router);
    await router.navigateByUrl('/test');
    TestBed.tick();
    return router;
  }

  it('should register a static breadcrumb', async () => {
    await setupRouter(() => ({
      label: 'Static Label',
      ariaLabel: 'Static Aria',
    }));

    expect(mockStore.register).toHaveBeenCalled();
    const registered = mockStore.register.mock.calls[0][0];

    expect(registered.label()).toBe('Static Label');
    expect(registered.ariaLabel()).toBe('Static Aria');
    expect(registered.link()).toBe('/test');
  });

  it('should default ariaLabel to label if not provided', async () => {
    await setupRouter(() => ({
      label: 'Main Label',
    }));

    const registered = mockStore.register.mock.calls[0][0];

    expect(registered.label()).toBe('Main Label');
    expect(registered.ariaLabel()).toBe('Main Label');
  });

  it('should handle signal-based labels', async () => {
    const labelSignal = signal('Initial Signal');
    const ariaSignal = signal('Initial Aria Signal');

    await setupRouter(() => ({
      label: labelSignal,
      ariaLabel: ariaSignal,
    }));

    const registered = mockStore.register.mock.calls[0][0];

    expect(registered.label()).toBe('Initial Signal');
    expect(registered.ariaLabel()).toBe('Initial Aria Signal');

    labelSignal.set('Updated Signal');
    ariaSignal.set('Updated Aria Signal');

    expect(registered.label()).toBe('Updated Signal');
    expect(registered.ariaLabel()).toBe('Updated Aria Signal');
  });

  it('should await truthy value if awaitValue is true', async () => {
    const labelSignal = signal('');
    
    TestBed.configureTestingModule({
      providers: [
        { provide: BreadcrumbStore, useValue: mockStore },
        provideRouter([
          {
            path: 'test',
            component: DummyComponent,
            resolve: {
              breadcrumb: createBreadcrumb(() => ({
                label: labelSignal,
                awaitValue: true,
              })),
            },
          },
        ]),
      ],
    });

    const router = TestBed.inject(Router);
    
    // Start navigation, but don't await immediately because it will block
    let navigationComplete = false;
    router.navigateByUrl('/test').then(() => {
      navigationComplete = true;
    });

    // Let the event loop cycle
    await new Promise((r) => setTimeout(r, 0));
    
    // Navigation should be blocked waiting for labelSignal to be truthy
    expect(navigationComplete).toBe(false);

    // Provide truthy value
    labelSignal.set('Truthy Label');
    TestBed.flushEffects();

    // Now await the navigation
    await new Promise((r) => setTimeout(r, 20)); // wait a bit more for router
    
    expect(navigationComplete).toBe(true);
    
    const registered = mockStore.register.mock.calls[0][0];
    expect(registered.label()).toBe('Truthy Label');
  });
});
