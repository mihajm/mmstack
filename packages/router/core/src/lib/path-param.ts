import { computed, inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type ParamMap, Router } from '@angular/router';

/**
 * Creates a read-only Signal that tracks a specific route path parameter.
 *
 * Returns the parameter's current value (string) or null if absent. Reacts to navigation
 * changes and traverses parent routes to find the parameter. Supports static or dynamic
 * (function/signal) keys.
 */
export function pathParam(
  key: string | (() => string),
  route = inject(ActivatedRoute),
): Signal<string | null> {
  const keySignal =
    typeof key === 'string' ? computed(() => key) : computed(key);

  const routerOptions = inject(Router)['options'];

  if (
    routerOptions &&
    typeof routerOptions === 'object' &&
    routerOptions.paramsInheritanceStrategy === 'always'
  ) {
    const params = toSignal(route.paramMap, {
      initialValue: route.snapshot.paramMap,
    });

    return computed(() => params().get(keySignal()));
  }

  const paramMapSignals: Signal<ParamMap>[] = [];
  let currentRoute: ActivatedRoute | null = route;

  const isStatic = typeof key === 'string';

  while (currentRoute) {
    const initial = currentRoute.snapshot.paramMap;
    paramMapSignals.push(
      toSignal(currentRoute.paramMap, {
        initialValue: initial,
      }),
    );

    // For static keys, stop once we find the param, will find first in computed for loop already so basically noop for for loop
    if (isStatic && initial.has(key as string)) break;

    currentRoute = currentRoute.parent;
  }

  return computed(() => {
    const paramKey = keySignal();

    for (const map of paramMapSignals) {
      const v = map().get(paramKey);
      if (v) return v;
    }

    return null;
  });
}
