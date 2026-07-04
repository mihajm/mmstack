/* eslint-disable @typescript-eslint/no-unused-vars */
import { RouterOutlet, type RouterOutletContract } from '@angular/router';
import { TransitionRouterOutlet } from './transition-router-outlet';

// Tripwire: fails when Angular changes RouterOutletContract or a method the subclass
// overrides, so TransitionRouterOutlet can be kept in sync.

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

// Snapshot of every RouterOutletContract member; a change breaks the equality below.
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

type _stillSatisfiesContract = Expect<
  TransitionRouterOutlet extends RouterOutletContract ? true : false
>;

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
