import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  type ActivatedRouteSnapshot,
  convertToParamMap,
  type ParamMap,
  type Params,
  Router,
} from '@angular/router';
import { Subject } from 'rxjs';
import { queryParam } from './query-param';

describe('queryParam', () => {
  let routerMock: Partial<Router>;
  let activatedRouteMock: Partial<ActivatedRoute>;
  let queryParamMapSubject: Subject<ParamMap>;
  let queryParamsSubject: Subject<Params>;

  beforeEach(() => {
    queryParamMapSubject = new Subject();
    queryParamsSubject = new Subject();

    routerMock = {
      navigate: vi.fn(),
    };

    activatedRouteMock = {
      queryParamMap: queryParamMapSubject,
      queryParams: queryParamsSubject,
      snapshot: {
        queryParamMap: convertToParamMap({ q: 'initial' }),
        queryParams: { q: 'initial' },
      } as unknown as ActivatedRouteSnapshot,
      url: new Subject(),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: routerMock },
        { provide: ActivatedRoute, useValue: activatedRouteMock },
      ],
    });
  });

  it('should read initial query param', () => {
    TestBed.runInInjectionContext(() => {
      const q = queryParam('q');
      expect(q()).toBe('initial');
    });
  });

  it('should update on navigation', () => {
    const q = TestBed.runInInjectionContext(() => queryParam('q'));

    queryParamMapSubject.next(convertToParamMap({ q: 'angular' }));
    expect(q()).toBe('angular');

    queryParamMapSubject.next(convertToParamMap({}));
    expect(q()).toBe(null);
  });

  it('should navigate on set', () => {
    const q = TestBed.runInInjectionContext(() => queryParam('q'));

    q.set('zoneless');

    expect(routerMock.navigate).toHaveBeenCalledWith([], {
      relativeTo: activatedRouteMock,
      queryParams: { q: 'zoneless' },
      queryParamsHandling: 'merge',
    });
  });

  it('should remove param on clear', () => {
    const q = TestBed.runInInjectionContext(() => queryParam('q'));

    q.set(null);

    expect(routerMock.navigate).toHaveBeenCalledWith([], {
      relativeTo: activatedRouteMock,
      queryParams: {},
      queryParamsHandling: 'merge',
    });
  });

  it('should support dynamic keys', () => {
    const keySignal = signal('q');

    const p = TestBed.runInInjectionContext(() => queryParam(keySignal));

    expect(p()).toBe('initial');

    queryParamMapSubject.next(
      convertToParamMap({ q: 'hello', filter: 'active' }),
    );
    expect(p()).toBe('hello');

    keySignal.set('filter');
    expect(p()).toBe('active');
  });
});
