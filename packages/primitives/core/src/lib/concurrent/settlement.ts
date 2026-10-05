import { afterNextRender, DestroyRef, effect, untracked } from '@angular/core';
import { type CensusRegistry } from './census';
import { type CensusOptions, type DrainArm } from './census-registry';

export function censusSettled(
  census: CensusRegistry,
  options: CensusOptions = {},
): Promise<'idle' | 'error'> {
  const arm: DrainArm =
    options.arm ??
    ((check) =>
      afterNextRender(
        check,
        options.injector ? { injector: options.injector } : undefined,
      ));
  const injector = options.injector;
  if (injector === undefined) {
    return new Promise((resolve) => {
      const check = () => {
        const kind = untracked(census.foldState).kind;
        if (kind !== 'pending') resolve(kind);
        else arm(check);
      };
      arm(check);
    });
  }
  return new Promise((resolve) => {
    let confirmPending = false;
    let abandoned = false;
    const releaseDestroy = injector.get(DestroyRef).onDestroy(() => {
      abandoned = true;
    });
    const ref = effect(
      () => {
        if (census.foldState().kind === 'pending' || confirmPending) return;
        confirmPending = true;
        arm(() => {
          if (abandoned) return;
          const kind = untracked(census.foldState).kind;
          if (kind === 'pending') {
            confirmPending = false;
            return;
          }
          releaseDestroy();
          ref.destroy();
          resolve(kind);
        });
      },
      { injector },
    );
  });
}
