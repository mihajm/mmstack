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

  it('should navigate on set (synchronously, by default)', () => {
    const q = TestBed.runInInjectionContext(() => queryParam('q'));

    q.set('zoneless');

    // default: each set navigates immediately, no microtask
    expect(routerMock.navigate).toHaveBeenCalledWith([], {
      relativeTo: activatedRouteMock,
      queryParams: { q: 'zoneless' },
      queryParamsHandling: 'merge',
      replaceUrl: false,
    });
  });

  it('should remove param on clear', () => {
    const q = TestBed.runInInjectionContext(() => queryParam('q'));

    q.set(null);

    // `merge` PRESERVES absent keys — removal must patch an explicit null
    expect(routerMock.navigate).toHaveBeenCalledWith([], {
      relativeTo: activatedRouteMock,
      queryParams: { q: null },
      queryParamsHandling: 'merge',
      replaceUrl: false,
    });
  });

  it('should NOT coalesce same-tick writes by default (one navigation each)', () => {
    const [q, filter] = TestBed.runInInjectionContext(() => [
      queryParam('q'),
      queryParam('filter'),
    ]);

    q.set('signals');
    filter.set('active');

    expect(routerMock.navigate).toHaveBeenCalledTimes(2);
  });

  it('should batch same-tick writes into a single navigation when batch: true', async () => {
    const [q, filter] = TestBed.runInInjectionContext(() => [
      queryParam('q', { batch: true }),
      queryParam('filter', { batch: true, replaceUrl: true }),
    ]);

    q.set('signals');
    filter.set('active');

    // nothing yet — coalesced writes flush on a microtask
    expect(routerMock.navigate).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
    expect(routerMock.navigate).toHaveBeenCalledWith([], {
      relativeTo: activatedRouteMock,
      queryParams: { q: 'signals', filter: 'active' },
      queryParamsHandling: 'merge',
      // only skips the history entry when EVERY writer in the batch opted in
      replaceUrl: false,
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
