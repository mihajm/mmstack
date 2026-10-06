import {
  DestroyRef,
  type EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core';
import { registerStrictSentinels } from './sentinel';

/**
 * Chooses how a sentinel answers a coercion for as long as the providing injector lives. Provide
 * it at the application root to make every coercion throw a `SentinelLeakError` (the law an
 * expression evaluator is proven against) instead of rendering as `[mmstack loading]` and
 * reporting once. The most recently initialized live provider wins, including an explicit
 * `false` override. Destroying injectors in any order removes only their own overrides; after
 * the last one leaves, the imperative base policy returns.
 *
 * A sentinel's `toString` has no injector to ask, so the policy itself is shared by every copy of
 * `@mmstack/primitives` in the realm; this is not injector-local isolation. Outside an injector
 * (a worker, a test) `setStrictSentinels` sets the base policy. Calls while providers are active
 * update that base without overriding the live providers.
 */
export function provideStrictSentinels(strict = true): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => {
      const destroyRef = inject(DestroyRef);
      destroyRef.onDestroy(registerStrictSentinels(strict));
    }),
  ]);
}
