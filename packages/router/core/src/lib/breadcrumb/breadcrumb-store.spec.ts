import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideBreadcrumbConfig } from './breadcrumb-config';
import { createBreadcrumb } from './breadcrumb-resolver';
import { BreadcrumbStore, injectBreadcrumbs } from './breadcrumb-store';

@Component({ template: '' })
class DummyComponent {}

const reactiveBreadcrumb = signal('Reactive Label');

describe('breadcrumb integration', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {
            path: 'home',
            component: DummyComponent,
            title: 'Home Route', // Auto-generated fallback for breadcrumb
            children: [
              {
                path: 'child',
                component: DummyComponent,
                resolve: {
                  breadcrumb: createBreadcrumb(() => ({
                    label: 'Child Label',
                  })),
                },
                children: [
                  {
                    path: 'grandchild',
                    component: DummyComponent,
                    resolve: {
                      breadcrumb: createBreadcrumb(() => ({
                        label: signal('Dynamic Level'),
                      })),
                    },
                  },
                  {
                    path: 'hidden',
                    component: DummyComponent,
                    data: { skipBreadcrumb: true },
                  },
                ],
              },
              {
                path: 'reactive',
                component: DummyComponent,
                resolve: {
                  breadcrumb: createBreadcrumb(() => ({
                    label: reactiveBreadcrumb,
                  })),
                },
              },
            ],
          },
          {
            path: 'users',
            component: DummyComponent,
            children: [
              {
                path: ':id',
                component: DummyComponent,
                resolve: {
                  breadcrumb: createBreadcrumb(() => ({
                    label: 'User Profile',
                  })),
                },
              },
            ],
          },
          {
            path: 'settings-page',
            component: DummyComponent,
          },
        ]),
      ],
    });

    TestBed.inject(BreadcrumbStore); // Ensure store and its effects run
  });

  it('should auto-generate breadcrumb from route title', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/home');

    TestBed.tick();

    let breadcrumbs: any[] = [];
    TestBed.runInInjectionContext(() => {
      breadcrumbs = injectBreadcrumbs()();
    });

    expect(breadcrumbs.length).toBe(1);
    expect(breadcrumbs[0].label()).toBe('Home Route');
    expect(breadcrumbs[0].link()).toBe('/home');
  });

  it('should resolve manual breadcrumb over config', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/home/child');

    TestBed.tick();

    let breadcrumbs: any[] = [];
    TestBed.runInInjectionContext(() => {
      breadcrumbs = injectBreadcrumbs()();
    });

    expect(breadcrumbs.length).toBe(2);
    expect(breadcrumbs[0].label()).toBe('Home Route');
    expect(breadcrumbs[1].label()).toBe('Child Label');
  });

  it('should support signal-based labels', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/home/child/grandchild');

    TestBed.tick();

    let breadcrumbs: any[] = [];
    TestBed.runInInjectionContext(() => {
      breadcrumbs = injectBreadcrumbs()();
    });

    expect(breadcrumbs.length).toBe(3);
    expect(breadcrumbs[2].label()).toBe('Dynamic Level');
  });

  it('should reactively update breadcrumbs when signals change', async () => {
    const router = TestBed.inject(Router);
    reactiveBreadcrumb.set('Initial State');

    await router.navigateByUrl('/home/reactive');
    TestBed.tick();

    let breadcrumbs: any[] = [];
    TestBed.runInInjectionContext(() => {
      breadcrumbs = injectBreadcrumbs()();
    });

    expect(breadcrumbs.length).toBe(2);
    expect(breadcrumbs[1].label()).toBe('Initial State');

    reactiveBreadcrumb.set('Updated State');
    TestBed.tick();

    TestBed.runInInjectionContext(() => {
      breadcrumbs = injectBreadcrumbs()();
    });
    expect(breadcrumbs[1].label()).toBe('Updated State');
  });

  it('should filter out routes with skipBreadcrumb data', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/home/child/hidden');

    TestBed.tick();

    let breadcrumbs: any[] = [];
    TestBed.runInInjectionContext(() => {
      breadcrumbs = injectBreadcrumbs()();
    });

    expect(breadcrumbs.length).toBe(2);
    expect(breadcrumbs[breadcrumbs.length - 1].label()).toBe('Child Label');
  });

  it('should auto-generate breadcrumb from path if no title', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/settings-page');

    TestBed.tick();

    let breadcrumbs: any[] = [];
    TestBed.runInInjectionContext(() => {
      breadcrumbs = injectBreadcrumbs()();
    });

    expect(breadcrumbs.length).toBe(1);
    expect(breadcrumbs[0].label()).toBe('Settings Page');
  });

  it('should resolve path params fallback correctly', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/users/123');

    TestBed.tick();

    let breadcrumbs: any[] = [];
    TestBed.runInInjectionContext(() => {
      breadcrumbs = injectBreadcrumbs()();
    });

    expect(breadcrumbs.length).toBe(2);
    expect(breadcrumbs[0].label()).toBe('Users');
    expect(breadcrumbs[1].label()).toBe('User Profile');
  });
});

describe('breadcrumb integration - manual configuration', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideBreadcrumbConfig({ generation: 'manual' }),
        provideRouter([
          {
            path: 'home',
            component: DummyComponent,
            title: 'Home Route',
            children: [
              {
                path: 'child',
                component: DummyComponent,
                resolve: {
                  breadcrumb: createBreadcrumb(() => ({
                    label: 'Child Label',
                  })),
                },
              },
            ],
          },
        ]),
      ],
    });

    TestBed.inject(BreadcrumbStore);
  });

  it('should only show manually registered breadcrumbs', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/home/child');

    TestBed.tick();

    let breadcrumbs: any[] = [];
    TestBed.runInInjectionContext(() => {
      breadcrumbs = injectBreadcrumbs()();
    });

    expect(breadcrumbs.length).toBe(1);
    expect(breadcrumbs[0].label()).toBe('Child Label');
  });
});
