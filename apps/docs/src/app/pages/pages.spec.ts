import { type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, type Route } from '@angular/router';
import { appRoutes } from '../app.routes';

/**
 * Render-smoke over every routed page: each `loadComponent` is resolved and
 * mounted once. This is the drift tripwire for the docs site — a page whose
 * template references a renamed demo, directive or lib API fails HERE instead
 * of in a browser. Deferred demo blocks stay on their placeholders, so this
 * covers wiring, not demo behaviour (the demos have their own specs).
 */
type Loadable = { path: string; load: () => Promise<Type<unknown>> };

function collect(routes: Route[], prefix = ''): Loadable[] {
  const out: Loadable[] = [];
  for (const route of routes) {
    const path = [prefix, route.path].filter(Boolean).join('/');
    const load = route.loadComponent as
      | (() => Promise<Type<unknown>>)
      | undefined;
    if (load) out.push({ path: path || '(root)', load });
    if (route.children) out.push(...collect(route.children, path));
  }
  return out;
}

const pages = collect(appRoutes);

describe('docs pages render', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  it('found the full route surface', () => {
    expect(pages.length).toBeGreaterThan(50);
  });

  for (const page of pages) {
    it(`renders ${page.path}`, async () => {
      const component = await page.load();
      const fixture = TestBed.createComponent(component);
      // a broken template (renamed demo/directive/API) throws right here;
      // layout shells legitimately render empty, so no text assertion
      fixture.detectChanges();
      expect(fixture.componentInstance).toBeTruthy();
    });
  }
});
