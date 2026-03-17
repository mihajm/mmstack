import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  type ActivatedRouteSnapshot,
  Router,
  convertToParamMap,
} from '@angular/router';
import { of } from 'rxjs';
import { injectResolveParamLocale } from './resovler-locale';
import { TranslationStore, provideIntlConfig } from './translation-store';

describe('injectResolveParamLocale', () => {
  it('should return default store locale when config localeParamName is missing', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: { options: {} } }],
    });

    const store = TestBed.inject(TranslationStore);
    store.locale.set('en-US');

    const snapshot = {
      paramMap: convertToParamMap({}),
    } as any as ActivatedRouteSnapshot;
    TestBed.runInInjectionContext(() => {
      expect(injectResolveParamLocale(snapshot)).toBe('en-US');
    });
  });

  it('should use paramName from URL when available', () => {
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({ localeParamName: 'lang' }),
        { provide: Router, useValue: { options: {} } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({}) },
            paramMap: of(convertToParamMap({})),
          },
        },
      ],
    });

    const snapshot = {
      paramMap: convertToParamMap({ lang: 'de-DE' }),
    } as any as ActivatedRouteSnapshot;

    TestBed.runInInjectionContext(() => {
      expect(injectResolveParamLocale(snapshot)).toBe('de-DE');
    });
  });

  it('should search parent routing hierarchy for paramName', () => {
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({ localeParamName: 'lang' }),
        { provide: Router, useValue: { options: {} } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({}) },
            paramMap: of(convertToParamMap({})),
          },
        },
      ],
    });

    const snapshot = {
      paramMap: convertToParamMap({}),
      parent: {
        paramMap: convertToParamMap({ locale: 'es-ES' }),
      },
    } as any as ActivatedRouteSnapshot;

    TestBed.runInInjectionContext(() => {
      expect(injectResolveParamLocale(snapshot)).toBe('es-ES');
    });
  });

  it('should fallback to store locale if not provided in route params', () => {
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({ localeParamName: 'lang' }),
        { provide: Router, useValue: { options: {} } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({}) },
            paramMap: of(convertToParamMap({})),
          },
        },
      ],
    });

    const store = TestBed.inject(TranslationStore);
    store.locale.set('en-US');

    const snapshot = {
      paramMap: convertToParamMap({}),
    } as any as ActivatedRouteSnapshot;

    TestBed.runInInjectionContext(() => {
      expect(injectResolveParamLocale(snapshot)).toBe('en-US');
    });
  });
});
