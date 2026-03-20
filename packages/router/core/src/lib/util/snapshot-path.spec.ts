import { TestBed } from '@angular/core/testing';
import { type ActivatedRouteSnapshot, Router } from '@angular/router';
import { injectSnapshotPathResolver } from './snapshot-path';

describe('injectSnapshotPathResolver', () => {
  let routerMock: Partial<Router>;

  beforeEach(() => {
    routerMock = {
      parseUrl: vi.fn((url: string) => `parsed(${url})` as any),
      serializeUrl: vi.fn((tree: any) => `serialized(${tree})`),
    };

    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: routerMock }],
    });
  });

  it('should resolve path from snapshot', () => {
    TestBed.runInInjectionContext(() => {
      const resolver = injectSnapshotPathResolver();

      const routeMock = {
        pathFromRoot: [
          { routeConfig: { path: '' } },
          { routeConfig: undefined },
          { routeConfig: { path: 'user' } },
          { routeConfig: { path: '' } }, // filter(Boolean) removes ''
          { routeConfig: { path: ':id' } },
        ],
      } as unknown as ActivatedRouteSnapshot;

      const result = resolver(routeMock as any);

      expect(routerMock.parseUrl).toHaveBeenCalledWith('user/:id');
      expect(routerMock.serializeUrl).toHaveBeenCalledWith('parsed(user/:id)');
      expect(result).toBe('serialized(parsed(user/:id))');
    });
  });
});
