import {
  HttpInterceptorFn,
  provideHttpClient,
  withFetch,
  withInterceptors,
} from '@angular/common/http';
import {
  ApplicationConfig,
  LOCALE_ID,
  provideExperimentalZonelessChangeDetection,
} from '@angular/core';
import { provideDateFnsAdapter } from '@angular/material-date-fns-adapter';
import { MAT_DATE_LOCALE } from '@angular/material/core';
import {
  provideClientHydration,
  withEventReplay,
  withHttpTransferCacheOptions,
} from '@angular/platform-browser';
import { provideRouter, withPreloading } from '@angular/router';
import { provideValidatorConfig } from '@mmstack/form-material';
import {
  createCacheInterceptor,
  createDedupeRequestsInterceptor,
  provideQueryCache,
} from '@mmstack/resource';
import { PreloadLinkStrategy } from '@mmstack/router-core';
import { enUS } from 'date-fns/locale';
import { DateTime } from 'luxon';
import { delay } from 'rxjs';
import { appRoutes } from './app.routes';

function createDelayInterceptor(): HttpInterceptorFn {
  return (req, next) => {
    return next(req).pipe(delay(1000));
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    {
      provide: LOCALE_ID,
      useValue: 'sl-SI',
    },
    provideClientHydration(
      withEventReplay(),
      withHttpTransferCacheOptions({
        includeHeaders: [
          'Authorization',
          'Cache-Control',
          'ETag',
          'Last-Modified',
          'Content-Range',
        ],
      }),
    ),
    provideValidatorConfig<DateTime>(
      (locale) => {
        switch (locale) {
          case 'sl-SI':
            return {
              general: {
                required: (label = 'Polje') => `${label} je obvezno`,
                not: (value) => `Ne sme biti ${value}`,
                oneOf: (value) => `Mora biti eden od: ${value}`,
                notOneOf: (value) => `Ne sme biti eden od: ${value}`,
                mustBe: (value) => `Mora biti ${value}`,
                mustBeNull: () => `Mora biti prazno`,
              },
              boolean: {
                mustBeTrue: () => `Mora biti sprejeto`,
              },
              array: {
                minLength: (min, itemLabel = 'elementov') =>
                  `Mora imeti vsaj ${min} ${itemLabel}`,
                maxLength: (max, itemLabel = 'elementov') =>
                  `Mora imeti največ ${max} ${itemLabel}`,
              },
              string: {
                email: () => `Ni veljaven e-poštni naslov`,
                uri: () => `Ni veljavna povezava`,
                trimmed: () => `Ne sme imeti začetnih ali končnih presledkov`,
                minLength: (min) => `Mora imeti vsaj ${min} znakov`,
                maxLength: (max) => `Mora imeti največ ${max} znakov`,
                isString: () => `Mora biti niz`,
                pattern: (pattern) => `Ne ustreza vzorcu ${pattern}`,
              },
              number: {
                isNumber: () => `Mora biti število`,
                integer: () => `Mora biti celo število`,
                multipleOf: (multiple) => `Mora biti deljivo z ${multiple}`,
                min: (min) => `Mora biti večje od ${min}`,
                max: (max) => `Mora biti manjše od ${max}`,
              },
              date: {
                isDate: () => `Mora biti datum`,
                min: (min) => `Mora biti po ${min}`,
                max: (max) => `Mora biti pred ${max}`,
              },
            };
          default:
            return;
        }
      },
      (d) => {
        if (typeof d === 'string') return DateTime.fromISO(d).toJSDate();
        return d.toJSDate();
      },
    ),
    provideDateFnsAdapter(),
    {
      provide: MAT_DATE_LOCALE,
      useValue: enUS,
    },
    provideExperimentalZonelessChangeDetection(),
    provideQueryCache(),
    provideHttpClient(
      withFetch(),
      withInterceptors([
        createCacheInterceptor(),
        createDedupeRequestsInterceptor(),
        createDelayInterceptor(),
      ]),
    ),
    provideRouter(appRoutes, withPreloading(PreloadLinkStrategy)),
    provideValidatorConfig(
      (locale) => {
        // switch (locale) {
        //   case 'sl-SI':
        //     return {
        //       general: {
        //         required: () => 'To polje je obvezno',
        //       },
        //     };
        //   default: {
        //     return {
        //       general: {
        //         required: (label) => `${label} is required`,
        //       },
        //     };
        //   }
        // }
      },
      // provide a custom toDate function if you're using non-date objects like Luxon's DateTime or Moment
      (date) => new Date(date),
    ),
  ],
};
