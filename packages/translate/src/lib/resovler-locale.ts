import { inject, untracked } from '@angular/core';
import { ActivatedRouteSnapshot, Router } from '@angular/router';
import { injectIntlConfig, TranslationStore } from './translation-store';

export function injectResolveParamLocale(snapshot: ActivatedRouteSnapshot) {
  let locale: string | null = null;

  const paramName = injectIntlConfig()?.localeParamName;

  const routerConfig = inject(Router)['options'];

  const alwaysInheritParams =
    typeof routerConfig === 'object' &&
    !!routerConfig &&
    routerConfig.paramsInheritanceStrategy === 'always';

  if (paramName) {
    locale = snapshot.paramMap.get(paramName);

    if (!locale && !alwaysInheritParams) {
      let currentRoute: ActivatedRouteSnapshot | null = snapshot;
      while (currentRoute && !locale) {
        locale = currentRoute.paramMap.get('locale');
        currentRoute = currentRoute.parent;
      }
    }
  }

  if (!locale) {
    locale = untracked(inject(TranslationStore).locale);
  }

  return locale;
}
