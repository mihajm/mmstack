import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  convertToParamMap,
  Router,
  type ActivatedRouteSnapshot,
  type ParamMap,
} from '@angular/router';
import { Subject } from 'rxjs';
import { pathParam } from './path-param';

describe('pathParam', () => {
  let routerMock: Partial<Router>;
  let activeRouteMock: Partial<ActivatedRoute>;
  let paramMapSubject: Subject<ParamMap>;
  let parentParamMapSubject: Subject<ParamMap>;

  beforeEach(() => {
    paramMapSubject = new Subject();
    parentParamMapSubject = new Subject();

    routerMock = {};

    activeRouteMock = {
      paramMap: paramMapSubject,
      snapshot: {
        paramMap: convertToParamMap({ id: '123' }),
      } as ActivatedRouteSnapshot,
      parent: {
        paramMap: parentParamMapSubject,
        snapshot: {
          paramMap: convertToParamMap({ postId: '789' }),
        } as ActivatedRouteSnapshot,
        parent: null,
      } as unknown as ActivatedRoute,
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: routerMock },
        { provide: ActivatedRoute, useValue: activeRouteMock },
      ],
    });
  });

  it('should read path param from active route', () => {
    TestBed.runInInjectionContext(() => {
      const id = pathParam('id');
      const dynamic = pathParam(signal('id'));

      expect(id()).toBe('123');
      expect(dynamic()).toBe('123');
    });
  });

  it('should update on navigation', () => {
    const id = TestBed.runInInjectionContext(() => pathParam('id'));

    paramMapSubject.next(convertToParamMap({ id: '456' }));
    expect(id()).toBe('456');
  });

  it('should fallback to null if param missing', () => {
    TestBed.runInInjectionContext(() => {
      const dynamic = pathParam('missing');
      expect(dynamic()).toBe(null);
    });
  });

  it('should support dynamic keys changing', () => {
    const keySignal = signal('id');
    const dynamicParam = TestBed.runInInjectionContext(() =>
      pathParam(keySignal),
    );

    expect(dynamicParam()).toBe('123');

    keySignal.set('missing');
    expect(dynamicParam()).toBe(null);
  });

  it('should read from parent routes when in a child route', () => {
    TestBed.runInInjectionContext(() => {
      const postId = pathParam('postId');
      expect(postId()).toBe('789');
    });
  });

  it('should support paramsInheritanceStrategy: always', () => {
    TestBed.resetTestingModule();
    (routerMock as unknown as { options: unknown }).options = {
      paramsInheritanceStrategy: 'always',
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: routerMock },
        { provide: ActivatedRoute, useValue: activeRouteMock },
      ],
    });

    TestBed.runInInjectionContext(() => {
      const id = pathParam('id');
      expect(id()).toBe('123');

      paramMapSubject.next(convertToParamMap({ id: '999' }));
      expect(id()).toBe('999');
    });
  });
});
