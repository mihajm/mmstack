import { type HttpResourceRef } from '@angular/common/http';
import { type DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';

// refresh resource every n miliseconds or don't refresh if undefined provided. 0 also excluded, due to it not being a valid usecase
export function refresh<T>(
  resource: HttpResourceRef<T>,
  destroyRef: DestroyRef,
  refresh?: number,
): HttpResourceRef<T> {
  if (!refresh) return resource; // no refresh requested

  // we can use RxJs here as reloading the resource will always be a side effect & as such does not impact the reactive graph in any way.
  let sub = interval(refresh)
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe(() => resource.reload());

  const reload = (): boolean => {
    sub.unsubscribe(); // do not conflict with manual reload

    const hasReloaded = resource.reload();

    // resubscribe after manual reload
    sub = interval(refresh)
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(() => resource.reload());

    return hasReloaded;
  };

  return {
    ...resource,
    reload,
    destroy: () => {
      sub.unsubscribe();
      resource.destroy();
    },
  };
}
