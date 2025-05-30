import { Route } from '@angular/router';
import { findPath } from './find-path';

describe('findPath', () => {
  it('should find path for a simple top-level route', () => {
    const routeB: Route = { path: 'b' };
    const config: Route[] = [{ path: 'a' }, routeB, { path: 'c' }];
    expect(findPath(config, routeB)).toBe('/b');
  });

  it('should find path for a top-level route with an empty path', () => {
    const routeEmpty: Route = { path: '' };
    const config: Route[] = [routeEmpty, { path: 'a' }];
    expect(findPath(config, routeEmpty)).toBe('/');
  });

  it('should find path for a nested route', () => {
    const childB: Route = { path: 'b' };
    const parentA: Route = { path: 'a', children: [childB] };
    const config: Route[] = [parentA, { path: 'other' }];
    expect(findPath(config, childB)).toBe('/a/b');
  });

  it('should find path for a deeply nested route', () => {
    const grandChildC: Route = { path: 'c' };
    const childB: Route = { path: 'b', children: [grandChildC] };
    const parentA: Route = { path: 'a', children: [childB] };
    const config: Route[] = [parentA];
    expect(findPath(config, grandChildC)).toBe('/a/b/c');
  });

  it('should handle empty path segments in nested routes', () => {
    const childEmpty: Route = { path: '' };
    const parentA: Route = { path: 'a', children: [childEmpty] };
    const config: Route[] = [parentA];
    expect(findPath(config, childEmpty)).toBe('/a'); // /a/ resolves to /a
  });

  it('should handle empty path segment for a parent route', () => {
    const childB: Route = { path: 'b' };
    const parentEmpty: Route = { path: '', children: [childB] };
    const config: Route[] = [parentEmpty, { path: 'c' }];
    expect(findPath(config, childB)).toBe('/b'); // /b (//b becomes /b)
  });

  it('should handle empty path segment for a parent route that is also a target', () => {
    const childB: Route = { path: 'b' };
    const parentEmpty: Route = { path: '', children: [childB] };
    const config: Route[] = [parentEmpty, { path: 'c' }];
    expect(findPath(config, parentEmpty)).toBe('/');
  });

  it('should find path for a route within _loadedRoutes (simulating lazy loading)', () => {
    const lazyChildB: Route = { path: 'b' };
    const lazyModuleRoutes: Route[] = [lazyChildB];
    const parentA: Route = {
      path: 'a',
      _loadedRoutes: lazyModuleRoutes,
    } as any; // Cast to any for _loadedRoutes
    const config: Route[] = [parentA];
    expect(findPath(config, lazyChildB)).toBe('/a/b');
  });

  it('should find path for a nested route within _loadedRoutes', () => {
    const lazyGrandChildC: Route = { path: 'c' };
    const lazyChildB: Route = { path: 'b', children: [lazyGrandChildC] };
    const lazyModuleRoutes: Route[] = [lazyChildB];
    const parentA: Route = {
      path: 'a',
      _loadedRoutes: lazyModuleRoutes,
    } as any;
    const config: Route[] = [parentA];
    expect(findPath(config, lazyGrandChildC)).toBe('/a/b/c');
  });

  it('should handle _loadedRoutes being an empty array', () => {
    const routeA: Route = { path: 'a', _loadedRoutes: [] } as any;
    const config: Route[] = [routeA];
    expect(findPath(config, routeA)).toBe('/a');
  });

  it('should find path for a route with a named outlet', () => {
    const outletChildB: Route = { path: 'b', outlet: 'popup' };
    const parentA: Route = { path: 'a', children: [outletChildB] };
    const config: Route[] = [parentA];
    expect(findPath(config, outletChildB)).toBe('/a/(popup:b)');
  });

  it('should find path for a nested route where an ancestor has a named outlet', () => {
    // This tests that primary children of an outletted route are handled correctly.
    // The typical scenario is that the component loaded in the outlet has its own <router-outlet> for its children.
    const grandChildC: Route = { path: 'c' }; // Primary child of 'b'
    const childBInPopup: Route = {
      path: 'b',
      outlet: 'popup',
      children: [grandChildC],
    };
    const parentA: Route = { path: 'a', children: [childBInPopup] };
    const config: Route[] = [parentA];
    expect(findPath(config, grandChildC)).toBe('/a/(popup:b)/c');
  });

  it('should correctly normalize paths with multiple slashes from empty segments', () => {
    const childB: Route = { path: 'b' };
    const intermediateEmpty: Route = { path: '', children: [childB] };
    const parentA: Route = { path: 'a', children: [intermediateEmpty] };
    const config: Route[] = [parentA];
    // Path before normalization would be /a//b
    expect(findPath(config, childB)).toBe('/a/b');

    const routeC: Route = { path: 'c' };
    const rootEmptyChildEmpty: Route = { path: '', children: [routeC] };
    const config2: Route[] = [rootEmptyChildEmpty];
    // Path before normalization //c
    expect(findPath(config2, routeC)).toBe('/c');
  });

  it('should return / for the absolute root route if its path is empty', () => {
    const rootRoute: Route = { path: '' };
    const config: Route[] = [rootRoute];
    expect(findPath(config, rootRoute)).toBe('/');
  });

  it('should find a route that is not the first in _loadedRoutes', () => {
    const lazyChild1: Route = { path: 'lazy1' };
    const lazyChild2: Route = { path: 'lazy2' };
    const lazyModuleRoutes: Route[] = [lazyChild1, lazyChild2];
    const parentA: Route = {
      path: 'a',
      _loadedRoutes: lazyModuleRoutes,
    } as any;
    const config: Route[] = [parentA];
    expect(findPath(config, lazyChild2)).toBe('/a/lazy2');
  });

  it('should handle complex structure with mixed children and _loadedRoutes', () => {
    const finalTarget: Route = { path: 'target' };
    const lazyGrandchildren: Route[] = [finalTarget];
    const lazyChild: Route = {
      path: 'lazy-child',
      _loadedRoutes: lazyGrandchildren,
    } as any;
    const directChild: Route = { path: 'direct-child', children: [lazyChild] };
    const root: Route = { path: 'root', children: [directChild] };
    const config: Route[] = [root];
    expect(findPath(config, finalTarget)).toBe(
      '/root/direct-child/lazy-child/target',
    );
  });

  it('should return "/" if route is top-level and path is "" and other routes exist', () => {
    const route1: Route = { path: '' };
    const route2: Route = { path: 'other' };
    const config: Route[] = [route1, route2];
    expect(findPath(config, route1)).toBe('/');
  });

  it('should correctly find path when target route is a direct child of a _loadedRoutes parent', () => {
    const target: Route = { path: 'targetInLazy' };
    const lazyParent: Route = { path: 'lazyParentPath', children: [target] }; // This route itself is part of a lazy loaded module
    const rootLevelLazyTrigger: Route = {
      path: 'trigger',
      _loadedRoutes: [lazyParent],
    } as any;
    const config: Route[] = [rootLevelLazyTrigger];
    expect(findPath(config, target)).toBe(
      '/trigger/lazyParentPath/targetInLazy',
    );
  });
});
