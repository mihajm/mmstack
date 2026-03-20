import { TestBed } from '@angular/core/testing';
import { type ActivatedRouteSnapshot, EventType, Router, type RouterStateSnapshot } from '@angular/router';
import { Subject } from 'rxjs';
import { injectLeafRoutes, RouteLeafStore } from './leaf.store';

describe('leafStore', () => {
  let routerMock: Partial<Router>;
  let eventsSubject: Subject<any>;

  beforeEach(() => {
    eventsSubject = new Subject();
    
    routerMock = {
      url: '/user/123',
      events: eventsSubject,
      parseUrl: vi.fn((url: string) => `parsed(${url})` as any),
      serializeUrl: vi.fn((tree: any) => {
        const str = tree.replace('parsed(', '').replace(')', '');
        return `/${str}`.replace('//', '/');
      }),
      routerState: {
        snapshot: {
          root: {
            url: [],
            pathFromRoot: [{ routeConfig: { path: '' }, url: [] }],
            firstChild: {
              url: [{ path: 'user' }],
              pathFromRoot: [
                { routeConfig: { path: '' }, url: [] },
                { routeConfig: { path: 'user' }, url: [{ path: 'user' }] }
              ],
              firstChild: {
                url: [{ path: '123' }],
                pathFromRoot: [
                  { routeConfig: { path: '' }, url: [] },
                  { routeConfig: { path: 'user' }, url: [{ path: 'user' }] },
                  { routeConfig: { path: ':id' }, url: [{ path: '123' }] }
                ],
                firstChild: null
              } as unknown as ActivatedRouteSnapshot
            } as unknown as ActivatedRouteSnapshot
          } as unknown as ActivatedRouteSnapshot
        } as unknown as RouterStateSnapshot
      } as any
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: routerMock }
      ]
    });
  });

  it('should compute leaf routes based on RouterStateSnapshot', () => {
    TestBed.runInInjectionContext(() => {
      const leavesSignal = injectLeafRoutes();
      const result = leavesSignal();

      expect(result.length).toBe(3);
      
      expect(result[0].segment.path).toBe('');
      expect(result[0].segment.resolved).toBe('');
      expect(result[0].path).toBe('/');
      expect(result[0].link).toBe('/');
      
      expect(result[1].segment.path).toBe('user');
      expect(result[1].segment.resolved).toBe('user');
      expect(result[1].path).toBe('/user');
      expect(result[1].link).toBe('/user');
      
      expect(result[2].segment.path).toBe(':id');
      expect(result[2].segment.resolved).toBe('123');
      expect(result[2].path).toBe('/user/:id');
      expect(result[2].link).toBe('/user/123');
    });
  });
  
  it('should reactive to url changes and deduplicate routes', () => {
    TestBed.runInInjectionContext(() => {
      const store = TestBed.inject(RouteLeafStore);
      const resultInitial = store.leaves();
      expect(resultInitial.length).toBe(3);
      
      const newRootMock = {
         url: [],
         pathFromRoot: [{ routeConfig: { path: 'home' }, url: [{ path: 'home' }] }],
         firstChild: {
            url: [],
            // Simulate duplicated path configuration
            pathFromRoot: [
              { routeConfig: { path: 'home' }, url: [{ path: 'home' }] },
              { routeConfig: { path: '' }, url: [] }
            ],
            firstChild: null
         }
      } as unknown as ActivatedRouteSnapshot;
      
      (routerMock as any).routerState.snapshot.root = newRootMock;
      eventsSubject.next({ type: EventType.NavigationEnd, urlAfterRedirects: '/home' });
      
      const resultAfter = store.leaves();
      expect(resultAfter.length).toBe(1); // deduped
      
      expect(resultAfter[0].segment.path).toBe('home');
      expect(resultAfter[0].segment.resolved).toBe('home');
      expect(resultAfter[0].path).toBe('/home');
      expect(resultAfter[0].link).toBe('/home');
    });
  });
});
