import { TestBed } from '@angular/core/testing';
import { Router, type Route, type UrlSegment } from '@angular/router';
import { canMatchLocale } from './route-helpers';
import { provideIntlConfig } from './translation-store';

describe('canMatchLocale', () => {
  it('should return true if locale is supported', () => {
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({ supportedLocales: ['en-US', 'es-ES'] }),
        { provide: Router, useValue: {} },
      ],
    });

    TestBed.runInInjectionContext(() => {
      const guard = canMatchLocale();
      const segments: UrlSegment[] = [{ path: 'es-ES', parameters: {} } as any];

      expect(guard({} as Route, segments, {} as any)).toBe(true);
    });
  });

  it('should redirect to default locale if locale is missing or unlisted', () => {
    const mockRouter = {
      createUrlTree: (commands: any[]) => commands,
    };
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          supportedLocales: ['en-US'],
          defaultLocale: 'en-US',
        }),
        { provide: Router, useValue: mockRouter },
      ],
    });

    TestBed.runInInjectionContext(() => {
      const guard = canMatchLocale();
      const segments: UrlSegment[] = [{ path: 'fr-FR', parameters: {} } as any];

      // Should return a UrlTree containing the default segment (mocked returned commands array here)
      expect(guard({} as Route, segments, {} as any)).toEqual(['en-US']);
    });
  });

  it('should account for prefixSegments before the locale parameter', () => {
    const mockRouter = {
      createUrlTree: (commands: any[]) => commands,
    };
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          supportedLocales: ['en-US', 'de-DE'],
          defaultLocale: 'en-US',
        }),
        { provide: Router, useValue: mockRouter },
      ],
    });

    TestBed.runInInjectionContext(() => {
      const guard = canMatchLocale(['app']);
      const segmentsValid: UrlSegment[] = [
        { path: 'app', parameters: {} } as any,
        { path: 'de-DE', parameters: {} } as any,
      ];
      expect(guard({} as Route, segmentsValid, {} as any)).toBe(true);

      const segmentsInvalid: UrlSegment[] = [
        { path: 'app', parameters: {} } as any,
        { path: 'it-IT', parameters: {} } as any,
      ];
      // Should return a UrlTree appending the default segment
      expect(guard({} as Route, segmentsInvalid, {} as any)).toEqual([
        'app',
        'en-US',
      ]);
    });
  });
});
