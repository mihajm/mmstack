/* eslint-disable @typescript-eslint/no-unused-vars */
import { provideLocationMocks } from '@angular/common/testing';
import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, RouterLink } from '@angular/router';

/**
 * Parity probe: `mmLink` (the {@link Link} directive) is a drop-in replacement for
 * Angular's `RouterLink`, forwarding every RouterLink input via `hostDirectives` and
 * delegating navigation to RouterLink's own API. This file is a TRIPWIRE — it fails
 * when Angular adds, removes, or renames a RouterLink input (or changes the members
 * mmLink relies on), so the directive can be kept in sync.
 *
 * Two layers:
 *  - **type layer** (compile-time): the relied-upon RouterLink members must keep their
 *    shape. Enforced by `tsc` / your IDE / `nx build`.
 *  - **runtime layer** (`it` blocks, enforced by `nx test`): reflects RouterLink's
 *    compiled definition and asserts the forwarded-input set matches exactly. This is
 *    the layer that catches *additions*, which the phantom `ɵdir` type params can't.
 *
 * When this fails: reconcile `FORWARDED_INPUTS` below with `Link`'s `hostDirectives`
 * in `link.ts` (and the README), then re-snapshot here.
 */

// ---------------------------------------------------------------------------
// type layer — members mmLink actively calls (not just forwards)
// ---------------------------------------------------------------------------

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

// mmLink calls `routerLink.onClick(button, ctrl, shift, alt, meta)` to delegate
// navigation. If Angular changes this signature, the cast below stops compiling.
type OnClickSig = (
  button: number,
  ctrlKey: boolean,
  shiftKey: boolean,
  altKey: boolean,
  metaKey: boolean,
) => boolean;
type _onClickUnchanged = Expect<Equals<RouterLink['onClick'], OnClickSig>>;

// mmLink reads `routerLink.urlTree` to compute the preload/serialized target.
type _urlTreeStillExists = Expect<
  'urlTree' extends keyof RouterLink ? true : false
>;

// The inputs mmLink forwards must all still exist on RouterLink (catches
// removals/renames at compile time; additions are caught by the runtime layer).
type ForwardedInputName =
  | 'routerLink'
  | 'target'
  | 'queryParams'
  | 'fragment'
  | 'queryParamsHandling'
  | 'preserveFragment'
  | 'state'
  | 'info'
  | 'relativeTo'
  | 'skipLocationChange'
  | 'replaceUrl'
  | 'browserUrl';
type _allForwardedAreRealMembers = Expect<
  ForwardedInputName extends keyof RouterLink ? true : false
>;

// ---------------------------------------------------------------------------
// runtime layer — the actual RouterLink input set vs what mmLink forwards
// ---------------------------------------------------------------------------

/**
 * RouterLink inputs forwarded by `Link`'s `hostDirectives`. The `mmLink` alias maps to
 * RouterLink's `routerLink` input, so the RouterLink-side name is `routerLink`.
 * KEEP IN SYNC with `link.ts`.
 */
const FORWARDED_INPUTS = [
  'routerLink',
  'target',
  'queryParams',
  'fragment',
  'queryParamsHandling',
  'preserveFragment',
  'state',
  'info',
  'relativeTo',
  'skipLocationChange',
  'replaceUrl',
  'browserUrl',
] as const;

/** Reads the public input names off a compiled directive/component definition. */
function readDirectiveInputs(type: unknown): string[] {
  const def = (type as { ɵdir?: { inputs?: Record<string, unknown> } }).ɵdir;
  const inputs = def?.inputs ?? {};
  return Object.entries(inputs).map(([classProp, meta]) => {
    // tolerate both the partial-declaration shape ({ publicName, ... }) and the
    // linked shapes (string publicName, or [publicName, transform] tuple)
    if (typeof meta === 'string') return meta;
    if (Array.isArray(meta)) return (meta[0] as string) ?? classProp;
    if (meta && typeof meta === 'object' && 'publicName' in meta)
      return (meta as { publicName: string }).publicName;
    return classProp;
  });
}

