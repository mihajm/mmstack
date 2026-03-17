import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { pathParam } from './path-param';
import { of } from 'rxjs';

describe('pathParam', () => {
  it('should retrieve param from current route when available', () => {
    const routeMock = {
      snapshot: { paramMap: convertToParamMap({ id: '123' }) },
      paramMap: of(convertToParamMap({ id: '123' })),
      parent: null,
    };
    
    TestBed.configureTestingModule({
      providers: [
        { provide: ActivatedRoute, useValue: routeMock },
        { provide: Router, useValue: { options: {} } }
      ]
    });

    TestBed.runInInjectionContext(() => {
      const idSignal = pathParam('id');
      expect(idSignal()).toBe('123');
    });
  });

  it('should retrieve param from parent route if not on current route', () => {
    const parentRouteMock = {
      snapshot: { paramMap: convertToParamMap({ parentId: 'abc' }) },
      paramMap: of(convertToParamMap({ parentId: 'abc' })),
      parent: null,
    };
    const routeMock = {
      snapshot: { paramMap: convertToParamMap({ id: '123' }) },
      paramMap: of(convertToParamMap({ id: '123' })),
      parent: parentRouteMock,
    };
    
    TestBed.configureTestingModule({
      providers: [
        { provide: ActivatedRoute, useValue: routeMock },
        { provide: Router, useValue: { options: {} } }
      ]
    });

    TestBed.runInInjectionContext(() => {
      const parentIdSignal = pathParam('parentId');
      expect(parentIdSignal()).toBe('abc');
    });
  });

  it('should return null if param is not found', () => {
    const routeMock = {
      snapshot: { paramMap: convertToParamMap({ id: '123' }) },
      paramMap: of(convertToParamMap({ id: '123' })),
      parent: null,
    };
    
    TestBed.configureTestingModule({
      providers: [
        { provide: ActivatedRoute, useValue: routeMock },
        { provide: Router, useValue: { options: {} } }
      ]
    });

    TestBed.runInInjectionContext(() => {
      const missingSignal = pathParam('missing');
      expect(missingSignal()).toBeNull();
    });
  });

  it('should handle paramsInheritanceStrategy = always', () => {
    const routeMock = {
      snapshot: { paramMap: convertToParamMap({ id: 'inherit' }) },
      paramMap: of(convertToParamMap({ id: 'inherit' })),
      parent: null, // parent shouldn't matter here since the router has merged them into paramMap
    };
    
    TestBed.configureTestingModule({
      providers: [
        { provide: ActivatedRoute, useValue: routeMock },
        { provide: Router, useValue: { options: { paramsInheritanceStrategy: 'always' } } }
      ]
    });

    TestBed.runInInjectionContext(() => {
      const idSignal = pathParam('id');
      expect(idSignal()).toBe('inherit');
    });
  });
});
