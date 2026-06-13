/* eslint-disable @typescript-eslint/no-unused-vars */
import { RouterOutlet, type RouterOutletContract } from '@angular/router';
import { TransitionRouterOutlet } from './transition-router-outlet';

/**
 * Parity probe: `TransitionRouterOutlet` extends `RouterOutlet` and overrides parts of
 * its lifecycle (`activateWith`/`deactivate`/`attach`/`detach`/`ngOnDestroy`) while
 * keeping the rest of the `RouterOutletContract` intact. This file is a TRIPWIRE — it
 * fails when Angular evolves the outlet contract or changes/removes a method the
 * subclass overrides, so the outlet can be kept in sync.
 *
 * Two layers:
 *  - **type layer** (compile-time): the full `RouterOutletContract` member set is
 *    snapshotted, and our outlet is asserted to still satisfy the contract. A new or
 *    removed contract member breaks compilation. Enforced by `tsc` / IDE / `nx build`.
 *  - **runtime layer** (`it` blocks, enforced by `nx test`): asserts every method the
 *    subclass overrides still exists on `RouterOutlet.prototype`.
 *
 * When the type layer fails: Angular changed `RouterOutletContract`. Update
 * `KnownContractKeys` below, then decide whether the new member needs handling in
 * `transition-router-outlet.ts`.
 */

// ---------------------------------------------------------------------------
// type layer
// ---------------------------------------------------------------------------

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/**
 * Snapshot of every member of `RouterOutletContract`. If Angular adds or removes a
 * member, this equality fails and forces a conscious decision about whether
 * `TransitionRouterOutlet` needs to react to it.
 */
type KnownContractKeys =
  | 'isActivated'
  | 'component'
  | 'activatedRouteData'
  | 'activatedRoute'
  | 'activateWith'
  | 'deactivate'
  | 'detach'
  | 'attach'
  | 'activateEvents'
  | 'deactivateEvents'
  | 'attachEvents'
  | 'detachEvents'
  | 'supportsBindingToComponentInputs';
type _contractUnchanged = Expect<
  Equals<keyof RouterOutletContract, KnownContractKeys>
>;

// Our outlet must remain a structurally-valid RouterOutletContract.
type _stillSatisfiesContract = Expect<
  TransitionRouterOutlet extends RouterOutletContract ? true : false
>;

// NOTE: the overridden methods (activateWith/deactivate/attach/detach/ngOnDestroy) are
// declared with `override` in transition-router-outlet.ts — TypeScript already rejects
// the override at the source if its signature stops matching RouterOutlet's, so those
// are not re-asserted here (an exact-identity check would also false-alarm on the
// base's `ComponentRef<any>` vs our `ComponentRef<unknown>`).

// ---------------------------------------------------------------------------
// runtime layer — overridden methods must still exist on the base prototype
// ---------------------------------------------------------------------------

/** RouterOutlet methods that TransitionRouterOutlet overrides and calls `super` on. */
const OVERRIDDEN_METHODS = [
  'activateWith',
  'deactivate',
  'attach',
  'detach',
  'ngOnDestroy',
] as const;

describe('TransitionRouterOutlet ↔ RouterOutlet parity', () => {
  it.each(OVERRIDDEN_METHODS)(
    'RouterOutlet.prototype still provides "%s"',
    (method) => {
      expect(
        typeof (RouterOutlet.prototype as unknown as Record<string, unknown>)[
          method
        ],
        `RouterOutlet no longer has a "${method}" method — TransitionRouterOutlet overrides it. Reconcile transition-router-outlet.ts.`,
      ).toBe('function');
    },
  );

  it('TransitionRouterOutlet is a RouterOutlet subclass', () => {
    expect(TransitionRouterOutlet.prototype).toBeInstanceOf(RouterOutlet);
  });
});