describe('mmLink ↔ RouterLink parity', () => {
  const routerLinkInputs = readDirectiveInputs(RouterLink);

  it('reads RouterLink inputs from its compiled definition', () => {
    // guards the reflection itself — if Angular reshapes the def, fail loudly here
    expect(routerLinkInputs.length).toBeGreaterThan(0);
  });

  it('forwards EVERY RouterLink input (catches Angular additions)', () => {
    const forwarded = new Set<string>(FORWARDED_INPUTS);
    const notForwarded = routerLinkInputs.filter((i) => !forwarded.has(i));

    expect(
      notForwarded,
      `RouterLink gained input(s) not forwarded by mmLink: [${notForwarded.join(
        ', ',
      )}]. Add them to Link's hostDirectives in link.ts and to FORWARDED_INPUTS here.`,
    ).toEqual([]);
  });

  it('does not forward inputs RouterLink no longer has (catches removals/renames)', () => {
    const actual = new Set(routerLinkInputs);
    const stale = FORWARDED_INPUTS.filter((i) => !actual.has(i));

    expect(
      stale,
      `mmLink forwards input(s) RouterLink no longer declares: [${stale.join(
        ', ',
      )}]. Remove them from link.ts and FORWARDED_INPUTS.`,
    ).toEqual([]);
  });

  it('RouterLink exposes no outputs to forward (assumption mmLink relies on)', () => {
    const def = (RouterLink as unknown as { ɵdir?: { outputs?: object } }).ɵdir;
    expect(Object.keys(def?.outputs ?? {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// behavioral layer — anchor detection (which input-reflection alone can't catch)
// ---------------------------------------------------------------------------

/**
 * `mmLink` applies RouterLink's click gating (modifier keys / target) only to anchor-like
 * hosts, replicating RouterLink's own `isAnchorElement` in `link.ts`'s `isAnchorLikeHost`.
 * That detection is internal to RouterLink (not an input), so the parity layers above can't
 * see it — Angular 22 widening it to custom elements that observe `href` slipped through.
 *
 * This TRIPWIRE pins RouterLink's *actual* behavior via its `href` reflection (it reflects an
 * `href` attribute only for anchor-like hosts). If Angular changes anchor detection again,
 * these flip — reconcile `isAnchorLikeHost` (and mmLink's gating tests) with the new shape.
 */
class ParityHrefEl extends HTMLElement {
  static readonly observedAttributes = ['href'];
}
class ParityPlainEl extends HTMLElement {}
if (!customElements.get('parity-href-el'))
  customElements.define('parity-href-el', ParityHrefEl);
if (!customElements.get('parity-plain-el'))
  customElements.define('parity-plain-el', ParityPlainEl);

@Component({
  template: `
    <a routerLink="/x" class="anchor">a</a>
    <parity-href-el routerLink="/x" class="href-el">h</parity-href-el>
    <parity-plain-el routerLink="/x" class="plain-el">p</parity-plain-el>
  `,
  imports: [RouterLink],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
class RouterLinkHosts {}

describe('RouterLink anchor detection (behavioral tripwire)', () => {
  function hrefPresent(selector: string): boolean {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideLocationMocks()],
    });
    const fixture = TestBed.createComponent(RouterLinkHosts);
    fixture.detectChanges();
    const el = (fixture.nativeElement as HTMLElement).querySelector(selector);
    return el?.hasAttribute('href') ?? false;
  }

  it('reflects href on <a> (anchor)', () => {
    expect(hrefPresent('.anchor')).toBe(true);
  });

  it('reflects href on a custom element that observes href (Angular 22 widened anchor detection)', () => {
    expect(hrefPresent('.href-el')).toBe(true);
  });

  it('does NOT reflect href on a custom element that does not observe href', () => {
    expect(hrefPresent('.plain-el')).toBe(false);
  });
});
