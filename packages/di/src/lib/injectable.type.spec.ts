/**
 * Type-level coverage for `injectable`'s `provide` overloads:
 * - the value form excludes functions (a function *value* must be wrapped),
 * - the no-dependency factory form needs no `deps` (the `[]` is gone),
 * - the deps factory infers its parameter types from the token tuple.
 *
 * These tests pass as long as the file compiles. `@ts-expect-error` sits on the
 * line immediately above the call it expects to fail.
 */

import { InjectionToken } from '@angular/core';
import { injectable } from './injectable';

// -----------------------------------------------------------------------------
// non-function T — value, no-dep factory, and deps factory all valid
// -----------------------------------------------------------------------------

const [, provideObj] = injectable<{ v: number }>('Obj');
const DEP = new InjectionToken<number>('DEP');

provideObj({ v: 1 }); // value → useValue
provideObj(() => ({ v: 1 })); // zero-arg factory → no `[]` needed
provideObj(() => ({ v: 1 }), []); // explicit empty deps still accepted (back-compat)
provideObj((d) => ({ v: d + 1 }), [DEP]); // deps factory: `d` infers `number`

// @ts-expect-error a multi-arg factory requires a matching deps tuple
provideObj((d: number) => ({ v: d }));

// -----------------------------------------------------------------------------
// function-typed T — the value overload collapses to `never`, so a bare
// function is read as a factory; a function VALUE must be wrapped
// -----------------------------------------------------------------------------

type Fmt = (n: string) => string;
const [, provideFmt] = injectable<Fmt>('Fmt');
const fmt: Fmt = (n) => `hi ${n}`;

// @ts-expect-error a bare function is treated as a factory — wrap a value as `() => fmt`
provideFmt(fmt);

provideFmt(() => fmt); // ok: factory returns the function value

describe('injectable provide() types', () => {
  it('compiles the type-level assertions above', () => {
    expect(true).toBe(true);
  });
});
