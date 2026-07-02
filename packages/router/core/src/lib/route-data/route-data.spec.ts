import { Component, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, RouterOutlet, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { createRouteData, provideRouteData, routeDataKey } from './route-data';

// A parent route owns `:orgId`; a child route (non-empty path, own resolve) reads it.
// Under Angular's default `paramsInheritanceStrategy: 'emptyOnly'` the child's own paramMap
// does NOT carry `orgId`, so `ctx.params()` must merge the ancestor chain to surface it —
// matching the prefetch path, which extracts params from the full config path. This regressed
// silently across Angular versions (worked on one where the child snapshot happened to surface
// inherited params, broke where it didn't), hence this guard.

const ORG = routeDataKey<{ params: Signal<Record<string, string>> }>('org');
const AUDIT = routeDataKey<{ params: Signal<Record<string, string>> }>('audit');

// captured from inside the resolve factories (the slot tokens live on the route injectors,
// so this is the simplest way to read what each factory actually saw)
let orgParams: Signal<Record<string, string>> | undefined;
let auditParams: Signal<Record<string, string>> | undefined;

@Component({
  selector: 'mm-org-layout',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
class OrgLayout {}

@Component({ selector: 'mm-audit-page', standalone: true, template: `audit` })
class AuditPage {}

function routes(): Routes {
  return [
    {
      path: 'org/:orgId',
      component: OrgLayout,
      providers: [provideRouteData(ORG)],
      resolve: {
        org: createRouteData(ORG, (ctx) => {
          orgParams = ctx.params;
          return { params: ctx.params };
        }),
      },
      children: [
        {
          path: 'audit',
          component: AuditPage,
          providers: [provideRouteData(AUDIT)],
          resolve: {
            audit: createRouteData(AUDIT, (ctx) => {
              auditParams = ctx.params;
              return { params: ctx.params };
            }),
          },
        },
      ],
    },
  ];
}

describe('createRouteData — inherited params (regression)', () => {
  beforeEach(() => {
    orgParams = undefined;
    auditParams = undefined;
    TestBed.configureTestingModule({ providers: [provideRouter(routes())] });
  });

  it('a CHILD factory sees the PARENT route param', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/org/7/audit');

    // the child factory only knows the parent declared `:orgId` — it must resolve to '7',
    // not `undefined` (the pre-fix behavior on Angular versions that don't inherit it)
    expect(auditParams?.()['orgId']).toBe('7');
  });

  it('the child and parent factories agree on the inherited value', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/org/7/audit');

    expect(auditParams?.()['orgId']).toBe(orgParams?.()['orgId']);
  });

  it('stays live: a param-only navigation updates the inherited param', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/org/7/audit');
    expect(auditParams?.()['orgId']).toBe('7');

    await harness.navigateByUrl('/org/9/audit');
    // the live param signal follows the navigation (whether the factory re-ran or the memoized
    // slot's signal stayed, it reads current router state)
    expect(auditParams?.()['orgId']).toBe('9');
  });
});
