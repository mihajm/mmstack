import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

// Sensitive values: the pure model. A value declared sensitive is wrapped in a box that rides the
// value plane next to the absorbers (pending, error). Every reference here is verifier-owned and
// written from the design prose alone: its own box and side table, its own absorbers and ranked join
// (`value < error < pending`), its own expression hooks, its own mode flag, its own equality, and an
// independent taint oracle (a shadow-label interpreter that never constructs a box). Nothing is
// imported from the real algebra or sentinel modules; a later pass re-points these generators at them.
//
// Tags: `[PIN S…]` a law clause pinned by example; `[PROVEN]` a property of the verifier-owned model,
// checked on bounded generated inputs (house meaning: an executable assertion over a model, strong
// evidence, not a machine-checked proof); `[PREMISE]` a witness of a model decision the prose leaves
// open; `[FINDING]` a witness the prose does not predict; `[DESIGN]` a stated choice.
//
// Laws (as the prose states them, with their conditions):
// - T0 noninterference: two runs that differ only in the plain values inside boxed leaves (same
//   program, container shapes, labels and source load states; null is a leaf; over time each run
//   has its own history) give every withholding reader the same ordered trace: reports, console
//   entries, state writes with the values they overwrote, host returns, recomputes. T0 compares
//   observed traces only and never consults the label oracle. It is stated per agent principal
//   over what that principal may not see (an uncleared agent may not see any connector value).
// - Erasure: with the mode on, unboxing the result everywhere gives exactly the mode-off result:
//   values, absorbers, branches and reports; recompute counts too, except one extra recompute of a
//   dependent a label flip at equal value reaches, and draws of dynamic globals, which are a
//   function of a node's recompute count. No effect can repeat: every expression callee is
//   effect-free (the roster contract). Mode off registers no box at all.
// - T10 precision: a value derived from no labeled operand is never withheld. Erasure alone
//   admits a leaky observer; T0 alone admits boxing everything; T10 rules out the second.
// - S1 no-mint: only a declared source boxes; no hook, arrow or container produces a box from plain
//   inputs. S2 totality: a result is boxed when a boxed operand reaches it through data flow or through
//   the test position of `?:` / `&&` / `||` / `??`-left whose chosen branch is the result.
// - S3 commutation: box(pending) = pending, box(error) = error at a source; an op over {box,
//   absorber} is the ranked absorber (rank, fold and settlement untouched) and never reads an inner.
// - Labels on every hook result: a result, value or absorber, is labeled iff any operand the hook
//   scanned is labeled (top and deep stage alike), so box + absorber is a labeled absorber (a
//   pending gets a labeled twin, an error one label field). A source's own pending or error is
//   unlabeled; readers that withhold show the placeholder for a labeled absorber.
// - S5 leak guards: no coercion or inspection path of a raw box yields the inner value; strict
//   throws, soft yields the constant placeholder and reports. The box prototype is frozen.
// - S6 readers: a closed table; withholding readers (agent, telemetry, audit, console) get the
//   placeholder, clearing readers unbox; an unlisted reader is denied (placeholder). Entries (a
//   mint report, a console call) are always delivered and carry the label of their occurrence (a
//   labeled mint; inside a branch a labeled test chose; inside callbacks over a boxed receiver;
//   in `find` after the first labeled verdict; inside a host action that received a label):
//   withholding readers drop labeled entries, the display-class problems plane shows every
//   mint as a value-free entry.
// - S7 idempotence and equality upward: box(box(x)) = box(x); engine equality compares canonical
//   values and the full label tree: equal(box(a), box(b)) = equal(a, b), only the mixed case is
//   unequal, so no cached label is ever stale and readers read the cached value as it is. Two
//   mints of one error occurrence (same kind and payload fingerprint) are equal, so a re-mint
//   stops the chain at the first dependent. A per-field view's identity is the raw value its edge
//   minted it from. Canonical copies live for one evaluation, or one equality check, only.
// - Scheduling label: a recompute every trigger of which is a labeled change (a labeled producer
//   changed, a change made inside a labeled region, or a dependency only ever read inside a
//   labeled branch) is a labeled region: its recompute, mints and console calls are labeled
//   entries; a region does not label the reads it makes.
// - S11 propagation, not membership: every element read out of a boxed container is boxed (member
//   reads, map/filter/sort/find callbacks, slice, spread, keyed-container items); any hook that
//   unwraps a box and then runs user code hands boxes on.
// - Callees: compiled arrows and hooks get boxes raw; expression globals are proxied (unwrap,
//   call, rebox iff an argument was boxed; a reading global wears its reader row); every expression
//   callee is pure. Host actions get unwrapped arguments; at every exit we own, objects map back
//   by identity (the unwrapped copy of a box is the box) and everything else is labeled by
//   position when the action received a label: its return value and every state write, whatever
//   the value; a reader sees such an output whole. A state write lands in a source, so the label
//   re-enters the graph. The built-in roster contract: a host's write set and return shape do not
//   depend on argument values, nothing is retained across invocations, no capability is used
//   after its invocation returned; one alias-preserving unwrap per invocation.
// - Diagnostics are built once through a value-quote helper: a labeled value prints the
//   placeholder, and the problems plane shows that text.
// - Errors: an error minted at a sensitive source or over a boxed operand carries a boxed `cause` and
//   a boxed `renderableMessage`, hidden before the reporter sees it; its kind, origin, subclass and
//   rank are those of the mode-off error.
//
// Model decisions, decided (each pinned or exercised below):
// - coercion depth is nested lists only (`-`, `+`, `<`, `/`, `join`, `slice` start, a dynamic key);
//   `===` and `!` read the top level; a non-aware function is opaque, so a box anywhere in its
//   arguments boxes its answer and a throw inside it mints a hidden error;
// - `filter` and `sort` box the whole result when any predicate or comparator answer is boxed (the
//   desugaring of filter into `pred(x) ? [...acc, x] : acc` under the test-position rule);
// - search scans the prefix up to and including the first match; that prefix decides both
//   absorption and boxing; absorbers are checked at the top level before any deep scan;
// - an error minted with a label anywhere in its payload hides cause and message together;
// - a non-aware call unwraps its arguments deep, to one canonical reference per value per evaluation.
//
// Decisions T0 and the graph fuzz forced (named tests below, each with the variant it rejects):
// - a mint is labeled iff any operand of its hook is labeled, at the depth the hook scanned it;
// - the console row still sees a call that a labeled absorber absorbed;
// - a host's copy maps back whenever the argument holds any label (a labeled absorber too);
// - one equality check canonicalizes both sides with one memo (a value compared with itself is
//   equal even when it holds a box); an error fingerprint covers every payload field and is used
//   for equality only, never inside a payload;
// - the four refinements of the scheduling label stated above (labeled reads, transitive regions,
//   every trigger, regions do not label reads);
// - a node whose expression contains a dynamic-global call and that read a labeled dependency is
//   labeled whole (its fresh draw would otherwise tell a changed secret from an unchanged one);
//   precision (T10) excludes such nodes and what derives from them;
// - erasure holds modulo draws of dynamic globals AND every value derived from a draw;
// - an error's equality key is typed (NaN, null, undefined, a missing key and -0 all differ) and
//   label-blind; the diagnostic text adds no identity;
// - a labeled action's write re-enters the graph whole; the occurrence and destination of its
//   writes are labeled; the roster contract is the write set (not the return shape) plus nothing
//   retained across invocations and no capability after return;
// - the agent's problems view drops labeled entries (provenance survives to that egress); the
//   display's shows every entry with its text.
//
// Non-coverage (what the model abstracts, deliberately):
// - the real sentinel shape: real errors keep no cause on the object (it goes to the reporter once at
//   mint) and carry a renderable message only for compile-time constants; here both live on the
//   object so hiding is observable; `done`, origins/subclasses and the error-first join order are
//   not modeled;
// - method calls through member + invoke (`s.toUpperCase()`, a boxed receiver's method, `this`),
//   host functions beyond six named ones, aware host functions beyond four, host actions beyond
//   two (plus three gap demonstrators); an action writes only into a source, never into a node;
// - container methods beyond map/filter/find/slice/join/includes/indexOf/sort/spread/length
//   (reduce, some/every/findIndex, flat/flatMap, at, concat, with, toSpliced, lastIndexOf, a search
//   start index, destructuring beyond member reads);
//   the real search returns the first absorber in scan order, here the ranked absorber of the prefix;
//   the real sort collects every absorbing comparison, here the first one ends the sort;
// - deep absorber joins for coercing operators and non-aware calls (the real algebra joins the top
//   level only there and lets a nested sentinel reach its leak guard);
// - values: lists, `{a, b}` records and primitives; no prototypes, getters, maps, sets, dates,
//   functions as values, cycles, `-0` outside the equality generator; three sources, trees of
//   depth five, graphs of three nodes;
// - timing and hook-count channels (T0 observes readers, the reporter and withholding effects, not
//   how long or how many steps a run took); async sources, resources, template control flow
//   (`@if`/`@for`), the static labeler differential, the edge rule that strips values no reader can
//   clear, cost beyond allocation counts, two bundled copies sharing one registry, the display
//   mask; test data excluded from boxing is a flag of the edge, not modeled;
// - the sensitivity ratchet and the clearance grant and its audit (definition plane, mesh side);
// - the real container schedule (real sort runs every comparison and folds, real filter stops at
//   an absorbing verdict, real search stops at the first absorber in scan order) and the call
//   seams (a boxed target, receiver binding, repeated references at a real invoke): small
//   adversarial witnesses there come before the random suite is re-pointed;
// - host mutation of an unwrapped argument: a WHOLE box hands the host its real inner object, so a
//   mutation lands where production's would; a per-field view hands a canonical copy, so there a
//   mutation diverges (legal code never mutates: scopes are readonly);
// - concurrent principals: the posture is one per run (a session materializes at the strictest
//   clearance among its connected principals); telemetry and relay keep the shape classification
//   by ruling, not by a second label bit;
// - async hosts: an action here returns synchronously, so "until settlement" is "until return";
//   a capability used after that is the late-call violation.

const NUM_RUNS = 400;
/** T0 run counts (see the log for what each budget catches). */
const T0_RUNS = NUM_RUNS * 10;
const GRAPH_T0_RUNS = NUM_RUNS * 5;

// ---------------------------------------------------------------------------------------------
// Verifier-owned box, side table, policy
// ---------------------------------------------------------------------------------------------

const PLACEHOLDER = '[mmstack sensitive]';

type Policy = 'soft' | 'strict';

class ToyLeakError extends Error {
  constructor() {
    super('a sensitive value reached a reader that cannot clear it');
  }
}

type Entry = { value: unknown; label: boolean };
/** One ordered trace of everything observable: reports, console calls, state writes (with the value
 * they overwrote), host returns, recomputes. Each event carries the label of its occurrence. */
type TraceEvent =
  | {
      kind: 'report';
      origin: string;
      subclass: string;
      cause: unknown;
      label: boolean;
    }
  | { kind: 'console'; value: unknown; label: boolean }
  | {
      kind: 'write';
      key: string;
      value: unknown;
      overwritten: unknown;
      label: boolean;
    }
  | { kind: 'return'; value: unknown; label: boolean }
  | { kind: 'recompute'; node: number; label: boolean };
type Report = {
  origin: string;
  subclass: string;
  cause: unknown;
  label: boolean;
  /** The diagnostic text as built at the mint (placeholders for labeled values). */
  diagnostic: string;
};

const world = {
  mode: false,
  policy: 'soft' as Policy,
  /** Registrations into the box registry (every box, however it was allocated). */
  registered: 0,
  /** The unified ordered trace. */
  events: [] as TraceEvent[],
  /** Draws of dynamic globals, per node (`r` outside a graph). */
  draws: {} as Record<string, number>,
  drawNode: 'r',
  lastDraw: {} as Record<string, object>,
  replaying: false,
  /** The agent principal's clearance posture (`shape`: classification only, the default view). */
  posture: 'shape' as 'shape' | 'cleared' | 'uncleared',
  constructions: 0,
  /** Every read of an inner value through the side table, wherever it happens. */
  unboxReads: 0,
  /** Soft-policy leak reports (one per box). */
  reports: [] as string[],
  reported: new WeakSet<object>(),
  edgeCanon: true,
  /** Host effects (a counter an impure host bumps); the roster contract keeps it at zero. */
  effects: 0,
  /** Console entries as delivered: the raw argument and whether its occurrence is labeled. */
  console: [] as Entry[],
  /** The mint-time reporter channel: every mint, delivered with the label of its occurrence. */
  reporter: [] as Report[],
  /** Depth of branches chosen by a labeled test (or a host action that received a label). */
  pc: 0,
  branchPc: 0,
  /** Entries made under a labeled pc, and labeled mints, carry the label (the variant: they don't). */
  pcSuppress: true,
  /** How a host action re-labels primitives at its exits: by position (law) or by value. */
  taint: 'position' as 'position' | 'value',
  /** How an absorbing result of a hook is labeled: by any labeled operand, or plain on mixing. */
  mixing: 'labels' as 'labels' | 'plain',
  /** Error equality: by occurrence fingerprint (law) or by object identity (the killed variant). */
  errorEq: 'fingerprint' as 'fingerprint' | 'identity',
  /** Host state (engine-held), one store per run, with each value's reader-facing wholeness. */
  state: {} as Record<string, { value: unknown; whole: boolean }>,
  /** Host capability calls made after the invocation returned (a contract violation). */
  lateCalls: 0,
  /** A recompute triggered by a labeled producer's change is a labeled region (the variant: not). */
  schedLabel: true,
  /** A node that reads a labeled dependency and draws a dynamic global in one evaluation is
   * labeled whole (the variant: not): the draw is a function of the node's schedule, and the
   * schedule of its labeled dependencies. */
  drawLabel: true,
  labeledRead: false,
};

// The inner value is not an own property: it lives only in this side table, keyed by the box. Every
// read goes through `get`, which counts, so no path can read an inner value without being seen.
// The count sits on the raw table itself: no read path, wrapped or not, escapes it.
class CountingTable extends WeakMap<object, unknown> {
  override get(k: object): unknown {
    world.unboxReads++;
    return super.get(k);
  }
}
const innerTable = new CountingTable();
const inners = {
  set: (b: object, v: unknown): void => {
    world.registered++;
    innerTable.set(b, v);
  },
  has: (b: object): boolean => innerTable.has(b),
  get: (b: object): unknown => innerTable.get(b),
};

const coerced = (b: ToyBox, path: string): string => {
  if (world.policy === 'strict') throw new ToyLeakError();
  if (!world.reported.has(b)) {
    world.reported.add(b);
    world.reports.push(path);
  }
  return PLACEHOLDER;
};

/** The inspection protocol a host runtime calls to print an object (named, as `util.inspect` does). */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

class ToyBox {
  constructor(inner: unknown) {
    world.constructions++;
    inners.set(this, inner);
    Object.freeze(this);
  }
  [Symbol.toPrimitive](hint: string): string {
    return coerced(this, `toPrimitive:${hint}`);
  }
  toString(): string {
    return coerced(this, 'toString');
  }
  toJSON(): string {
    return coerced(this, 'toJSON');
  }
  [INSPECT](): string {
    return coerced(this, 'inspect');
  }
  get [Symbol.toStringTag](): string {
    return 'Sensitive';
  }
}
Object.freeze(ToyBox.prototype);

const isBox = (v: unknown): v is ToyBox =>
  typeof v === 'object' && v !== null && inners.has(v);

/** Sink-side read. */
const unbox = (v: unknown): unknown => (isBox(v) ? inners.get(v) : v);

const resetWorld = (): void => {
  world.mode = false;
  world.policy = 'soft';
  world.constructions = 0;
  world.unboxReads = 0;
  world.reports = [];
  world.reported = new WeakSet();
  world.edgeCanon = true;
  world.effects = 0;
  world.console = [];
  world.reporter = [];
  world.pc = 0;
  world.branchPc = 0;
  world.pcSuppress = true;
  world.mixing = 'labels';
  world.taint = 'position';
  world.registered = 0;
  world.events = [];
  world.draws = {};
  world.drawNode = 'r';
  world.lastDraw = {};
  world.replaying = false;
  world.posture = 'shape';
  world.errorEq = 'fingerprint';
  world.state = {};
  world.lateCalls = 0;
  world.schedLabel = true;
  world.drawLabel = true;
  world.labeledRead = false;
};

afterEach(resetWorld);

// ---------------------------------------------------------------------------------------------
// Verifier-owned absorbers and ranked join
// ---------------------------------------------------------------------------------------------

type Pending = { readonly kind: 'pending' };
type ErrorAbs = {
  readonly kind: 'error';
  readonly origin: string;
  readonly subclass: string;
  readonly cause: unknown;
  readonly renderableMessage: unknown;
  /** Present (true) only on a labeled error. */
  readonly label?: true;
  /** The diagnostic text, built once through the value-quote helper (labeled values print the
   * placeholder); this is what a display reader shows, never a deep-unboxed message. */
  readonly diagnostic: string;
};
type Absorber = Pending | ErrorAbs;

const PENDING: Pending = Object.freeze({ kind: 'pending' });
/** The labeled twin: a pending whose position would have held a boxed value. Same kind, same rank. */
const PENDING_LABELED: Pending = Object.freeze({ kind: 'pending' });
const absorberSet = new WeakSet<object>([PENDING, PENDING_LABELED]);

const isAbsorber = (v: unknown): v is Absorber =>
  typeof v === 'object' && v !== null && absorberSet.has(v);
const isPending = (v: unknown): boolean =>
  v === PENDING || v === PENDING_LABELED;
const isError = (v: unknown): v is ErrorAbs =>
  isAbsorber(v) && v.kind === 'error';
const isLabeledAbsorber = (v: unknown): boolean =>
  v === PENDING_LABELED || (isError(v) && v.label === true);
/** A labeled position: a box, or an absorber standing where a boxed value would have stood. */
const isLabeled = (v: unknown): boolean => isBox(v) || isLabeledAbsorber(v);

const rank = (v: unknown): number => (isPending(v) ? 2 : isError(v) ? 1 : 0);

/** Ranked join over absorbers: pending beats error; among errors the leftmost wins. */
const joinAbsorbers = (vs: readonly unknown[]): Absorber | undefined => {
  let best: Absorber | undefined;
  for (const v of vs)
    if (isAbsorber(v) && (!best || rank(v) > rank(best))) best = v;
  return best;
};

// A labeled copy of an error is the same occurrence wearing the label: no new mint, no report.
const unlabeledOf = new WeakMap<object, Absorber>();
const labelAbsorber = (a: Absorber): Absorber => {
  if (!world.mode || isLabeledAbsorber(a)) return a;
  if (isPending(a)) return PENDING_LABELED;
  const e = a as ErrorAbs;
  const copy: ErrorAbs = Object.freeze({ ...e, label: true as const });
  absorberSet.add(copy);
  unlabeledOf.set(copy, e);
  return copy;
};
/** The same absorber without its label, for rank and identity comparisons. */
const stripLabel = (a: unknown): unknown =>
  a === PENDING_LABELED
    ? PENDING
    : isAbsorber(a)
      ? (unlabeledOf.get(a) ?? a)
      : a;

/** The box constructor. Commutes with absorption and is idempotent. Mode off never allocates. */
const box = (v: unknown): unknown => {
  if (!world.mode || isAbsorber(v) || isBox(v)) return v;
  return new ToyBox(v);
};

/**
 * A typed key over a value for equality only: every distinction the value domain supports is kept
 * (`NaN` vs `null`, `undefined` vs a missing key, `-0`), unlike a JSON encoding. Never built into
 * a payload.
 */
const typedKey = (v: unknown): string => {
  if (v === undefined) return 'U';
  if (v === null) return 'N';
  if (typeof v === 'number') return Object.is(v, -0) ? 'n:-0' : `n:${String(v)}`;
  if (typeof v === 'string') return `s:${JSON.stringify(v)}`;
  if (typeof v === 'boolean') return `b:${String(v)}`;
  // Label-blind: the label tree is compared beside the canonical value, never inside it.
  if (isBox(v)) return typedKey(unbox(v));
  if (isAbsorber(v))
    return isPending(v) ? 'P' : `E(${errorFingerprint(v as ErrorAbs)})`;
  if (Array.isArray(v)) return `[${v.map(typedKey).join(',')}]`;
  if (isRec(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${typedKey(v[k])}`)
      .join(',')}}`;
  return `?:${String(v)}`;
};

/**
 * An error occurrence's identity for equality: origin, subclass and every payload field, typed and
 * label-blind. The diagnostic text adds nothing: a legal mint derives it from the same fields and
 * the label, so two occurrences with equal fields have equal text at equal labels.
 */
const errorFingerprint = (e: ErrorAbs): string =>
  `error:${e.origin}:${e.subclass}:${typedKey(e.cause)}:${typedKey(e.renderableMessage)}`;

/** Labels a value position: a box for a value, the labeled twin for an absorber. */
const tag = (v: unknown): unknown =>
  isAbsorber(v) ? labelAbsorber(v) : box(v);

/**
 * Error mint. With the mode on and a boxed operand (or a sensitive source), cause and message are
 * boxed BEFORE the reporter sees them. `label` marks an error whose occurrence a boxed value decided
 * (a source's own error is unlabeled). A mint inside a branch a labeled test chose is not reported.
 */
const mintError = (
  origin: string,
  subclass: string,
  cause: unknown,
  message: string,
  hide: boolean,
  label = hide,
  report = true,
  diagnostic = message,
): ErrorAbs => {
  const hiddenCause = hide ? box(cause) : cause;
  const e: ErrorAbs = Object.freeze({
    kind: 'error',
    origin,
    subclass,
    cause: hiddenCause,
    renderableMessage: hide ? box(message) : message,
    diagnostic,
    ...(label && world.mode ? { label: true as const } : {}),
  });
  absorberSet.add(e);
  // A labeled mint's occurrence was decided by a boxed value, and so was a mint under a labeled
  // branch or a labeled recompute: the report travels with that label and each reader decides
  // (withholding readers drop it, the problems plane shows a value-free entry).
  if (report) {
    const r = {
      origin,
      subclass,
      cause: hiddenCause,
      label: world.pcSuppress && (world.pc > 0 || (label && world.mode)),
    };
    world.reporter.push({ ...r, diagnostic });
    world.events.push({ kind: 'report', ...r });
  }
  return e;
};

// ---------------------------------------------------------------------------------------------
// T6 leak paths
// ---------------------------------------------------------------------------------------------

/** Wraps `v` N levels deep in alternating objects and arrays, the way app state nests. */
const nest = (v: unknown, depth: number): unknown => {
  let out = v;
  for (let i = 0; i < depth; i++)
    out = i % 2 === 0 ? { f: out, other: i } : [i, out];
  return out;
};

const LEAK_PATHS: ReadonlyArray<
  readonly [string, (b: unknown, depth: number) => unknown]
> = [
  ['String()', (b) => String(b)],
  ['template literal', (b) => `${b}`],
  ['string concat', (b) => '' + b],
  ['toString()', (b) => (b as ToyBox).toString()],
  ['Number()', (b) => Number(b)],
  ['Array join', (b) => [b, 'x'].join(',')],
  ['JSON.stringify', (b) => JSON.stringify(b)],
  ['JSON.stringify nested', (b, depth) => JSON.stringify(nest(b, depth))],
  // The host runtime's printing protocol (what `util.inspect` and devtools call).
  ['inspect protocol', (b) => (b as Record<symbol, () => unknown>)[INSPECT]()],
];

// Reflection paths: they never coerce, so no report and no throw; they must still never expose it.
const REFLECTION_PATHS: ReadonlyArray<
  readonly [string, (b: object) => unknown]
> = [
  ['Object.keys', (b) => Object.keys(b)],
  ['Reflect.ownKeys', (b) => Reflect.ownKeys(b).map(String)],
  ['own descriptors', (b) => Object.getOwnPropertyDescriptors(b)],
  ['object spread', (b) => ({ ...b })],
  ['Object.entries', (b) => Object.entries(b)],
  // The tag protocol answers a constant name, never the value.
  ['Object.prototype.toString', (b) => Object.prototype.toString.call(b)],
  // An inherited `valueOf`: a box must not answer its inner value to it.
  [
    'valueOf',
    (b) => {
      const v = (b as { valueOf: () => unknown }).valueOf();
      return v === b ? 'the box itself' : v;
    },
  ],
];

const tokenArb = fc
  .tuple(
    fc
      .array(fc.constantFrom(...'0123456789abcdef'), {
        minLength: 24,
        maxLength: 24,
      })
      .map((cs) => cs.join('')),
    fc.constantFrom('s', 'o', 'a'),
  )
  .map(([hex, shape]) => ({
    token: `tok_${hex}`,
    inner:
      shape === 's'
        ? `tok_${hex}`
        : shape === 'o'
          ? { ssn: `tok_${hex}` }
          : [`tok_${hex}`],
  }));

const stringsOf = (v: unknown): string => {
  try {
    return typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    return '';
  }
};

describe('T6 leak paths: no coercion of a raw box yields the inner value', () => {
  it('[PROVEN] soft: every coercion path yields the placeholder, one report, never the token', () => {
    fc.assert(
      fc.property(
        tokenArb,
        fc.integer({ min: 1, max: 6 }),
        ({ token, inner }, depth) => {
          for (const [, path] of LEAK_PATHS) {
            resetWorld();
            world.mode = true;
            const b = box(inner);
            expect(isBox(b)).toBe(true);
            const out = path(b, depth);
            const text =
              typeof out === 'number' ? String(out) : (out as string);
            expect(text).not.toContain(token);
            if (typeof out === 'string') expect(out).toContain(PLACEHOLDER);
            expect(world.reports).toHaveLength(1);
            // A second coercion of the same box does not report again.
            path(b, depth);
            expect(world.reports).toHaveLength(1);
            expect(world.unboxReads).toBe(0);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PROVEN] strict: every coercion path throws, and the error never carries the token', () => {
    fc.assert(
      fc.property(
        tokenArb,
        fc.integer({ min: 1, max: 6 }),
        ({ token, inner }, depth) => {
          for (const [, path] of LEAK_PATHS) {
            resetWorld();
            world.mode = true;
            world.policy = 'strict';
            const b = box(inner);
            let thrown: unknown;
            try {
              path(b, depth);
            } catch (e) {
              thrown = e;
            }
            expect(thrown).toBeInstanceOf(ToyLeakError);
            expect(String((thrown as Error).message)).not.toContain(token);
            expect(String((thrown as Error).stack ?? '')).not.toContain(token);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PROVEN] reflection and structured clone expose nothing and never report', () => {
    fc.assert(
      fc.property(tokenArb, ({ token, inner }) => {
        world.mode = true;
        const b = box(inner) as object;
        for (const [, path] of REFLECTION_PATHS)
          expect(stringsOf(path(b))).not.toContain(token);
        expect(Object.prototype.toString.call(b)).toBe('[object Sensitive]');
        expect(Object.isFrozen(ToyBox.prototype)).toBe(true);
        if (typeof structuredClone === 'function') {
          const clone = structuredClone(b);
          expect(isBox(clone)).toBe(false);
          expect(stringsOf(clone)).not.toContain(token);
        }
        expect(Object.isFrozen(b)).toBe(true);
        expect(world.reports).toHaveLength(0);
        expect(world.unboxReads).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Expression trees and plain semantics (shared by the evaluator and the oracle: these are native
// JS on plain values only; neither boxes nor labels appear here)
// ---------------------------------------------------------------------------------------------

type Plain =
  | number
  | string
  | boolean
  | null
  | undefined
  | Plain[]
  | { [k: string]: Plain };
type UnOp = '!' | '-';
type BinOp = '+' | '===' | '<' | '/';
type MemberKey = 'a' | 'b' | 0 | 'length';
/** Non-aware host functions (custom code, native methods): they receive unwrapped arguments. */
type PlainFn = 'upper' | 'add1' | 'id' | 'first' | 'parse' | 'log' | 'uuid';
/** Aware functions receive raw arguments: a compiled arrow and the absorber predicates. */
type AwareFn = 'twice' | 'isLoading' | 'isError' | 'ifLoading';

type Expr =
  | { t: 'src'; i: number }
  | { t: 'lit'; v: Plain }
  | { t: 'param' }
  | { t: 'dep'; j: number }
  | { t: 'un'; op: UnOp; a: Expr }
  | { t: 'bin'; op: BinOp; a: Expr; b: Expr }
  | { t: 'mem'; o: Expr; k: MemberKey }
  | { t: 'key'; o: Expr; k: Expr }
  | { t: 'call'; fn: PlainFn; args: Expr[] }
  | { t: 'aware'; fn: AwareFn; args: Expr[] }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr }
  | { t: 'and' | 'or' | 'coal'; a: Expr; b: Expr }
  | { t: 'arr'; es: Expr[] }
  | { t: 'obj'; a: Expr; b: Expr }
  | { t: 'map' | 'filter' | 'find'; a: Expr; body: Expr }
  | { t: 'slice'; a: Expr; s: Expr }
  | { t: 'join'; a: Expr; sep: Expr }
  | { t: 'includes' | 'indexOf'; a: Expr; x: Expr }
  | { t: 'sort'; a: Expr }
  | { t: 'spread'; a: Expr; b: Expr };

/** Coercing operators read into arrays (native coercion depth); `===` and `!` read the top only. */
const COERCING: ReadonlySet<string> = new Set(['-', '+', '<', '/']);

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !isAbsorber(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

const nativeUnary = (op: UnOp, a: unknown): unknown =>
  // Unary minus on a non-primitive goes through native coercion on purpose.
  op === '!' ? !a : -(a as number);

/** Division by zero is the one operator that mints an error (the model's "edge" for operators). */
const divByZero = (a: unknown, b: unknown): boolean =>
  b === 0 && typeof a === 'number';

const nativeBinary = (op: BinOp, a: unknown, b: unknown): unknown => {
  switch (op) {
    case '+':
      return (a as number) + (b as number);
    case '===':
      return a === b;
    case '<':
      return (a as number) < (b as number);
    case '/':
      return (a as number) / (b as number);
  }
};

const PLAIN_FNS: Record<PlainFn, (...args: unknown[]) => unknown> = {
  upper: (x) => String(x).toUpperCase(),
  add1: (x) => Number(x) + 1,
  id: (x) => x,
  first: (x) => (Array.isArray(x) ? x[0] : x),
  // A host function that throws with its input in the message, like `JSON.parse`.
  // The console global; its sink is worn by the roster wrapper (see `call`), the function is a no-op.
  log: () => undefined,
  // A dynamic global (`Id.uuid()`): no effect, but a fresh value on every evaluation by contract.
  // Draws are counted per node, so a draw is a function of that node's recompute count.
  uuid: () => {
    // The freshness oracle replays the draw a node last made (labels are what it checks).
    if (world.replaying && world.lastDraw[world.drawNode])
      return world.lastDraw[world.drawNode];
    const n = (world.draws[world.drawNode] ?? 0) + 1;
    world.draws[world.drawNode] = n;
    // A fresh object each draw: structurally the same, never the same value twice.
    const d = Object.freeze({ draw: world.drawNode });
    world.lastDraw[world.drawNode] = d;
    return d;
  },
  parse: (x) => {
    if (typeof x !== 'string' || !/^[0-9]+$/.test(x))
      throw new Error(`not a number: ${String(x)}`);
    return Number(x);
  },
};

/** The dynamic globals of the roster: effect-free, a fresh value per call by contract. */
const DYNAMIC: ReadonlySet<PlainFn> = new Set<PlainFn>(['uuid']);

/** Calls a non-aware function; a throw becomes an error sentinel carrying the thrown message. */
const callPlain = (
  fn: PlainFn,
  args: unknown[],
): { ok: true; v: unknown } | { ok: false; message: string } => {
  try {
    return { ok: true, v: PLAIN_FNS[fn](...args) };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
};

/**
 * The value-quote helper every diagnostic is built through: native string coercion, except that a
 * labeled value prints the placeholder. Built once, at the mint.
 */
const describeValue = (v: unknown): string => {
  if (isLabeled(v)) return PLACEHOLDER;
  if (isAbsorber(v)) return `[${v.kind}]`;
  if (Array.isArray(v))
    return v
      .map((x) => (x === null || x === undefined ? '' : describeValue(x)))
      .join(',');
  if (isRec(v)) return '[object Object]';
  return String(v);
};

const memberMessage = (k: unknown, o: unknown): string =>
  `cannot read ${String(k)} of ${String(o)}`;
const divideMessage = (a: unknown): string =>
  `cannot divide ${String(a)} by zero`;
const notArrayMessage = (v: unknown): string =>
  `expected a list, got ${String(v)}`;
const sourceMessage = (cause: unknown): string =>
  `request failed: ${JSON.stringify(cause)}`;

const truthy = (v: unknown): boolean => !!v;
const nullish = (v: unknown): boolean => v === null || v === undefined;

/** SameValueZero, the comparison `includes` uses; `indexOf` uses `===` (differs on NaN only). */
const sameValueZero = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === 'number' && typeof b === 'number' && a !== a && b !== b);

// ---------------------------------------------------------------------------------------------
// Source assignments: what an engine edge hands the expression (declared, never authored)
// ---------------------------------------------------------------------------------------------

type Sensitivity = 'none' | 'whole' | 'fields';
type SourceSpec =
  | {
      kind: 'value';
      v: Plain;
      sens: Sensitivity;
      /** Connector-sourced (an edge), and always-sensitive (tokens, credentials). */
      edge?: boolean;
      always?: boolean;
    }
  | { kind: 'pending' }
  | {
      kind: 'error';
      cause: Plain;
      sens: boolean;
      edge?: boolean;
      always?: boolean;
    };

/**
 * What boxes for the agent principal's posture: by shape classification (`shape`, the default and
 * what telemetry, logs and relay always use); every connector value at the edge plus the
 * classification (`uncleared`); only always-sensitive values (`cleared`: pii/phi clear for it).
 */
const effectiveSens = (s: {
  sens: Sensitivity;
  edge?: boolean;
  always?: boolean;
}): Sensitivity => {
  if (s.always) return 'whole';
  if (world.posture === 'uncleared' && s.edge) return 'whole';
  if (world.posture === 'cleared') return 'none';
  return s.sens;
};

/** Whether a source error's payload is hidden under the posture (same rule as values). */
const errorHidden = (s: {
  sens: boolean;
  edge?: boolean;
  always?: boolean;
}): boolean =>
  s.always
    ? true
    : world.posture === 'uncleared'
      ? s.sens || !!s.edge
      : world.posture === 'cleared'
        ? false
        : s.sens;

/** Materializes a source for the evaluator. Mode on: declared sensitivity boxes; mode off: never. */
const materialize = (spec: SourceSpec): unknown => {
  const s =
    spec.kind === 'value' ? { ...spec, sens: effectiveSens(spec) } : spec;
  if (s.kind === 'pending') return PENDING;
  if (s.kind === 'error') {
    const hid = errorHidden(s) && world.mode;
    return mintError(
      'source',
      'edge',
      s.cause,
      sourceMessage(s.cause),
      hid,
      // A source's own error is structure: its payload is hidden, its occurrence is not labeled.
      false,
      true,
      hid ? sourceMessage(PLACEHOLDER) : sourceMessage(s.cause),
    );
  }
  if (s.sens === 'whole') return box(s.v);
  if (s.sens === 'fields' && world.mode) {
    const raw = s.v;
    const view = Array.isArray(raw)
      ? raw.map((x) => box(x))
      : isRec(raw)
        ? Object.fromEntries(Object.entries(raw).map(([k, x]) => [k, box(x)]))
        : undefined;
    if (view === undefined) return box(raw);
    // The per-field view is a fresh container on every application; the edge registers the raw value
    // as its canonical identity so a same-reference write is not a change (pinned under T1).
    if (world.edgeCanon) edgeCanonical.set(view, raw);
    return view;
  }
  return s.v;
};

// ---------------------------------------------------------------------------------------------
// The taint oracle: a shadow-label interpreter. It runs over mode-off (plain) values and carries a
// label tree beside each value; it never constructs or inspects a box. It decides "boxed or not" from
// the prose rule: data flow, plus the test position of `?:` / `&&` / `||` / `??`-left whose chosen
// branch is the result. Containers keep per-element labels; coercing and searching answers are
// labeled iff a label sits in the coerced / scanned set; `length` of a plain list is plain.
// ---------------------------------------------------------------------------------------------

type Lab = {
  b: boolean;
  kids?: Lab[] | { [k: string]: Lab };
  hidden?: boolean;
};
type LV = { v: unknown; l: Lab };

// Whether an error hides its payload is an oracle verdict recorded per error the oracle mints.
const oracleHidden = new WeakMap<object, boolean>();
const absorberLab = (v: Absorber): Lab =>
  isError(v)
    ? { b: false, hidden: oracleHidden.get(v) ?? false }
    : { b: false };

const plainLab = (v: unknown): Lab => {
  if (isAbsorber(v)) return absorberLab(v);
  if (Array.isArray(v)) return { b: false, kids: v.map(plainLab) };
  if (isRec(v))
    return {
      b: false,
      kids: Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, plainLab(x)]),
      ),
    };
  return { b: false };
};

/** Labels a position; an absorber standing there is labeled too (it stands where a value would). */
const mark = (x: LV): LV => ({ v: x.v, l: { ...x.l, b: true } });
const markIf = (cond: boolean, x: LV): LV => (cond ? mark(x) : x);
const plainLV = (v: unknown): LV => ({ v, l: plainLab(v) });

const kidLab = (l: Lab, container: unknown, key: unknown): Lab | undefined => {
  const kids = l.kids;
  if (!kids) return undefined;
  if (Array.isArray(kids)) {
    const n = typeof key === 'number' ? key : Number(key);
    return Array.isArray(container) &&
      Number.isInteger(n) &&
      String(n) === String(key)
      ? kids[n]
      : undefined;
  }
  return Object.prototype.hasOwnProperty.call(kids, String(key))
    ? kids[String(key)]
    : undefined;
};
/** Elements of a list as labeled values; a labeled list labels every element read out of it. */
const elsOf = (x: LV): LV[] =>
  (x.v as unknown[]).map((v, i) => markIf(x.l.b, { v, l: kidsOf(x)[i] }));
const kidsOf = (x: LV): Lab[] =>
  Array.isArray(x.l.kids) ? x.l.kids : (x.v as unknown[]).map(plainLab);

/** Labeled at native coercion depth: the label itself or any element of a (nested) list. */
const labeledAtCoercion = (x: LV): boolean =>
  x.l.b ||
  (Array.isArray(x.v) &&
    (x.v as unknown[]).some((e, i) =>
      labeledAtCoercion({ v: e, l: kidsOf(x)[i] }),
    ));
const labeledAnywhere = (l: Lab): boolean =>
  l.b || (l.kids !== undefined && Object.values(l.kids).some(labeledAnywhere));

/** What a coercing read scans: the value, then the elements of a (nested) list, with labels. */
const scanAtCoercion = (x: LV): LV[] => [
  x,
  ...(Array.isArray(x.v)
    ? (x.v as unknown[]).flatMap((v, i) =>
        scanAtCoercion({ v, l: kidsOf(x)[i] }),
      )
    : []),
];
/** What an opaque callee may read: everything, through lists and records. */
const scanAnywhere = (x: LV): LV[] => [
  x,
  ...(Array.isArray(x.v)
    ? (x.v as unknown[]).flatMap((v, i) => scanAnywhere({ v, l: kidsOf(x)[i] }))
    : isRec(x.v)
      ? Object.entries(x.v).flatMap(([k, v]) =>
          scanAnywhere({ v, l: kidLab(x.l, x.v, k) ?? plainLab(v) }),
        )
      : []),
];

/**
 * The absorbing answer of a hook over the operands it scanned: the ranked winner, labeled iff any
 * scanned operand is labeled (a box, or an absorber standing in a labeled position).
 */
const absorbed = (scanned: readonly LV[]): LV | undefined => {
  const j = joinAbsorbers(scanned.map((x) => x.v));
  if (!j) return undefined;
  return { v: j, l: { ...absorberLab(j), b: scanned.some((x) => x.l.b) } };
};
const oracleError = (
  origin: string,
  subclass: string,
  cause: Plain,
  msg: string,
  hidden: boolean,
  label = hidden,
): LV => {
  const v = mintError(origin, subclass, cause, msg, false, false, false);
  oracleHidden.set(v, hidden);
  return { v, l: { b: label, hidden } };
};

type OEnv = {
  srcs: LV[];
  deps: LV[];
  param?: LV;
  /** Whether the expression contains a dynamic-global call and read a labeled dependency. */
  flags?: { drew: boolean; read: boolean };
};

const oracleSource = (spec: SourceSpec): LV => {
  const s =
    spec.kind === 'value' ? { ...spec, sens: effectiveSens(spec) } : spec;
  if (s.kind === 'pending') return plainLV(PENDING);
  if (s.kind === 'error')
    return oracleError(
      'source',
      'edge',
      s.cause,
      sourceMessage(s.cause),
      s.sens,
      false,
    );
  const x = plainLV(s.v);
  if (s.sens === 'whole') return mark(x);
  if (s.sens === 'fields' && (Array.isArray(s.v) || isRec(s.v))) {
    const kids = x.l.kids as Lab[] | Record<string, Lab>;
    const marked = Array.isArray(kids)
      ? kids.map((k) => ({ ...k, b: true }))
      : Object.fromEntries(
          Object.entries(kids).map(([k, l]) => [k, { ...l, b: true }]),
        );
    return { v: s.v, l: { b: false, kids: marked } };
  }
  return s.sens === 'fields' ? mark(x) : x;
};

const oBinary = (op: BinOp, a: LV, b: LV): LV => {
  const top = absorbed([a, b]);
  if (top) return top;
  if (COERCING.has(op)) {
    const deep = absorbed([...scanAtCoercion(a), ...scanAtCoercion(b)]);
    if (deep) return deep;
  }
  const labeled =
    op === '==='
      ? a.l.b || b.l.b
      : labeledAtCoercion(a) || labeledAtCoercion(b);
  if (op === '/' && divByZero(a.v, b.v))
    return oracleError(
      'binary',
      'divide-by-zero',
      { dividend: a.v as Plain },
      divideMessage(a.v),
      labeled,
    );
  return markIf(labeled, plainLV(nativeBinary(op, a.v, b.v)));
};

const oRead = (
  o: LV,
  k: unknown,
  keyLabeled: boolean,
  keyAnywhere = false,
): LV => {
  if (nullish(o.v))
    return oracleError(
      'member',
      'nullish',
      { key: k as Plain },
      memberMessage(k, o.v),
      o.l.b || keyLabeled || keyAnywhere,
    );
  const v = (o.v as Record<string, unknown>)[k as string];
  const l = kidLab(o.l, o.v, k) ?? plainLab(v);
  return markIf(o.l.b || keyLabeled, { v, l });
};

const oList = (x: LV, others: readonly LV[] = []): LV | undefined =>
  Array.isArray(x.v)
    ? undefined
    : oracleError(
        'container',
        'not-a-list',
        null,
        notArrayMessage(x.v),
        x.l.b,
        x.l.b || others.some(labeledAtCoercion),
      );

const oracle = (e: Expr, env: OEnv): LV => {
  const go = (x: Expr): LV => oracle(x, env);
  switch (e.t) {
    case 'src': {
      const x = env.srcs[e.i];
      if (env.flags && labeledAnywhere(x.l)) env.flags.read = true;
      return x;
    }
    case 'lit':
      return plainLV(e.v);
    case 'param':
      return env.param ?? plainLV(undefined);
    case 'dep': {
      const x = env.deps[e.j];
      if (env.flags && labeledAnywhere(x.l)) env.flags.read = true;
      return x;
    }
    case 'un': {
      const a = go(e.a);
      if (e.op === '!') return absorbed([a]) ?? markIf(a.l.b, plainLV(!a.v));
      return (
        absorbed([a]) ??
        absorbed(scanAtCoercion(a)) ??
        markIf(labeledAtCoercion(a), plainLV(nativeUnary('-', a.v)))
      );
    }
    case 'bin':
      return oBinary(e.op, go(e.a), go(e.b));
    case 'mem': {
      const o = go(e.o);
      return absorbed([o]) ?? oRead(o, e.k, false);
    }
    case 'key': {
      const o = go(e.o);
      const k = go(e.k);
      // A dynamic key goes through property-key coercion, so it is read at coercion depth.
      return (
        absorbed([o, k]) ??
        absorbed([o, ...scanAtCoercion(k)]) ??
        oRead(o, k.v, labeledAtCoercion(k), labeledAnywhere(k.l))
      );
    }
    case 'call': {
      const args = e.args.map(go);
      const abs = absorbed(args) ?? absorbed(args.flatMap(scanAnywhere));
      if (abs) return abs;
      const labeled = args.some((a) => labeledAnywhere(a.l));
      const r = callPlain(
        e.fn,
        args.map((a) => a.v),
      );
      if (!r.ok)
        return oracleError(
          'invoke',
          'threw',
          { message: r.message },
          r.message,
          labeled,
        );
      return markIf(labeled, plainLV(r.v));
    }
    case 'aware': {
      const args = e.args.map(go);
      const [x, fb] = [
        args[0] ?? plainLV(undefined),
        args[1] ?? plainLV(undefined),
      ];
      if (e.fn === 'twice') return oBinary('+', x, x);
      // A predicate over a labeled position answers labeled: its answer is that position's state.
      if (e.fn === 'isLoading') return markIf(x.l.b, plainLV(isPending(x.v)));
      if (e.fn === 'isError') return markIf(x.l.b, plainLV(isError(x.v)));
      return isPending(x.v) ? markIf(x.l.b, fb) : x;
    }
    case 'cond': {
      const c = go(e.c);
      return absorbed([c]) ?? markIf(c.l.b, truthy(c.v) ? go(e.a) : go(e.b));
    }
    case 'and':
    case 'or':
    case 'coal': {
      const a = go(e.a);
      const keepLeft =
        e.t === 'and'
          ? !truthy(a.v)
          : e.t === 'or'
            ? truthy(a.v)
            : !nullish(a.v);
      return absorbed([a]) ?? (keepLeft ? a : markIf(a.l.b, go(e.b)));
    }
    case 'arr': {
      const es = e.es.map(go);
      return {
        v: es.map((x) => x.v),
        l: { b: false, kids: es.map((x) => x.l) },
      };
    }
    case 'obj': {
      const [a, b] = [go(e.a), go(e.b)];
      return {
        v: { a: a.v, b: b.v },
        l: { b: false, kids: { a: a.l, b: b.l } },
      };
    }
    case 'map':
    case 'filter':
    case 'find': {
      const a = go(e.a);
      const bad = absorbed([a]) ?? oList(a);
      if (bad) return bad;
      const els = elsOf(a);
      if (e.t === 'find') {
        const seen: LV[] = [a];
        for (const el of els) {
          const t = oracle(e.body, { ...env, param: el });
          seen.push(t);
          if (isAbsorber(t.v)) return absorbed(seen) as LV;
          if (truthy(t.v))
            return markIf(
              seen.some((x) => x.l.b),
              el,
            );
        }
        return markIf(
          seen.some((x) => x.l.b),
          plainLV(undefined),
        );
      }
      const outs = els.map((el) => oracle(e.body, { ...env, param: el }));
      if (e.t === 'map')
        return markIf(a.l.b, {
          v: outs.map((x) => x.v),
          l: { b: false, kids: outs.map((x) => x.l) },
        });
      const abs = absorbed([a, ...outs]);
      if (abs) return abs;
      const kept = els.filter((_, i) => truthy(outs[i].v));
      const labeled = a.l.b || outs.some((t) => t.l.b);
      return markIf(labeled, {
        v: kept.map((x) => x.v),
        l: { b: false, kids: kept.map((x) => x.l) },
      });
    }
    case 'slice': {
      const [a, s] = [go(e.a), go(e.s)];
      const bad =
        absorbed([a, s]) ??
        absorbed([a, ...scanAtCoercion(s)]) ??
        oList(a, [s]);
      if (bad) return bad;
      const start = s.v as number;
      const v = (a.v as unknown[]).slice(start);
      return markIf(a.l.b || labeledAtCoercion(s), {
        v,
        l: {
          b: false,
          kids: elsOf(a)
            .map((x) => x.l)
            .slice(start),
        },
      });
    }
    case 'join': {
      const [a, sep] = [go(e.a), go(e.sep)];
      const bad = absorbed([a, sep]) ?? oList(a, [sep]);
      if (bad) return bad;
      const deep = absorbed([...scanAtCoercion(a), ...scanAtCoercion(sep)]);
      if (deep) return deep;
      return markIf(
        labeledAtCoercion(a) || labeledAtCoercion(sep),
        plainLV((a.v as unknown[]).join(sep.v as string)),
      );
    }
    case 'includes':
    case 'indexOf': {
      const [a, x] = [go(e.a), go(e.x)];
      const bad = absorbed([a, x]) ?? oList(a, [x]);
      if (bad) return bad;
      const vs = a.v as unknown[];
      const eq =
        e.t === 'includes'
          ? sameValueZero
          : (p: unknown, q: unknown) => p === q;
      const m = vs.findIndex((el) => eq(el, x.v));
      const scanned = elsOf(a).slice(0, m >= 0 ? m + 1 : vs.length);
      const abs = absorbed([a, x, ...scanned]);
      if (abs) return abs;
      const labeled = a.l.b || x.l.b || scanned.some((l) => l.l.b);
      return markIf(labeled, plainLV(e.t === 'includes' ? m >= 0 : m));
    }
    case 'sort': {
      const a = go(e.a);
      const bad = absorbed([a]) ?? oList(a);
      if (bad) return bad;
      const xs = elsOf(a);
      const seen: LV[] = [a];
      for (let i = 1; i < xs.length; i++) {
        for (let j = i; j > 0; j--) {
          const t = oBinary('<', xs[j], xs[j - 1]);
          seen.push(t);
          if (isAbsorber(t.v)) return absorbed(seen) as LV;
          if (!truthy(t.v)) break;
          [xs[j], xs[j - 1]] = [xs[j - 1], xs[j]];
        }
      }
      return markIf(
        seen.some((x) => x.l.b),
        {
          v: xs.map((x) => x.v),
          l: { b: false, kids: xs.map((x) => x.l) },
        },
      );
    }
    case 'spread': {
      const [a, b] = [go(e.a), go(e.b)];
      const bad = absorbed([a, b]) ?? oList(a, [b]) ?? oList(b, [a]);
      if (bad) return bad;
      return markIf(a.l.b || b.l.b, {
        v: [...(a.v as unknown[]), ...(b.v as unknown[])],
        l: { b: false, kids: [...elsOf(a), ...elsOf(b)].map((x) => x.l) },
      });
    }
  }
};

// ---------------------------------------------------------------------------------------------
// The evaluator: boxes ride the value plane. Each hook: absorber check first, then one box branch
// (unwrap the boxed operands, apply, rebox). Engine equality compares canonical values only.
// ---------------------------------------------------------------------------------------------

// `labeled`: the engine's equality (canonical values and the full label tree). `blind` (canonical
// values only, the reader pulls labels) and `identity` are the killed alternatives, kept so named
// tests can show what they break.
type Ctx = {
  hooks: Record<string, number>;
  trace: string[];
  equality: 'blind' | 'labeled' | 'identity';
  memo?: WeakMap<object, unknown>;
  /** Every argument handed to an outermost callback (an observation point for propagation). */
  params?: unknown[];
};
const newCtx = (): Ctx => ({ hooks: {}, trace: [], equality: 'labeled' });
const hook = (ctx: Ctx, name: string): void => {
  ctx.hooks[name] = (ctx.hooks[name] ?? 0) + 1;
};

const shallow = (v: unknown): unknown => (isBox(v) ? unbox(v) : v);

// A per-field view's canonical identity is the raw value the edge minted it from (registered at the
// edge, not computed). Everything else is canonicalized per evaluation only: no cache survives
// between evaluations, so a value mutated in between is canonicalized afresh.
const edgeCanonical = new WeakMap<object, unknown>();
let activeMemo: WeakMap<object, unknown> | undefined;

// Engine-internal canonical view: boxes replaced by their inners, deep, copy-on-write, memoized
// within one evaluation so a value has one canonical reference there. This keeps `===` and search
// identity-faithful when a non-aware function hands back an unwrapped copy of an argument.
const canon = (
  v: unknown,
  memo = activeMemo ?? new WeakMap<object, unknown>(),
  forEquality = false,
): unknown => {
  if (isBox(v)) return canon(unbox(v), memo, forEquality);
  // A labeled absorber is the same occurrence: equality never sees labels. Two mints of one
  // occurrence (same kind and cause fingerprint) are the same value: errors are value-free.
  // Only for equality: a fingerprint reads the hidden cause, it must never enter a payload.
  if (forEquality && isError(v) && world.errorEq === 'fingerprint')
    return errorFingerprint(v);
  if (isAbsorber(v)) return stripLabel(v);
  if (typeof v !== 'object' || v === null) return v;
  const edge = edgeCanonical.get(v);
  if (edge !== undefined) return edge;
  const hit = memo.get(v);
  if (hit !== undefined) return hit;
  let out: unknown = v;
  if (Array.isArray(v)) {
    const kids = v.map((x) => canon(x, memo, forEquality));
    if (kids.some((k, i) => k !== v[i])) out = kids;
  } else if (isRec(v)) {
    const entries = Object.entries(v).map(
      ([k, x]) => [k, canon(x, memo, forEquality)] as const,
    );
    if (entries.some(([k, x]) => x !== v[k])) out = Object.fromEntries(entries);
  }
  memo.set(v, out);
  return out;
};

const boxedAtCoercion = (v: unknown): boolean =>
  isBox(v) || (Array.isArray(v) && v.some(boxedAtCoercion));
const boxedAnywhere = (v: unknown): boolean =>
  isBox(v) ||
  (Array.isArray(v)
    ? v.some(boxedAnywhere)
    : isRec(v) && Object.values(v).some(boxedAnywhere));
// Labels (boxes or labeled absorbers) at a scan depth; a box answers without reading its inner.
const labeledThrough = (v: unknown, objects: boolean): boolean =>
  isLabeled(v) ||
  (Array.isArray(v)
    ? v.some((x) => labeledThrough(x, objects))
    : objects &&
      isRec(v) &&
      Object.values(v).some((x) => labeledThrough(x, objects)));

// Absorber scans at coercion depth look through boxes: a boxed list may hold a skeleton row.
const absorbersThrough = (v: unknown, objects: boolean): unknown[] =>
  isAbsorber(v)
    ? [v]
    : isBox(v)
      ? absorbersThrough(unbox(v), objects)
      : Array.isArray(v)
        ? v.flatMap((x) => absorbersThrough(x, objects))
        : objects && isRec(v)
          ? Object.values(v).flatMap((x) => absorbersThrough(x, objects))
          : [];

/**
 * The absorbing answer of a hook: the ranked winner over what it scanned, labeled iff anything it
 * scanned is labeled. The `plain` variant keeps only the winner's own label.
 */
const absorbedE = (
  absorbers: readonly unknown[],
  labeled: boolean,
): unknown => {
  const j = joinAbsorbers(absorbers);
  if (!j) return undefined;
  return world.mixing === 'labels' && labeled ? labelAbsorber(j) : j;
};
const absorbedTop = (vs: readonly unknown[]): unknown =>
  absorbedE(vs, vs.some(isLabeled));

const rebox = (cond: boolean, v: unknown): unknown => (cond ? tag(v) : v);

/**
 * Propagation, not membership: every element read out of a boxed list is handed on labeled, so no
 * hook that unwraps a box and then runs user code (or returns the elements) lets a plain value out.
 */
const handOn = (a: unknown, xs: readonly unknown[]): unknown[] =>
  isBox(a) ? xs.map(tag) : xs.slice();

/** Runs a branch a labeled test chose: withholding effects inside it are dropped. */
const underPc = <T>(labeled: boolean, run: () => T, region = false): T => {
  if (!labeled) return run();
  world.pc++;
  // A labeled branch also makes the reads inside it labeled dependencies; a labeled recompute
  // region does not (its public reads are the ones the other run made the last time).
  if (!region) world.branchPc++;
  try {
    return run();
  } finally {
    world.pc--;
    if (!region) world.branchPc--;
  }
};

/** The console sink, as the proxied console global wears it: its reader row, then the log. */
const consoleSink = (v: unknown): void => {
  const e = { value: v, label: world.pcSuppress && world.pc > 0 };
  world.console.push(e);
  world.events.push({ kind: 'console', ...e });
};

/** What the console (a withholding reader) shows: labeled entries dropped, values through its row. */
const consoleView = (): unknown[] =>
  world.console.filter((e) => !e.label).map((e) => readAs('console', e.value));
/** What telemetry shows of the reporter channel: labeled reports dropped entirely. */
const telemetryReports = (): unknown[] =>
  world.reporter
    .filter((r) => !r.label)
    .map((r) =>
      readAs('telemetry', {
        origin: r.origin,
        subclass: r.subclass,
        cause: r.cause,
      }),
    );
/**
 * The problems plane as a reader sees it: display (clear) shows every mint with its diagnostic
 * text as built once at the mint; a withholding reader (the agent) never sees a labeled entry,
 * because provenance survives the projection to the principal's egress.
 */
const problemsViewFor = (reader: Reader): unknown[] =>
  world.reporter
    .filter((r) => CLEARANCE[reader] === 'clear' || !r.label)
    .map((r) => ({
      origin: r.origin,
      subclass: r.subclass,
      message: r.diagnostic,
    }));
/** The problems plane (display). */
const problemsView = (): unknown[] => problemsViewFor('display');

const strictUnary = (ctx: Ctx, op: UnOp, a: unknown): unknown => {
  hook(ctx, 'un');
  const abs =
    absorbedTop([a]) ??
    (op === '-'
      ? absorbedE(absorbersThrough(a, false), labeledThrough(a, false))
      : undefined);
  if (abs) return abs;
  if (op === '!') return rebox(isBox(a), !shallow(a));
  return rebox(boxedAtCoercion(a), nativeUnary('-', canon(a)));
};

const strictBinary = (ctx: Ctx, op: BinOp, a: unknown, b: unknown): unknown => {
  hook(ctx, 'bin');
  const top = absorbedTop([a, b]);
  if (top) return top;
  if (COERCING.has(op)) {
    const deep = absorbedE(
      [...absorbersThrough(a, false), ...absorbersThrough(b, false)],
      labeledThrough(a, false) || labeledThrough(b, false),
    );
    if (deep) return deep;
  }
  const boxed =
    op === '==='
      ? isBox(a) || isBox(b)
      : boxedAtCoercion(a) || boxedAtCoercion(b);
  const [ca, cb] = [canon(a), canon(b)];
  if (op === '/' && divByZero(ca, cb))
    return mintError(
      'binary',
      'divide-by-zero',
      { dividend: ca },
      divideMessage(ca),
      boxed,
      boxed,
      true,
      divideMessage(describeValue(a)),
    );
  return rebox(boxed, nativeBinary(op, ca, cb));
};

const memberRead = (o: unknown, k: unknown, keyBoxed: boolean): unknown => {
  const inner = shallow(o);
  const ck = canon(k);
  // The cause carries the key structurally, so a label anywhere in it (a box, or an absorber in a
  // labeled position) hides the payload, not only a box at coercion depth.
  const hide = isBox(o) || keyBoxed || labeledThrough(k, true);
  if (nullish(inner))
    return mintError(
      'member',
      'nullish',
      { key: ck },
      memberMessage(ck, inner),
      hide,
      hide,
      true,
      memberMessage(describeValue(k), describeValue(o)),
    );
  return rebox(
    isBox(o) || keyBoxed,
    (inner as Record<string, unknown>)[ck as string],
  );
};

/**
 * The structural check of a list hook. The mint is labeled when the receiver is boxed OR any other
 * operand is labeled: that operand's being a value rather than an absorber is what let the hook get
 * this far, so the error's occurrence is as secret as that operand.
 */
const listOf = (
  a: unknown,
  others: readonly unknown[] = [],
): unknown[] | ErrorAbs => {
  const inner = shallow(a);
  return Array.isArray(inner)
    ? inner
    : mintError(
        'container',
        'not-a-list',
        null,
        notArrayMessage(canon(a)),
        isBox(a),
        isBox(a) || others.some((o) => labeledThrough(o, false)),
        true,
        notArrayMessage(describeValue(a)),
      );
};

type EEnv = { srcs: unknown[]; deps: unknown[]; param?: unknown };

/** One evaluation: its canonical memo lives exactly as long as the evaluation. */
/**
 * Whether an expression contains a dynamic-global call at all. Static on purpose: whether a draw
 * HAPPENED can follow a secret (`secret && uuid()`), and a label decided by that would leak it.
 */
const dynamicIn = new WeakMap<object, boolean>();
const hasDynamic = (e: unknown): boolean => {
  if (typeof e !== 'object' || e === null) return false;
  const memo = dynamicIn.get(e);
  if (memo !== undefined) return memo;
  const r =
    ((e as { t?: unknown }).t === 'call' &&
      DYNAMIC.has((e as { fn: PlainFn }).fn)) ||
    Object.values(e).some(hasDynamic);
  dynamicIn.set(e, r);
  return r;
};

const evaluate = (e: Expr, env: EEnv, ctx: Ctx): unknown => {
  if (ctx.memo) return evalNode(e, env, ctx);
  const prev = activeMemo;
  const prevRead = world.labeledRead;
  world.labeledRead = false;
  ctx.memo = activeMemo = new WeakMap();
  try {
    const v = evalNode(e, env, ctx);
    // A node whose expression draws a dynamic global and that read a labeled dependency is labeled
    // whole: its draw is fresh exactly when its schedule ran, and that schedule follows the labeled
    // dependency. (A labeled read inside a secret-chosen branch is already labeled whole by the implicit-flow rule.)
    return world.mode && world.drawLabel && hasDynamic(e) && world.labeledRead
      ? tag(v)
      : v;
  } finally {
    activeMemo = prev;
    ctx.memo = undefined;
    world.labeledRead = prevRead;
  }
};

const evalNode = (e: Expr, env: EEnv, ctx: Ctx): unknown => {
  const go = (x: Expr): unknown => evaluate(x, env, ctx);
  switch (e.t) {
    case 'src': {
      const v = env.srcs[e.i];
      if (labeledThrough(v, true)) world.labeledRead = true;
      return v;
    }
    case 'lit':
      return e.v;
    case 'param':
      return env.param;
    case 'dep': {
      const v = env.deps[e.j];
      if (labeledThrough(v, true)) world.labeledRead = true;
      return v;
    }
    case 'un':
      return strictUnary(ctx, e.op, go(e.a));
    case 'bin':
      return strictBinary(ctx, e.op, go(e.a), go(e.b));
    case 'mem': {
      hook(ctx, 'mem');
      const o = go(e.o);
      return absorbedTop([o]) ?? memberRead(o, e.k, false);
    }
    case 'key': {
      hook(ctx, 'key');
      const [o, k] = [go(e.o), go(e.k)];
      return (
        absorbedTop([o, k]) ??
        // The deep stage scanned the top operands too: their labels count.
        absorbedE(
          absorbersThrough(k, false),
          isLabeled(o) || labeledThrough(k, false),
        ) ??
        memberRead(o, k, boxedAtCoercion(k))
      );
    }
    case 'call': {
      hook(ctx, 'call');
      const args = e.args.map(go);
      // Top-level absorbers first: the deep scan looks through boxes, which an op over
      // {box, absorber} must never do.
      const abs =
        absorbedTop(args) ??
        absorbedE(
          args.flatMap((a) => absorbersThrough(a, true)),
          args.some((a) => labeledThrough(a, true)),
        );
      // The console global wears its reader row inside the roster wrapper: it sees the raw box. A
      // call absorbed by a labeled absorber still reaches the row: whether the call was absorbed is
      // as secret as the value that would have stood there, and the row shows a placeholder either way.
      if (e.fn === 'log' && (abs === undefined || isLabeledAbsorber(abs)))
        consoleSink(args[0]);
      if (abs) return abs;
      const boxed = args.some(boxedAnywhere);
      const r = callPlain(
        e.fn,
        args.map((a) => canon(a)),
      );
      if (!r.ok)
        return mintError(
          'invoke',
          'threw',
          { message: r.message },
          r.message,
          boxed,
          boxed,
          true,
          // A host's own message is built from unwrapped values: it cannot be quoted, only replaced.
          boxed ? 'a host function threw' : r.message,
        );
      return rebox(boxed, r.v);
    }
    case 'aware': {
      hook(ctx, 'aware');
      const [x, fb] = e.args.map(go);
      if (e.fn === 'twice') return strictBinary(ctx, '+', x, x);
      // A predicate over a labeled position answers labeled: its answer is that position's state.
      if (e.fn === 'isLoading') return rebox(isLabeled(x), isPending(x));
      if (e.fn === 'isError') return rebox(isLabeled(x), isError(x));
      return isPending(x) ? rebox(isLabeled(x), fb) : x;
    }
    case 'cond': {
      hook(ctx, 'cond');
      const c = go(e.c);
      if (isAbsorber(c)) return c;
      const pick = truthy(shallow(c));
      ctx.trace.push(`cond:${pick}`);
      return rebox(
        isBox(c),
        underPc(isBox(c), () => (pick ? go(e.a) : go(e.b))),
      );
    }
    case 'and':
    case 'or':
    case 'coal': {
      hook(ctx, e.t);
      const a = go(e.a);
      if (isAbsorber(a)) return a;
      const t = shallow(a);
      const keepLeft =
        e.t === 'and' ? !truthy(t) : e.t === 'or' ? truthy(t) : !nullish(t);
      ctx.trace.push(`${e.t}:${keepLeft}`);
      return keepLeft
        ? a
        : rebox(
            isBox(a),
            underPc(isBox(a), () => go(e.b)),
          );
    }
    case 'arr':
      return e.es.map(go);
    case 'obj':
      return { a: go(e.a), b: go(e.b) };
    case 'map':
    case 'filter':
    case 'find': {
      hook(ctx, e.t);
      const a = go(e.a);
      if (isAbsorber(a)) return a;
      const xs = listOf(a);
      if (!Array.isArray(xs)) return xs;
      // Unwrapped elements would let an error minted inside the arrow escape the box through
      // absorption with a plain payload.
      const els = handOn(a, xs);
      // How many callbacks run is the boxed list's length: a secret when the receiver is boxed.
      const pcList = isBox(a);
      if (e.t === 'find') {
        let labeled = isBox(a);
        let verdictLabeled = pcList;
        for (const el of els) {
          // Whether this callback runs at all was decided by the earlier verdicts.
          const t = underPc(verdictLabeled, () =>
            evaluate(
              e.body,
              {
                ...env,
                param: (env.param === undefined && ctx.params?.push(el), el),
              },
              ctx,
            ),
          );
          if (isAbsorber(t)) return absorbedE([t], labeled || isLabeled(t));
          labeled ||= isBox(t);
          verdictLabeled ||= isBox(t);
          const hit = truthy(shallow(t));
          ctx.trace.push(`find:${hit}`);
          if (hit) return rebox(labeled, el);
        }
        return rebox(labeled, undefined);
      }
      const outs = underPc(pcList, () =>
        els.map((el) =>
          evaluate(
            e.body,
            {
              ...env,
              param: (env.param === undefined && ctx.params?.push(el), el),
            },
            ctx,
          ),
        ),
      );
      if (e.t === 'map') return rebox(isBox(a), outs);
      const abs = absorbedE(outs, isBox(a) || outs.some(isLabeled));
      if (abs) return abs;
      const keep = outs.map((t) => truthy(shallow(t)));
      ctx.trace.push(`filter:${keep.join(',')}`);
      return rebox(
        isBox(a) || outs.some(isBox),
        els.filter((_, i) => keep[i]),
      );
    }
    case 'slice': {
      hook(ctx, 'slice');
      const [a, s] = [go(e.a), go(e.s)];
      const abs =
        absorbedTop([a, s]) ??
        absorbedE(
          absorbersThrough(s, false),
          isLabeled(a) || labeledThrough(s, false),
        );
      if (abs) return abs;
      const xs = listOf(a, [s]);
      if (!Array.isArray(xs)) return xs;
      return rebox(
        isBox(a) || boxedAtCoercion(s),
        handOn(a, xs).slice(canon(s) as number),
      );
    }
    case 'join': {
      hook(ctx, 'join');
      const [a, sep] = [go(e.a), go(e.sep)];
      const top = absorbedTop([a, sep]);
      if (top) return top;
      const xs = listOf(a, [sep]);
      if (!Array.isArray(xs)) return xs;
      const deep = absorbedE(
        [...absorbersThrough(a, false), ...absorbersThrough(sep, false)],
        labeledThrough(a, false) || labeledThrough(sep, false),
      );
      if (deep) return deep;
      return rebox(
        boxedAtCoercion(a) || boxedAtCoercion(sep),
        (canon(a) as unknown[]).join(canon(sep) as string),
      );
    }
    case 'includes':
    case 'indexOf': {
      hook(ctx, e.t);
      const [a, x] = [go(e.a), go(e.x)];
      const top = absorbedTop([a, x]);
      if (top) return top;
      const xs = listOf(a, [x]);
      if (!Array.isArray(xs)) return xs;
      const cx = canon(x);
      const eq =
        e.t === 'includes'
          ? sameValueZero
          : (p: unknown, q: unknown) => p === q;
      const m = xs.findIndex((el) => eq(canon(el), cx));
      const scanned = handOn(a, xs).slice(0, m >= 0 ? m + 1 : xs.length);
      const labeled = isBox(a) || isBox(x) || scanned.some(isLabeled);
      const abs = absorbedE(scanned, labeled);
      if (abs) return abs;
      return rebox(labeled, e.t === 'includes' ? m >= 0 : m);
    }
    case 'sort': {
      hook(ctx, 'sort');
      const a = go(e.a);
      if (isAbsorber(a)) return a;
      const src = listOf(a);
      if (!Array.isArray(src)) return src;
      const xs = handOn(a, src);
      let labeled = isBox(a);
      for (let i = 1; i < xs.length; i++) {
        for (let j = i; j > 0; j--) {
          const t = strictBinary(ctx, '<', xs[j], xs[j - 1]);
          if (isAbsorber(t)) return absorbedE([t], labeled || isLabeled(t));
          labeled ||= isBox(t);
          const swap = truthy(shallow(t));
          ctx.trace.push(`sort:${swap}`);
          if (!swap) break;
          [xs[j], xs[j - 1]] = [xs[j - 1], xs[j]];
        }
      }
      return rebox(labeled, xs);
    }
    case 'spread': {
      hook(ctx, 'spread');
      const [a, b] = [go(e.a), go(e.b)];
      const top = absorbedTop([a, b]);
      if (top) return top;
      const xa = listOf(a, [b]);
      if (!Array.isArray(xa)) return xa;
      const xb = listOf(b, [a]);
      if (!Array.isArray(xb)) return xb;
      return rebox(isBox(a) || isBox(b), [...handOn(a, xa), ...handOn(b, xb)]);
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Generators and runners
// ---------------------------------------------------------------------------------------------

const N_SRC = 3;
const PLAIN0: SourceSpec = { kind: 'value', v: 0, sens: 'none' };

const valueArb: fc.Arbitrary<Plain> = fc.letrec<{ v: Plain }>((tie) => ({
  v: fc.oneof(
    { maxDepth: 2, depthSize: 'small' },
    fc.constantFrom<Plain>(
      0,
      1,
      2,
      -1,
      'a',
      'b',
      '',
      '12',
      true,
      false,
      null,
      undefined,
    ),
    fc.array(tie('v'), { maxLength: 3 }),
    fc.record({ a: tie('v'), b: tie('v') }, { noNullPrototype: true }),
  ),
})).v;

const sourceArb: fc.Arbitrary<SourceSpec> = fc.oneof(
  {
    weight: 7,
    arbitrary: fc.record({
      kind: fc.constant('value' as const),
      v: valueArb,
      sens: fc.constantFrom<Sensitivity>('none', 'whole', 'fields'),
      edge: fc.boolean(),
      always: fc.constantFrom(false, false, false, true),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'pending' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('error' as const),
      cause: valueArb,
      sens: fc.boolean(),
    }),
  },
);
const sourcesArb = fc.array(sourceArb, { minLength: N_SRC, maxLength: N_SRC });
const plainSourcesArb = fc.array(
  fc.oneof(
    {
      weight: 7,
      arbitrary: valueArb.map((v): SourceSpec => ({
        kind: 'value',
        v,
        sens: 'none',
      })),
    },
    { weight: 1, arbitrary: fc.constant<SourceSpec>({ kind: 'pending' }) },
    {
      weight: 1,
      arbitrary: valueArb.map((cause): SourceSpec => ({
        kind: 'error',
        cause,
        sens: false,
      })),
    },
  ),
  { minLength: N_SRC, maxLength: N_SRC },
);

const exprArb = (deps: number): fc.Arbitrary<Expr> =>
  fc.letrec<{ e: Expr }>((tie) => {
    const e = tie('e');
    const leaves: fc.Arbitrary<Expr>[] = [
      fc
        .integer({ min: 0, max: N_SRC - 1 })
        .map((i): Expr => ({ t: 'src', i })),
      valueArb.map((v): Expr => ({ t: 'lit', v })),
      fc.constant<Expr>({ t: 'param' }),
    ];
    if (deps > 0)
      leaves.push(
        fc
          .integer({ min: 0, max: deps - 1 })
          .map((j): Expr => ({ t: 'dep', j })),
      );
    const two = <T extends string>(ts: T[]) =>
      fc.record({ t: fc.constantFrom(...ts), a: e, b: e });
    return {
      e: fc.oneof(
        { maxDepth: 5, depthSize: 'small' },
        fc.oneof(...leaves),
        fc.record({
          t: fc.constant('un' as const),
          op: fc.constantFrom<UnOp>('!', '-'),
          a: e,
        }),
        fc.record({
          t: fc.constant('bin' as const),
          op: fc.constantFrom<BinOp>('+', '===', '<', '/'),
          a: e,
          b: e,
        }),
        fc.record({
          t: fc.constant('mem' as const),
          o: e,
          k: fc.constantFrom<MemberKey>('a', 'b', 0, 'length'),
        }),
        fc.record({ t: fc.constant('key' as const), o: e, k: e }),
        fc.record({
          t: fc.constant('call' as const),
          fn: fc.constantFrom<PlainFn>(
            'upper',
            'add1',
            'id',
            'first',
            'parse',
            'uuid',
            'log',
          ),
          args: fc.array(e, { minLength: 1, maxLength: 2 }),
        }),
        fc.record({
          t: fc.constant('aware' as const),
          fn: fc.constantFrom<AwareFn>(
            'twice',
            'isLoading',
            'isError',
            'ifLoading',
          ),
          args: fc.array(e, { minLength: 2, maxLength: 2 }),
        }),
        fc.record({ t: fc.constant('cond' as const), c: e, a: e, b: e }),
        two(['and', 'or', 'coal']),
        fc.record({
          t: fc.constant('arr' as const),
          es: fc.array(e, { maxLength: 3 }),
        }),
        fc.record({ t: fc.constant('obj' as const), a: e, b: e }),
        fc.record({
          t: fc.constantFrom(
            'map' as const,
            'filter' as const,
            'find' as const,
          ),
          a: e,
          body: e,
        }),
        fc.record({ t: fc.constant('slice' as const), a: e, s: e }),
        fc.record({ t: fc.constant('join' as const), a: e, sep: e }),
        fc.record({
          t: fc.constantFrom('includes' as const, 'indexOf' as const),
          a: e,
          x: e,
        }),
        fc.record({ t: fc.constant('sort' as const), a: e }),
        two(['spread']),
      ) as fc.Arbitrary<Expr>,
    };
  }).e;

type Run = {
  v: unknown;
  ctx: Ctx;
  constructions: number;
  /** Registrations into the box registry, however the holder was allocated. */
  registered: number;
  effects: number;
};

const run = (
  tree: Expr,
  specs: readonly SourceSpec[],
  mode: boolean,
  equality: Ctx['equality'] = 'labeled',
): Run => {
  const before = world.constructions;
  const registered = world.registered;
  const effects = world.effects;
  world.mode = mode;
  world.draws = {};
  world.drawNode = 'r';
  try {
    const srcs = specs.map(materialize);
    const ctx = { ...newCtx(), equality };
    const v = evaluate(tree, { srcs, deps: [] }, ctx);
    return {
      v,
      ctx,
      constructions: world.constructions - before,
      registered: world.registered - registered,
      effects: world.effects - effects,
    };
  } finally {
    world.mode = false;
  }
};

const runOracle = (tree: Expr, specs: readonly SourceSpec[]): LV => {
  world.draws = {};
  world.drawNode = 'r';
  const flags = { drew: hasDynamic(tree), read: false };
  const r = oracle(tree, { srcs: specs.map(oracleSource), deps: [], flags });
  return world.drawLabel && flags.drew && flags.read ? mark(r) : r;
};

/** Box positions of an evaluator result, in the oracle's label encoding. */
const positions = (v: unknown): Lab => {
  if (isError(v)) return { b: v.label === true, hidden: isBox(v.cause) };
  if (isPending(v)) return { b: v === PENDING_LABELED };
  const inner = shallow(v);
  const b = isBox(v);
  if (Array.isArray(inner)) return { b, kids: inner.map(positions) };
  if (isRec(inner))
    return {
      b,
      kids: Object.fromEntries(
        Object.entries(inner).map(([k, x]) => [k, positions(x)]),
      ),
    };
  return { b };
};

/** Every box removed, deep, including error payloads: the erasure map. */
const unboxAll = (v: unknown): unknown => {
  if (isBox(v)) return unboxAll(unbox(v));
  if (isPending(v)) return PENDING;
  if (isError(v))
    return {
      kind: 'error',
      origin: v.origin,
      subclass: v.subclass,
      cause: unboxAll(v.cause),
      renderableMessage: unboxAll(v.renderableMessage),
    };
  if (Array.isArray(v)) return v.map(unboxAll);
  if (isRec(v))
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, unboxAll(x)]),
    );
  return v;
};

/** Any box or labeled absorber anywhere, error payloads included. */
const containsBox = (v: unknown): boolean =>
  isBox(v) ||
  isLabeledAbsorber(v) ||
  (isError(v) && (containsBox(v.cause) || containsBox(v.renderableMessage))) ||
  (Array.isArray(v)
    ? v.some(containsBox)
    : isRec(v) && Object.values(v).some(containsBox));

// ---------------------------------------------------------------------------------------------
// T2 totality: box positions = oracle labels
// ---------------------------------------------------------------------------------------------

describe('native semantics anchors (an independent expectation, not a differential)', () => {
  // T1 and T2 compare the evaluator with itself and with an oracle that shares native operators;
  // these literals pin the operators themselves.
  const ANCHORS: ReadonlyArray<readonly [Expr, unknown]> = [
    [{ t: 'bin', op: '+', a: { t: 'lit', v: 1 }, b: { t: 'lit', v: 2 } }, 3],
    [
      {
        t: 'bin',
        op: '+',
        a: { t: 'lit', v: [1, [2]] },
        b: { t: 'lit', v: 'x' },
      },
      '1,2x',
    ],
    [
      { t: 'bin', op: '<', a: { t: 'lit', v: 'a' }, b: { t: 'lit', v: 'b' } },
      true,
    ],
    [
      { t: 'bin', op: '===', a: { t: 'lit', v: 1 }, b: { t: 'lit', v: '1' } },
      false,
    ],
    [{ t: 'un', op: '-', a: { t: 'lit', v: [3] } }, -3],
    [
      {
        t: 'join',
        a: { t: 'lit', v: [1, null, [2, 3]] },
        sep: { t: 'lit', v: '-' },
      },
      '1--2,3',
    ],
    [
      { t: 'slice', a: { t: 'lit', v: [1, 2, 3] }, s: { t: 'lit', v: '1' } },
      [2, 3],
    ],
    [{ t: 'indexOf', a: { t: 'lit', v: [1, 2, 2] }, x: { t: 'lit', v: 2 } }, 1],
    [{ t: 'sort', a: { t: 'lit', v: [3, 1, 2] } }, [1, 2, 3]],
    [{ t: 'coal', a: { t: 'lit', v: 0 }, b: { t: 'lit', v: 9 } }, 0],
  ];
  it('[PIN] each operator computes its native answer', () => {
    for (const [tree, want] of ANCHORS)
      expect(run(tree, [PLAIN0, PLAIN0, PLAIN0], false).v).toEqual(want);
  });
});

describe('T2 totality: the result is boxed exactly where the taint oracle says', () => {
  it('[PROVEN] box positions of the mode-on result equal the oracle label tree, deep', () => {
    fc.assert(
      fc.property(exprArb(0), sourcesArb, (tree, specs) => {
        const on = run(tree, specs, true);
        const want = runOracle(tree, specs);
        expect(positions(on.v)).toEqual(want.l);
        expect(isLabeled(on.v)).toBe(want.l.b);
        expect(unboxAll(on.v)).toEqual(unboxAll(want.v));
      }),
      { numRuns: NUM_RUNS * 5 },
    );
  });

  it('[PROVEN] the oracle is a faithful plain evaluator: its values equal the mode-off result', () => {
    fc.assert(
      fc.property(exprArb(0), sourcesArb, (tree, specs) => {
        expect(unboxAll(runOracle(tree, specs).v)).toEqual(
          unboxAll(run(tree, specs, false).v),
        );
      }),
      { numRuns: NUM_RUNS * 5 },
    );
  });

  it('[PREMISE] the generator reaches boxed and plain results, every hook, and nested boxes', () => {
    const seen = { boxed: 0, plain: 0, nested: 0, hidden: 0 };
    const hooks = new Set<string>();
    fc.assert(
      fc.property(exprArb(0), sourcesArb, (tree, specs) => {
        const on = run(tree, specs, true);
        Object.keys(on.ctx.hooks).forEach((h) => hooks.add(h));
        if (isBox(on.v)) seen.boxed++;
        else seen.plain++;
        if (!isBox(on.v) && containsBox(on.v)) seen.nested++;
        if (isError(on.v) && isBox(on.v.cause)) seen.hidden++;
      }),
      { numRuns: NUM_RUNS * 5 },
    );
    for (const n of Object.values(seen)) expect(n).toBeGreaterThan(20);
    expect([...hooks].sort()).toEqual(
      [
        'and',
        'aware',
        'bin',
        'call',
        'coal',
        'cond',
        'filter',
        'find',
        'includes',
        'indexOf',
        'join',
        'key',
        'map',
        'mem',
        'or',
        'slice',
        'sort',
        'spread',
        'un',
      ].sort(),
    );
  });
});

describe('T2 totality, focused: containers over per-element boxes', () => {
  // A list whose elements are individually plain, boxed or pending, then searched / joined /
  // measured. Uniform trees rarely put a box after a search hit, which is exactly where "scan
  // everything" and "scan the prefix" differ.
  const elemArb = fc.record({
    v: fc.constantFrom<Plain>(0, 1, 2, 'a', null, [1]),
    as: fc.constantFrom('plain', 'plain', 'boxed', 'pending'),
  });
  const focusArb = fc.record({
    elems: fc.array(elemArb, { minLength: 1, maxLength: 5 }),
    whole: fc.boolean(),
    op: fc.constantFrom(
      'includes',
      'indexOf',
      'join',
      'length',
      'slice',
      'sort',
      'map',
      'filter',
      'find',
      'spread',
    ),
    x: fc.oneof(
      fc.constantFrom<Plain>(0, 1, 2, 'a', null),
      fc.constant('src0' as const),
    ),
    other: sourceArb,
  });
  const treeOf = (op: string, a: Expr, x: Plain | 'src0'): Expr => {
    const xe: Expr = x === 'src0' ? { t: 'src', i: 0 } : { t: 'lit', v: x };
    switch (op) {
      case 'includes':
      case 'indexOf':
        return { t: op, a, x: xe };
      case 'join':
        return { t: 'join', a, sep: xe };
      case 'length':
        return { t: 'mem', o: a, k: 'length' };
      case 'slice':
        return { t: 'slice', a, s: xe };
      case 'sort':
        return { t: 'sort', a };
      case 'find':
        return {
          t: 'find',
          a,
          body: { t: 'bin', op: '===', a: { t: 'param' }, b: xe },
        };
      case 'spread':
        return { t: 'spread', a, b: { t: 'arr', es: [xe] } };
      case 'map':
        return {
          t: 'map',
          a,
          body: { t: 'bin', op: '+', a: { t: 'param' }, b: xe },
        };
      default:
        return {
          t: 'filter',
          a,
          body: { t: 'bin', op: '===', a: { t: 'param' }, b: xe },
        };
    }
  };

  it('[PROVEN] per-element boxes, prefix scans, coercion depth and plain length match the oracle', () => {
    fc.assert(
      fc.property(focusArb, ({ elems, whole, op, x, other }) => {
        const values = elems.map((el) => el.v);
        // src0 = the generated other source, src1 = the list with every element boxed, src2 =
        // pending, src3 = the list boxed whole.
        const specs: SourceSpec[] = [
          other,
          { kind: 'value', v: values, sens: 'fields' },
          { kind: 'pending' },
          { kind: 'value', v: values, sens: 'whole' },
        ];
        const list: Expr = whole
          ? { t: 'src', i: 3 }
          : {
              t: 'arr',
              es: elems.map((el, i): Expr =>
                el.as === 'boxed'
                  ? { t: 'key', o: { t: 'src', i: 1 }, k: { t: 'lit', v: i } }
                  : el.as === 'pending'
                    ? { t: 'src', i: 2 }
                    : { t: 'lit', v: el.v },
              ),
            };
        const tree = treeOf(op, list, x);
        const on = run(tree, specs, true);
        const want = runOracle(tree, specs);
        expect(positions(on.v)).toEqual(want.l);
        expect(unboxAll(on.v)).toEqual(unboxAll(want.v));
      }),
      { numRuns: NUM_RUNS * 5 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// T4 no-mint, T8 mode off = zero boxes
// ---------------------------------------------------------------------------------------------

const reachableObjects = (specs: readonly SourceSpec[]): Set<unknown> => {
  const out = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || out.has(v)) return;
    out.add(v);
    Object.values(v).forEach(walk);
  };
  specs.forEach((s) =>
    walk(s.kind === 'value' ? s.v : s.kind === 'error' ? s.cause : undefined),
  );
  return out;
};

describe('T4 no-mint: without a boxed source nothing is ever boxed', () => {
  it('[PROVEN] [PIN S1] mode on, no declared sensitivity: no box anywhere, none registered, not even by a host action', () => {
    fc.assert(
      fc.property(exprArb(0), plainSourcesArb, (tree, specs) => {
        const before = world.registered;
        const on = run(tree, specs, true);
        expect(containsBox(on.v)).toBe(false);
        expect(on.registered).toBe(0);
        world.mode = true;
        world.events = [];
        world.state = {};
        try {
          for (const fn of Object.values(ACTIONS)) {
            const r = invokeAction(fn, [on.v]);
            expect(containsBox(r.raw.ret)).toBe(false);
          }
          expect(world.events.some((e) => containsBox(e))).toBe(false);
          expect(
            Object.values(world.state).some((x) => containsBox(x.value)),
          ).toBe(false);
        } finally {
          world.mode = false;
        }
        expect(world.registered).toBe(before);
      }),
      { numRuns: NUM_RUNS * 5 },
    );
  });
});

describe('T8 mode off: zero boxes, results equal a plain evaluator', () => {
  it('[PROVEN] sources that would box allocate nothing and the result equals the plain evaluator', () => {
    fc.assert(
      fc.property(exprArb(0), sourcesArb, (tree, specs) => {
        const off = run(tree, specs, false);
        const plain = runOracle(tree, specs);
        // The registry is the witness, not the constructor: any allocation path that registers counts.
        expect(off.registered).toBe(0);
        expect(containsBox(off.v)).toBe(false);
        expect(off.v).toEqual(plain.v);
        // Where the plain evaluator hands back a source object itself, mode off hands back the same one.
        if (reachableObjects(specs).has(plain.v)) expect(off.v).toBe(plain.v);
      }),
      { numRuns: NUM_RUNS * 5 },
    );
  });

  it('[PREMISE] the generator does hand source objects back by reference', () => {
    let byRef = 0;
    fc.assert(
      fc.property(exprArb(0), sourcesArb, (tree, specs) => {
        if (reachableObjects(specs).has(runOracle(tree, specs).v)) byRef++;
      }),
      { numRuns: NUM_RUNS * 5 },
    );
    expect(byRef).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------------------------
// T1 erasure (the gate)
// ---------------------------------------------------------------------------------------------

/** A toy signal graph: sources, then derived nodes in order, each an expression over sources and
 * earlier nodes. Dependencies are tracked dynamically; a node recomputes when a dependency it read
 * last time changed under the engine's equality (canonical values and the full label tree). A
 * write is either a source write or a host action whose state write lands in a source, so a label
 * re-enters the graph through a real recompute. Readers see the cached value as it is. */
type Write =
  | { i: number; spec: SourceSpec | 'same' }
  | { i: number; action: 'stash' | 'pick'; from: number };
/** Killed alternatives to label-aware equality (each runs with blind equality): read the cached
 * label (`slot`), withhold the whole node when any producer is labeled (`structural`), or keep a
 * node withheld once it was (`sticky`, the high-water mark). */
type Pull = 'none' | 'slot' | 'structural' | 'sticky';
type GraphOptions = { mode: boolean; equality?: Ctx['equality']; pull?: Pull };
type GraphRun = {
  recomputes: number[];
  trace: string[];
  hooks: Record<string, number>;
  effects: number;
  /** Draws of dynamic globals per node. */
  draws: Record<string, number>;
  finals: unknown[];
  /** A recompute of every node now, over the final sources and the cached producers. */
  fresh: unknown[];
  /** What a withholding reader sees of every node, after the initial run and after each write. */
  views: unknown[][];
  /** The unified ordered event trace of the run (reports, console, writes, returns, recomputes). */
  events: TraceEvent[];
  /** Comparisons that saw a change of labels at equal canonical value. */
  labelChanges: number;
  /** Action writes whose value carried a label into a source. */
  reentered: number;
  /** The dependencies each node read in its last run (`s<i>` sources, `n<j>` nodes). */
  readsOf: string[][];
};

/** A reader view hides at least what another hides: a placeholder covers anything below it. */
const coversView = (view: unknown, fresh: unknown): boolean => {
  if (view === PLACEHOLDER) return true;
  if (Array.isArray(view))
    return (
      Array.isArray(fresh) &&
      view.length === fresh.length &&
      view.every((x, i) => coversView(x, fresh[i]))
    );
  if (isRec(view))
    return (
      isRec(fresh) &&
      JSON.stringify(Object.keys(view)) ===
        JSON.stringify(Object.keys(fresh)) &&
      Object.keys(view).every((k) => coversView(view[k], fresh[k]))
    );
  return (
    Object.is(view, fresh) || JSON.stringify(view) === JSON.stringify(fresh)
  );
};

const sameLabels = (a: unknown, b: unknown): boolean =>
  JSON.stringify(positions(a)) === JSON.stringify(positions(b));

/** Canonical values and the full label tree (the engine's rule); `blind` drops the label tree. */
// One comparison is one canonicalization: both sides share a memo, so a value compared with
// itself is the same canonical reference even when it holds a box (no cache outlives the check).
const sameCanon = (a: unknown, b: unknown): boolean => {
  const memo = new WeakMap<object, unknown>();
  return Object.is(canon(a, memo, true), canon(b, memo, true));
};

const engineEquals = (ctx: Ctx, a: unknown, b: unknown): boolean =>
  ctx.equality === 'identity'
    ? Object.is(a, b)
    : sameCanon(a, b) && (ctx.equality === 'blind' || sameLabels(a, b));

const labelOnly = (a: unknown, b: unknown): boolean =>
  sameCanon(a, b) && !sameLabels(a, b);

const runGraph = (
  nodes: readonly Expr[],
  initial: readonly SourceSpec[],
  writes: readonly Write[],
  { mode, equality = 'labeled', pull = 'none' }: GraphOptions,
): GraphRun => {
  world.mode = mode;
  world.events = [];
  world.state = {};
  world.draws = {};
  const effects0 = world.effects;
  try {
    const ctx = { ...newCtx(), equality };
    const specs = [...initial];
    const srcs = specs.map(materialize);
    const vals: unknown[] = [];
    const reads: Set<string>[] = [];
    // A read made inside a labeled branch is a labeled dependency: whether it was made at all is
    // the secret, so a change arriving through it triggers a labeled region.
    const labeledReads: Set<string>[] = [];
    const publicReads: Set<string>[] = [];
    const recomputes = nodes.map(() => 0);
    let labelChanges = 0;
    let reentered = 0;
    const tracked = <T>(
      arr: T[],
      tag: string,
      into: Set<string>,
      labeledInto: Set<string>,
      publicInto: Set<string>,
    ): T[] =>
      new Proxy(arr, {
        get: (t, p) => {
          if (typeof p === 'string' && /^\d+$/.test(p)) {
            into.add(`${tag}${p}`);
            // A dependency is labeled only when every read of it happened inside a labeled branch.
            if (world.branchPc > 0 && world.schedLabel)
              labeledInto.add(`${tag}${p}`);
            else publicInto.add(`${tag}${p}`);
          }
          return Reflect.get(t, p);
        },
      });
    // A recompute triggered by a change in a labeled producer (its old or new value labeled) is a
    // labeled region: what it mints or logs carries the label.
    const compute = (k: number, labeled: boolean): unknown => {
      const into = new Set<string>();
      const labeledInto = new Set<string>();
      const publicInto = new Set<string>();
      reads[k] = into;
      labeledReads[k] = labeledInto;
      publicReads[k] = publicInto;
      recomputes[k]++;
      ctx.trace.push(`node:${k}`);
      const lab = labeled && world.schedLabel;
      world.events.push({
        kind: 'recompute',
        node: k,
        label: world.pcSuppress && lab,
      });
      world.drawNode = String(k);
      try {
        return underPc(
          lab,
          () =>
            evaluate(
              nodes[k],
              {
                srcs: tracked(srcs, 's', into, labeledInto, publicInto),
                deps: tracked(vals, 'n', into, labeledInto, publicInto),
              },
              ctx,
            ),
          true,
        );
      } finally {
        world.drawNode = 'r';
      }
    };
    const sticky = nodes.map(() => false);
    const pulled = (k: number): boolean =>
      containsBox(vals[k]) || producersPulled(k);
    const producersPulled = (k: number): boolean =>
      [...reads[k]].some((d) =>
        d[0] === 's'
          ? containsBox(srcs[Number(d.slice(1))])
          : pulled(Number(d.slice(1))),
      );
    const views: unknown[][] = [];
    const observe = (): void => {
      views.push(
        nodes.map((_, k) => {
          const whole =
            (pull === 'structural' || pull === 'sticky') &&
            (producersPulled(k) || (pull === 'sticky' && sticky[k]));
          if (pull === 'sticky') sticky[k] ||= pulled(k);
          return whole ? PLACEHOLDER : readAs('agent', vals[k]);
        }),
      );
    };
    nodes.forEach((_, k) => (vals[k] = compute(k, false)));
    observe();
    for (const w of writes) {
      let next: unknown;
      if ('action' in w) {
        // A host action over a node's value; its state write lands in a source.
        invokeAction(ACTIONS[w.action], [vals[w.from]]);
        // A labeled action's write re-enters the graph WHOLE: the reader-facing label survives.
        const slot = world.state['last'];
        next =
          slot === undefined
            ? undefined
            : slot.whole
              ? tag(slot.value)
              : slot.value;
        if (containsBox(next)) reentered++;
      } else {
        const spec = w.spec === 'same' ? specs[w.i] : w.spec;
        specs[w.i] = spec;
        next = materialize(spec);
      }
      const dirty = new Map<string, boolean>();
      if (labelOnly(srcs[w.i], next)) labelChanges++;
      if (!engineEquals(ctx, srcs[w.i], next))
        dirty.set(`s${w.i}`, containsBox(srcs[w.i]) || containsBox(next));
      srcs[w.i] = next;
      nodes.forEach((_, k) => {
        const triggers = [...reads[k]].filter((d) => dirty.has(d));
        if (triggers.length === 0) return;
        const old = vals[k];
        // A recompute that a public change also triggers happens in both runs of any pair: only a
        // recompute every trigger of which is labeled is a labeled region.
        const region =
          world.schedLabel &&
          triggers.every(
            (d) =>
              dirty.get(d) ||
              (labeledReads[k].has(d) && !publicReads[k].has(d)),
          );
        const v = compute(k, region);
        if (labelOnly(old, v)) labelChanges++;
        // A change produced inside a labeled region is itself labeled: that it happened at all
        // followed from the secret, so it triggers a labeled region downstream.
        if (!engineEquals(ctx, old, v))
          dirty.set(`n${k}`, containsBox(old) || containsBox(v) || region);
        vals[k] = v;
      });
      observe();
    }
    const effects = world.effects - effects0;
    const events = world.events.slice();
    const draws = { ...world.draws };
    const fresh: unknown[] = [];
    world.replaying = true;
    nodes.forEach((n, k) => {
      world.drawNode = String(k);
      // What a recompute of this node would give right now, over the current cached producers
      // (a fresh object elsewhere would change identity comparisons, not labels).
      fresh[k] = evaluate(n, { srcs, deps: vals }, newCtx());
    });
    world.replaying = false;
    world.drawNode = 'r';
    world.events = events;
    return {
      recomputes,
      trace: ctx.trace,
      hooks: ctx.hooks,
      effects,
      draws,
      finals: vals,
      fresh,
      views,
      events,
      labelChanges,
      reentered,
      readsOf: reads.map((r) => [...r]),
    };
  } finally {
    world.mode = false;
  }
};

const writeArb: fc.Arbitrary<Write> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      i: fc.integer({ min: 0, max: N_SRC - 1 }),
      spec: fc.oneof(
        { weight: 1, arbitrary: sourceArb },
        { weight: 1, arbitrary: fc.constant('same' as const) },
      ),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      i: fc.integer({ min: 0, max: N_SRC - 1 }),
      action: fc.constant('stash' as const),
      from: fc.integer({ min: 0, max: 2 }),
    }),
  },
);
const graphArb = fc.record({
  nodes: fc.tuple(exprArb(0), exprArb(1), exprArb(2)),
  initial: sourcesArb,
  writes: fc.array(writeArb, { minLength: 1, maxLength: 6 }),
});

describe('T1 erasure: unboxing the mode-on result everywhere gives the mode-off result', () => {
  it('[PROVEN] values, absorbers, branches, hook invocations, draws, reports and host effects are identical on vs off', () => {
    fc.assert(
      fc.property(exprArb(0), sourcesArb, (tree, specs) => {
        world.reporter = [];
        const on = run(tree, specs, true);
        const onDraws = { ...world.draws };
        const onReports = world.reporter.map((r) => [r.origin, r.subclass]);
        world.reporter = [];
        const off = run(tree, specs, false);
        expect(unboxAll(on.v)).toEqual(unboxAll(off.v));
        expect(rank(on.v)).toBe(rank(off.v));
        expect(on.ctx.trace).toEqual(off.ctx.trace);
        expect(on.ctx.hooks).toEqual(off.ctx.hooks);
        expect(onDraws).toEqual(world.draws);
        expect(onReports).toEqual(
          world.reporter.map((r) => [r.origin, r.subclass]),
        );
        expect(on.effects).toBe(off.effects);
      }),
      { numRuns: NUM_RUNS * 5 },
    );
  });

  it('[PROVEN] on a signal graph: values identical; on and off differ only in recomputes (and the draws they make) at nodes a label flip at equal value reached; every label fresh', () => {
    const seen = { labelChange: 0, reentered: 0, extraDraws: 0 };
    fc.assert(
      fc.property(graphArb, ({ nodes, initial, writes }) => {
        const on = runGraph(nodes, initial, writes, { mode: true });
        const off = runGraph(nodes, initial, writes, { mode: false });
        // Erasure holds modulo draws of dynamic globals AND every value derived from a draw: a
        // node that drew once more (the extra recompute reached it) and everything downstream of
        // it are exempt from the value comparison; nothing else is.
        const exempt = nodes.map(
          (_, k) => (on.draws[String(k)] ?? 0) !== (off.draws[String(k)] ?? 0),
        );
        for (let pass = 0; pass < nodes.length; pass++)
          nodes.forEach((_, k) => {
            if (on.readsOf[k].some((d) => d[0] === 'n' && exempt[Number(d.slice(1))]))
              exempt[k] = true;
          });
        nodes.forEach((_, k) => {
          if (!exempt[k])
            expect(unboxAll(on.finals[k])).toEqual(unboxAll(off.finals[k]));
        });
        expect([on.effects, off.effects, off.labelChanges]).toEqual([0, 0, 0]);
        // No label is stale: the cached labels are what a fresh evaluation gives, and so is the view.
        expect(on.finals.map(positions)).toEqual(on.fresh.map(positions));
        expect(on.views[on.views.length - 1]).toEqual(
          on.fresh.map((f) => readAs('agent', f)),
        );
        nodes.forEach((_, k) => {
          expect(on.recomputes[k]).toBeGreaterThanOrEqual(off.recomputes[k]);
          // Draws are a function of the recompute count: same count, same draws.
          if (on.recomputes[k] === off.recomputes[k])
            expect(on.draws[String(k)] ?? 0).toBe(off.draws[String(k)] ?? 0);
          else if ((on.draws[String(k)] ?? 0) !== (off.draws[String(k)] ?? 0))
            seen.extraDraws++;
        });
        if (on.labelChanges === 0) {
          expect(on.recomputes).toEqual(off.recomputes);
          expect(on.trace).toEqual(off.trace);
          expect(on.hooks).toEqual(off.hooks);
          expect(on.draws).toEqual(off.draws);
        } else seen.labelChange++;
        if (on.reentered > 0) seen.reentered++;
      }),
      { numRuns: NUM_RUNS * 3 },
    );
    expect(seen.labelChange).toBeGreaterThan(5);
    expect(seen.reentered).toBeGreaterThan(5);
  });

  it('[PIN S7] the roster contract: deterministic callees answer the same twice, dynamic globals draw fresh, none has an effect', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...(Object.keys(PLAIN_FNS) as PlainFn[])),
        valueArb,
        (fn, x) => {
          const before = world.effects;
          const first = callPlain(fn, [x]);
          const second = callPlain(fn, [x]);
          expect(second).toEqual(first);
          if (DYNAMIC.has(fn) && first.ok && second.ok)
            expect(second.v).not.toBe(first.v);
          expect(world.effects).toBe(before);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('T1 erasure: named counterexamples', () => {
  it("[PIN S7] the edge registers the raw value as a per-field view's identity; without it a same-reference write re-renders", () => {
    const nodes: Expr[] = [
      { t: 'src', i: 0 },
      { t: 'mem', o: { t: 'dep', j: 0 }, k: 'length' },
      { t: 'lit', v: 0 },
    ];
    const raw: Plain = [1, 2];
    const initial: SourceSpec[] = [
      { kind: 'value', v: raw, sens: 'fields' },
      PLAIN0,
      PLAIN0,
    ];
    const writes: Write[] = [{ i: 0, spec: 'same' }];
    expect(
      runGraph(nodes, initial, writes, { mode: false }).recomputes,
    ).toEqual([1, 1, 1]);
    expect(runGraph(nodes, initial, writes, { mode: true }).recomputes).toEqual(
      [1, 1, 1],
    );
    world.edgeCanon = false;
    expect(runGraph(nodes, initial, writes, { mode: true }).recomputes).toEqual(
      [2, 2, 1],
    );
  });

  it('[PIN S7] canonicalization is per evaluation: a value mutated between two evaluations is canonicalized afresh', () => {
    world.mode = true;
    const held: Record<string, unknown> = { a: box('x'), b: 2 };
    const tree: Expr = {
      t: 'mem',
      o: { t: 'call', fn: 'id', args: [{ t: 'src', i: 0 }] },
      k: 'b',
    };
    const first = evaluate(tree, { srcs: [held], deps: [] }, newCtx());
    held['b'] = 3;
    const second = evaluate(tree, { srcs: [held], deps: [] }, newCtx());
    world.mode = false;
    expect([unboxAll(first), unboxAll(second)]).toEqual([2, 3]);
  });

  it('[FINDING] one equality check is one canonicalization: the same written-back value is not a change', () => {
    // n0 = [secret]; the action stashes n0 into source 1 twice; n1 reads source 1.
    const nodes: Expr[] = [
      { t: 'arr', es: [{ t: 'src', i: 0 }] },
      { t: 'mem', o: { t: 'src', i: 1 }, k: 'length' },
    ];
    const initial: SourceSpec[] = [
      { kind: 'value', v: 4, sens: 'whole' },
      PLAIN0,
      PLAIN0,
    ];
    const writes: Write[] = [
      { i: 1, action: 'stash', from: 0 },
      { i: 1, action: 'stash', from: 0 },
    ];
    const on = runGraph(nodes, initial, writes, { mode: true });
    const off = runGraph(nodes, initial, writes, { mode: false });
    expect(on.recomputes).toEqual(off.recomputes);
    expect(off.recomputes).toEqual([1, 2]);
  });

  it('[PIN] a label written back by a host action re-enters the graph through a real recompute', () => {
    // n0 = secret; n1 = source 1 + 1. The action stashes n0 into source 1.
    const nodes: Expr[] = [
      { t: 'src', i: 0 },
      { t: 'bin', op: '+', a: { t: 'src', i: 1 }, b: { t: 'lit', v: 1 } },
    ];
    const initial: SourceSpec[] = [
      { kind: 'value', v: 4, sens: 'whole' },
      PLAIN0,
      PLAIN0,
    ];
    const writes: Write[] = [{ i: 1, action: 'stash', from: 0 }];
    const on = runGraph(nodes, initial, writes, { mode: true });
    const off = runGraph(nodes, initial, writes, { mode: false });
    expect(on.recomputes).toEqual([1, 2]);
    expect(off.recomputes).toEqual([1, 2]);
    expect(isBox(on.finals[1])).toBe(true);
    expect(unboxAll(on.finals[1])).toBe(5);
    expect(on.views[1]).toEqual([PLACEHOLDER, PLACEHOLDER]);
  });
});

describe('T1 erasure: draws of dynamic globals', () => {
  it('[PIN] a label flip at equal value re-draws only at the node it reaches, once', () => {
    // n0 = flag ? secretFive : plainFive; n1 = uuid([n0]); n2 = n1.draw. Flag flips.
    const nodes: Expr[] = [
      {
        t: 'cond',
        c: { t: 'src', i: 0 },
        a: { t: 'src', i: 1 },
        b: { t: 'src', i: 2 },
      },
      { t: 'call', fn: 'uuid', args: [{ t: 'arr', es: [{ t: 'dep', j: 0 }] }] },
      { t: 'mem', o: { t: 'dep', j: 1 }, k: 'a' },
    ];
    const initial: SourceSpec[] = [
      { kind: 'value', v: false, sens: 'none' },
      { kind: 'value', v: 5, sens: 'whole' },
      { kind: 'value', v: 5, sens: 'none' },
    ];
    const writes: Write[] = [
      { i: 0, spec: { kind: 'value', v: true, sens: 'none' } },
    ];
    const off = runGraph(nodes, initial, writes, { mode: false });
    const on = runGraph(nodes, initial, writes, { mode: true });
    expect([off.draws['1'], on.draws['1']]).toEqual([1, 2]);
    expect(on.draws['0'] ?? 0).toBe(0);
    expect(on.finals.map(unboxAll)).toEqual(off.finals.map(unboxAll));
  });

  it('[PIN] a value derived from a draw may diverge on vs off after the extra recompute (draw === saved); erasure exempts it and the agent cannot see it', () => {
    const nodes: Expr[] = [
      {
        t: 'cond',
        c: { t: 'src', i: 0 },
        a: { t: 'src', i: 1 },
        b: { t: 'src', i: 2 },
      },
      { t: 'obj', a: { t: 'call', fn: 'uuid', args: [] }, b: { t: 'dep', j: 0 } },
      { t: 'bin', op: '===', a: { t: 'dep', j: 1 }, b: { t: 'src', i: 3 } },
    ];
    const initial: SourceSpec[] = [
      { kind: 'value', v: true, sens: 'none' },
      { kind: 'value', v: 5, sens: 'whole' },
      { kind: 'value', v: 5, sens: 'none' },
      PLAIN0,
    ];
    const writes: Write[] = [
      { i: 3, action: 'stash', from: 1 },
      { i: 0, spec: { kind: 'value', v: false, sens: 'none' } },
    ];
    const off = runGraph(nodes, initial, writes, { mode: false });
    const on = runGraph(nodes, initial, writes, { mode: true });
    expect(unboxAll(off.finals[2])).toBe(true);
    expect(unboxAll(on.finals[2])).toBe(false);
    expect([off.draws['1'], on.draws['1']]).toEqual([1, 2]);
    expect(on.views[on.views.length - 1][2]).toBe(PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------------------------
// T10 precision: a value derived from no labeled operand is never withheld
// ---------------------------------------------------------------------------------------------

const expectedPayload = (v: unknown): unknown => {
  if (isError(v)) {
    const hidden = oracleHidden.get(v) ?? false;
    return {
      kind: 'error',
      origin: v.origin,
      subclass: v.subclass,
      cause: hidden ? PLACEHOLDER : expectedPayload(v.cause),
      renderableMessage: hidden ? PLACEHOLDER : v.renderableMessage,
    };
  }
  if (Array.isArray(v)) return v.map(expectedPayload);
  if (isRec(v))
    return Object.fromEntries(
      Object.entries(v).map(([k, e]) => [k, expectedPayload(e)]),
    );
  return v;
};

/** What an agent should see given the oracle's labels: the placeholder exactly where labeled. */
const expectedView = (x: LV): unknown => {
  if (x.l.b) return PLACEHOLDER;
  const v = x.v;
  if (isError(v))
    return {
      kind: 'error',
      origin: v.origin,
      subclass: v.subclass,
      // An unhidden payload holds no label (hiding triggers on any): it reads as itself, except
      // that an error nested in it keeps its own hidden payload.
      cause: x.l.hidden ? PLACEHOLDER : expectedPayload(v.cause),
      renderableMessage: x.l.hidden ? PLACEHOLDER : v.renderableMessage,
    };
  if (Array.isArray(v))
    return v.map((e, i) => expectedView({ v: e, l: kidsOf(x)[i] }));
  if (isRec(v))
    return Object.fromEntries(
      Object.entries(v).map(([k, e]) => [
        k,
        expectedView({ v: e, l: kidLab(x.l, v, k) ?? plainLab(e) }),
      ]),
    );
  return v;
};

describe('T10 precision: nothing derived from no labeled operand is withheld', () => {
  it('[PROVEN] the agent sees every position the label interpreter leaves unlabeled, as its plain value', () => {
    let partial = 0;
    fc.assert(
      fc.property(exprArb(0), sourcesArb, (tree, specs) => {
        const on = run(tree, specs, true);
        const seen = readAs('agent', on.v);
        expect(seen).toEqual(expectedView(runOracle(tree, specs)));
        if (containsBox(on.v) && seen !== PLACEHOLDER) partial++;
      }),
      { numRuns: NUM_RUNS * 5 },
    );
    // Real precision is exercised: many results hold labels and are still partly shown.
    expect(partial).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------------------------
// Agent principals at the agent reader
// ---------------------------------------------------------------------------------------------

describe('T0 per principal: cleared and uncleared agents', () => {
  const agentView = (tree: Expr, specs: readonly SourceSpec[]) => {
    const v = run(tree, specs, true).v;
    return readAs('agent', v);
  };
  /** Everything a principal observes: every withholding reader, the trace, and ITS problems view. */
  const seeAs = (tree: Expr, specs: readonly SourceSpec[]) => ({
    ...observeRun(tree, specs),
    problems: problemsViewFor('agent'),
  });

  for (const posture of ['uncleared', 'cleared'] as const)
    it(`[PROVEN] ${posture}: two runs differing only in what this principal may not see look alike to it`, () => {
      fc.assert(
        fc.property(
          exprArb(0),
          sourcesArb,
          streamArb,
          (tree, specs, stream) => {
            world.posture = posture;
            try {
              const b = pairOf(specs, replacer(stream));
              expect(seeAs(tree, b)).toEqual(seeAs(tree, specs));
            } finally {
              world.posture = 'shape';
            }
          },
        ),
        { numRuns: NUM_RUNS * 3 },
      );
    });

  it('[PIN] uncleared: every connector value is withheld whatever its shape says; cleared: pii plain, always-sensitive withheld', () => {
    const S0: Expr = { t: 'src', i: 0 };
    const at = (posture: typeof world.posture, spec: SourceSpec) => {
      world.posture = posture;
      try {
        return agentView(S0, [spec, PLAIN0, PLAIN0]);
      } finally {
        world.posture = 'shape';
      }
    };
    const connectorPlain: SourceSpec = {
      kind: 'value',
      v: 'name',
      sens: 'none',
      edge: true,
    };
    const pii: SourceSpec = { kind: 'value', v: 'ssn', sens: 'whole' };
    const token: SourceSpec = {
      kind: 'value',
      v: 'tok',
      sens: 'none',
      always: true,
    };
    expect([
      at('uncleared', connectorPlain),
      at('cleared', connectorPlain),
    ]).toEqual([PLACEHOLDER, 'name']);
    expect([at('uncleared', pii), at('cleared', pii)]).toEqual([
      PLACEHOLDER,
      'ssn',
    ]);
    expect([
      at('uncleared', token),
      at('cleared', token),
      at('shape', token),
    ]).toEqual([PLACEHOLDER, PLACEHOLDER, PLACEHOLDER]);
  });

  it('[PIN] uncleared: a mint whose existence follows the secret never reaches the agent problems view; display may see it', () => {
    const tree: Expr = {
      t: 'cond',
      c: { t: 'src', i: 0 },
      a: { t: 'bin', op: '/', a: { t: 'lit', v: 1 }, b: { t: 'lit', v: 0 } },
      b: { t: 'lit', v: 0 },
    };
    const flag = (v: Plain): SourceSpec => ({
      kind: 'value',
      v,
      sens: 'none',
      edge: true,
    });
    world.posture = 'uncleared';
    try {
      const a = seeAs(tree, [flag(true), PLAIN0, PLAIN0]);
      const shownA = problemsView();
      const b = seeAs(tree, [flag(false), PLAIN0, PLAIN0]);
      const shownB = problemsView();
      expect(a).toEqual(b);
      expect(a.problems).toEqual([]);
      expect([shownA.length, shownB.length]).toEqual([1, 0]);
    } finally {
      world.posture = 'shape';
    }
  });
});

describe('T1 erasure: identity and label freshness', () => {
  it('[PIN S7] a non-aware function handing back its argument keeps `===` faithful', () => {
    const tree: Expr = {
      t: 'bin',
      op: '===',
      a: { t: 'call', fn: 'id', args: [{ t: 'src', i: 0 }] },
      b: { t: 'src', i: 0 },
    };
    for (const sens of ['fields', 'whole', 'none'] as const) {
      const specs: SourceSpec[] = [
        { kind: 'value', v: { a: 1, b: [2] }, sens },
        PLAIN0,
        PLAIN0,
      ];
      expect(unboxAll(run(tree, specs, false).v)).toBe(true);
      expect(unboxAll(run(tree, specs, true).v)).toBe(true);
    }
  });

  // A node whose value moves between a box and an equal plain value: the engine equality sees the
  // label change, the dependent recomputes once (mode on only), its label is fresh.
  const flip = {
    nodes: [
      {
        t: 'cond',
        c: { t: 'src', i: 0 },
        a: { t: 'src', i: 1 },
        b: { t: 'src', i: 2 },
      },
      { t: 'bin', op: '+', a: { t: 'dep', j: 0 }, b: { t: 'lit', v: 1 } },
    ] as Expr[],
    initial: [
      { kind: 'value', v: false, sens: 'none' },
      { kind: 'value', v: 5, sens: 'whole' },
      { kind: 'value', v: 5, sens: 'none' },
    ] as SourceSpec[],
    writes: [
      { i: 0, spec: { kind: 'value', v: true, sens: 'none' } },
    ] as Write[],
  };

  it('[PIN S7] a box/plain flip with an equal value recomputes the dependent once and leaves no stale label', () => {
    const off = runGraph(flip.nodes, flip.initial, flip.writes, {
      mode: false,
    });
    const on = runGraph(flip.nodes, flip.initial, flip.writes, { mode: true });
    expect(off.recomputes).toEqual([2, 1]);
    expect(on.recomputes).toEqual([2, 2]);
    expect(on.labelChanges).toBe(2);
    expect([isBox(on.finals[0]), isBox(on.finals[1])]).toEqual([true, true]);
    expect(on.finals.map(positions)).toEqual(on.fresh.map(positions));
    // Killed: blind equality reading the cached label shows a plain 6 where a fresh run is boxed.
    const slot = runGraph(flip.nodes, flip.initial, flip.writes, {
      mode: true,
      equality: 'blind',
      pull: 'slot',
    });
    expect(slot.views[1][1]).toBe(6);
    expect(isBox(slot.fresh[1])).toBe(true);
  });

  it('[PIN S7] the label check is deep: the same raw record re-declared per field is a change', () => {
    const raw: Plain = { a: 1, b: 2 };
    const nodes: Expr[] = [{ t: 'mem', o: { t: 'src', i: 0 }, k: 'a' }];
    const initial: SourceSpec[] = [
      { kind: 'value', v: raw, sens: 'none' },
      PLAIN0,
      PLAIN0,
    ];
    const writes: Write[] = [
      { i: 0, spec: { kind: 'value', v: raw, sens: 'fields' } },
    ];
    const on = runGraph(nodes, initial, writes, { mode: true });
    expect(
      runGraph(nodes, initial, writes, { mode: false }).recomputes,
    ).toEqual([1]);
    expect(on.recomputes).toEqual([2]);
    expect(isBox(on.finals[0])).toBe(true);
  });

  it('[PIN T10] precision per field: a node reading the plain field of a record whose other field is boxed is shown', () => {
    // n0 = { a: secret, b: 2 }; n1 = n0.b. The law shows 2; the structural pull withholds it.
    const nodes: Expr[] = [
      { t: 'obj', a: { t: 'src', i: 0 }, b: { t: 'lit', v: 2 } },
      { t: 'mem', o: { t: 'dep', j: 0 }, k: 'b' },
    ];
    const initial: SourceSpec[] = [
      { kind: 'value', v: 1, sens: 'whole' },
      PLAIN0,
      PLAIN0,
    ];
    const law = runGraph(nodes, initial, [], { mode: true });
    const structural = runGraph(nodes, initial, [], {
      mode: true,
      equality: 'blind',
      pull: 'structural',
    });
    expect(law.views[0]).toEqual([{ a: PLACEHOLDER, b: 2 }, 2]);
    expect(structural.views[0][1]).toBe(PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------------------------
// T0 noninterference: two runs that differ only in the plain values inside boxed leaves
// ---------------------------------------------------------------------------------------------
// T0 never asks the label oracle. It compares one ordered trace of everything a withholding
// observer sees in two runs: same program, same structure (container shapes, source load states),
// same labels; only primitive leaves under a box differ, each one guaranteed to differ, and over
// time each run has its own history. Null is a leaf.

const primArb = fc.constantFrom<Plain>(
  0,
  1,
  2,
  -1,
  'a',
  'b',
  '',
  '12',
  'é',
  '日本',
  '🙂',
  true,
  false,
  null,
  undefined,
);

/** Replaces every primitive leaf of `v`, in order; containers keep their shape. */
const varyLeaves = (v: Plain, next: (orig: Plain) => Plain): Plain =>
  Array.isArray(v)
    ? v.map((x) => varyLeaves(x, next))
    : isRec(v)
      ? (Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, varyLeaves(x as Plain, next)]),
        ) as Plain)
      : next(v);

/** Whether the agent principal may not see a source (what a T0 pair may vary). */
const hiddenFrom = (s: SourceSpec): boolean =>
  s.kind === 'value'
    ? effectiveSens(s) !== 'none'
    : s.kind === 'error' && errorHidden(s);

/**
 * A stream of replacements consumed in order across a whole history (initial sources, then every
 * write), each guaranteed to differ from the leaf it replaces.
 */
const replacer = (stream: readonly Plain[]): ((orig: Plain) => Plain) => {
  let i = 0;
  return (orig) => {
    for (let t = 0; t < stream.length; t++) {
      const c = stream[i++ % stream.length];
      if (!Object.is(c, orig)) return c;
    }
    return orig === 'Ω' ? 'Ψ' : 'Ω';
  };
};
const varySpec = (s: SourceSpec, next: (orig: Plain) => Plain): SourceSpec =>
  !hiddenFrom(s)
    ? s
    : s.kind === 'value'
      ? { ...s, v: varyLeaves(s.v, next) }
      : s.kind === 'error'
        ? { ...s, cause: varyLeaves(s.cause, next) }
        : s;
const pairOf = (
  specs: readonly SourceSpec[],
  next: (orig: Plain) => Plain,
): SourceSpec[] => specs.map((s) => varySpec(s, next));
const streamArb = fc.array(primArb, { minLength: 32, maxLength: 32 });
const pairedSourcesArb = fc
  .tuple(sourcesArb, streamArb)
  .map(([specs, stream]) => [specs, pairOf(specs, replacer(stream))] as const);

// Host actions (ours: `defineAction`), under the built-in roster contract: the write set and the
// return shape do not depend on argument values, and nothing is retained across invocations (the
// capability object dies when the invocation returns). Arguments are unwrapped through one
// alias-preserving memo per invocation. In the engine, objects map back by identity (the unwrapped
// copy of a box is the box) and everything else is labeled by position; for readers, anything a
// labeled action returns or writes is whole, by position.
type Io = {
  log: (x: unknown) => void;
  write: (key: string, x: unknown) => void;
};
type HostAction = (args: unknown[], io: Io) => unknown;
type Taint = {
  objects: Map<object, unknown>;
  prims: Set<unknown>;
  copies: Map<object, unknown>;
};

const ACTIONS: Record<string, HostAction> = {
  // The observing host: logs its plain argument and returns it unchanged.
  observe: ([x], io) => {
    io.log(x);
    return x;
  },
  stash: ([x], io) => {
    io.write('last', x);
    return 'stored';
  },
  // The contract-keeping host whose RETURN SHAPE depends on a value (one write set, two shapes).
  pick: ([x], io) => {
    const r = x as { a?: unknown; b?: unknown } | undefined;
    const y = r !== undefined && r !== null && r.a ? r : r?.b;
    io.write('last', y);
    return y;
  },
};

/** Unwraps for a host, recording what was sensitive. One copy per original value per invocation. */
const unwrapInto = (v: unknown, taint: Taint): unknown => {
  if (typeof v === 'object' && v !== null && taint.copies.has(v))
    return taint.copies.get(v);
  if (isBox(v)) {
    const inner = unbox(v);
    // Every leaf under the box is sensitive; nested containers map back to their labeled form.
    const collect = (x: unknown): void => {
      if (isAbsorber(x)) return;
      if (isBox(x)) return collect(unbox(x));
      if (Array.isArray(x) || isRec(x)) {
        if (!taint.objects.has(x)) taint.objects.set(x, tag(x));
        Object.values(x).forEach(collect);
      } else taint.prims.add(x);
    };
    collect(inner);
    const out = unwrapInto(inner, taint);
    // What the host holds for the box maps back to the box itself.
    if (typeof out === 'object' && out !== null) taint.objects.set(out, v);
    taint.copies.set(v, out);
    return out;
  }
  if (Array.isArray(v) || isRec(v)) {
    // Any label inside (a box, or a labeled absorber) makes the host's copy map back to `v`.
    if (!labeledThrough(v, true)) return v;
    const copy: unknown = Array.isArray(v) ? [] : {};
    taint.copies.set(v, copy);
    if (Array.isArray(v))
      v.forEach((x) => (copy as unknown[]).push(unwrapInto(x, taint)));
    else
      for (const [k, x] of Object.entries(v))
        (copy as Record<string, unknown>)[k] = unwrapInto(x, taint);
    taint.objects.set(copy as object, v);
    return copy;
  }
  return v;
};

/** The killed alternative: primitives re-labeled by value. */
const relabelByValue = (v: unknown, taint: Taint): unknown => {
  if (typeof v === 'object' && v !== null && taint.objects.has(v))
    return taint.objects.get(v);
  // Copy-on-write: a container is rebuilt only when something inside it was re-labeled.
  if (Array.isArray(v)) {
    const out = v.map((x) => relabelByValue(x, taint));
    return out.some((x, i) => x !== v[i]) ? out : v;
  }
  if (isRec(v)) {
    const entries = Object.entries(v).map(
      ([k, x]) => [k, relabelByValue(x, taint)] as const,
    );
    return entries.some(([k, x]) => x !== v[k])
      ? Object.fromEntries(entries)
      : v;
  }
  return taint.prims.has(v) ? box(v) : v;
};

/** Re-attaches labels at an exit we own (in-engine): identity for objects, position for the rest. */
const relabelExit = (v: unknown, taint: Taint, tainted: boolean): unknown => {
  if (typeof v === 'object' && v !== null && taint.objects.has(v))
    return taint.objects.get(v);
  if (world.taint === 'value') return relabelByValue(v, taint);
  return tainted ? tag(v) : v;
};

/** One action invocation. Every observable step goes into the ordered trace. */
const invokeAction = (
  fn: HostAction,
  args: unknown[],
  proxied = true,
  aliasMemo = true,
) => {
  const fanout = readAs('telemetry', args); // the executor fan-out keeps the boxed params
  const tainted = args.some((a) => labeledThrough(a, true));
  const taint: Taint = {
    objects: new Map(),
    prims: new Set(),
    copies: new Map(),
  };
  const plainArgs = args.map((a) => {
    if (!aliasMemo) taint.copies = new Map(); // the killed variant: every argument copied alone
    return unwrapInto(a, taint);
  });
  // Reader-facing wholeness: under the roster contract, a labeled action's outputs are whole.
  const whole = world.taint === 'position' && tainted;
  let open = true;
  const io: Io = {
    // The proxied console: the label is re-attached and the entry carries the action's pc.
    log: (x) => {
      if (!open) world.lateCalls++;
      const e = proxied
        ? {
            value: relabelExit(x, taint, tainted),
            label: world.pcSuppress && tainted,
          }
        : { value: x, label: false };
      world.console.push(e);
      world.events.push({ kind: 'console', ...e });
    },
    write: (k, x) => {
      if (!open) world.lateCalls++;
      const prev = world.state[k];
      const value = relabelExit(x, taint, tainted);
      world.state[k] = { value, whole };
      // The occurrence and the destination of a labeled action's write are labeled too.
      world.events.push({
        kind: 'write',
        key: k,
        value: whole ? PLACEHOLDER : value,
        overwritten:
          prev === undefined
            ? undefined
            : prev.whole
              ? PLACEHOLDER
              : prev.value,
        label: world.pcSuppress && tainted,
      });
    },
  };
  let raw: unknown;
  try {
    raw = fn(plainArgs, io);
  } finally {
    open = false;
  }
  const ret = relabelExit(raw, taint, tainted);
  world.events.push({
    kind: 'return',
    value: whole ? PLACEHOLDER : ret,
    label: false,
  });
  return {
    fanout,
    ret: whole ? PLACEHOLDER : readAs('agent', ret),
    raw: { ret, plainRet: raw },
  };
};

const withholding = (): string[] =>
  READERS.filter((r) => CLEARANCE[r] === 'withhold');

/** The trace as a withholding observer sees it: labeled events dropped, values through rows. */
const publicTrace = (events: readonly TraceEvent[]): unknown[] =>
  events
    .filter((e) => !e.label)
    .map((e) => {
      switch (e.kind) {
        case 'report':
          return {
            kind: e.kind,
            origin: e.origin,
            subclass: e.subclass,
            cause: readAs('telemetry', e.cause),
          };
        case 'console':
          return { kind: e.kind, value: readAs('console', e.value) };
        case 'write':
          return {
            kind: e.kind,
            key: e.key,
            value: readAs('agent', e.value),
            overwritten: readAs('agent', e.overwritten),
          };
        case 'return':
          return { kind: e.kind, value: readAs('agent', e.value) };
        case 'recompute':
          return { kind: e.kind, node: e.node };
      }
    });

/** Everything a withholding observer sees of one run, in order (and the problems plane, apart). */
const observeRun = (
  tree: Expr,
  specs: readonly SourceSpec[],
  proxied = true,
) => {
  world.console = [];
  world.reporter = [];
  world.events = [];
  world.state = {};
  world.draws = {};
  world.mode = true;
  try {
    const srcs = specs.map(materialize);
    const v = evaluate(tree, { srcs, deps: [] }, newCtx());
    const fanouts = Object.values(ACTIONS).map(
      (fn) => invokeAction(fn, [v], proxied).fanout,
    );
    return {
      readers: withholding().map((r) => readAs(r, v)),
      fanouts,
      trace: publicTrace(world.events),
    };
  } finally {
    world.mode = false;
  }
};
const problemsOf = (tree: Expr, specs: readonly SourceSpec[]): unknown[] => {
  observeRun(tree, specs);
  return problemsView();
};

describe('T0 noninterference: withholding observers cannot tell two secrets apart', () => {
  it('[PROVEN] same program, same structure, different boxed leaves: identical ordered traces', () => {
    const seen = { differ: 0, reports: 0, console: 0, labeledReports: 0 };
    fc.assert(
      fc.property(exprArb(0), pairedSourcesArb, (tree, [a, b]) => {
        const oa = observeRun(tree, a);
        if (world.reporter.some((r) => r.label)) seen.labeledReports++;
        const ob = observeRun(tree, b);
        expect(ob).toEqual(oa);
        if (
          JSON.stringify(run(tree, a, false).v) !==
          JSON.stringify(run(tree, b, false).v)
        )
          seen.differ++;
        if (oa.trace.some((e) => (e as { kind: string }).kind === 'report'))
          seen.reports++;
        if (oa.trace.some((e) => (e as { kind: string }).kind === 'console'))
          seen.console++;
      }),
      { numRuns: T0_RUNS },
    );
    // The pairs are real pairs: mode off, the two programs often compute different things.
    expect(seen.differ).toBeGreaterThan(T0_RUNS / 20);
    expect(seen.reports).toBeGreaterThan(T0_RUNS / 80);
    expect(seen.console).toBeGreaterThan(T0_RUNS / 80);
    expect(seen.labeledReports).toBeGreaterThan(T0_RUNS / 80);
  }, 120_000);

  it('[PROVEN] the problems plane (display) shows every mint as a value-free entry', () => {
    fc.assert(
      fc.property(exprArb(0), pairedSourcesArb, (tree, [a]) => {
        for (const entry of problemsOf(tree, a) as Record<string, unknown>[])
          expect(Object.keys(entry).sort()).toEqual([
            'message',
            'origin',
            'subclass',
          ]);
      }),
      { numRuns: NUM_RUNS * 2 },
    );
  });
});

describe('T0 named counterexamples (each fails with the rule the comment names)', () => {
  const S = (i: number): Expr => ({ t: 'src', i });
  const lit = (v: Plain): Expr => ({ t: 'lit', v });
  const fail: Expr = { t: 'mem', o: lit(null), k: 'a' };
  const secret = (v: Plain): SourceSpec => ({
    kind: 'value',
    v,
    sens: 'whole',
  });
  const same = (tree: Expr, a: SourceSpec[], b: SourceSpec[]): boolean =>
    JSON.stringify(observeRun(tree, a)) === JSON.stringify(observeRun(tree, b));

  it('[PIN] isError(secret ? fail() : 0): the flow-born error is labeled, so both secrets look alike', () => {
    const tree: Expr = {
      t: 'aware',
      fn: 'isError',
      args: [{ t: 'cond', c: S(0), a: fail, b: lit(0) }, lit(0)],
    };
    const a = [secret(true), PLAIN0, PLAIN0];
    const b = [secret(false), PLAIN0, PLAIN0];
    expect(same(tree, a, b)).toBe(true);
    expect(unboxAll(run(tree, a, false).v)).not.toEqual(
      unboxAll(run(tree, b, false).v),
    );
    world.mode = true;
    const born = evaluate(
      { t: 'cond', c: S(0), a: S(1), b: lit(0) },
      { srcs: [box(true), PENDING], deps: [] },
      newCtx(),
    );
    world.mode = false;
    expect([
      born === PENDING_LABELED,
      isPending(born),
      rank(born),
      stripLabel(born),
    ]).toEqual([true, true, 2, PENDING]);
    expect(isLabeledAbsorber(materialize({ kind: 'pending' }))).toBe(false);
  });

  it('[PIN] any hook result is labeled iff a scanned operand is: (secret ? pending : 0) + error', () => {
    const tree: Expr = {
      t: 'bin',
      op: '+',
      a: { t: 'cond', c: S(0), a: S(1), b: lit(0) },
      b: S(2),
    };
    const err: SourceSpec = { kind: 'error', cause: 1, sens: false };
    const a = [secret(true), { kind: 'pending' } as SourceSpec, err];
    const b = [secret(false), { kind: 'pending' } as SourceSpec, err];
    expect(same(tree, a, b)).toBe(true);
    world.mixing = 'plain';
    expect(same(tree, a, b)).toBe(false);
  });

  it('[PIN] an entry made inside a branch a boxed test chose travels labeled; withholding readers drop it', () => {
    const logs: Expr = {
      t: 'cond',
      c: S(0),
      a: { t: 'call', fn: 'log', args: [lit(1)] },
      b: lit(0),
    };
    const mints: Expr = {
      t: 'cond',
      c: S(0),
      a: { t: 'bin', op: '/', a: lit(1), b: lit(0) },
      b: lit(0),
    };
    for (const tree of [logs, mints]) {
      const a = [secret(true), PLAIN0, PLAIN0];
      const b = [secret(false), PLAIN0, PLAIN0];
      expect(same(tree, a, b)).toBe(true);
      // Delivered, not dropped at the source: the entry exists and carries the label.
      observeRun(tree, a);
      const entries = [...world.console, ...world.reporter];
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.label)).toBe(true);
      world.pcSuppress = false;
      expect(same(tree, a, b)).toBe(false);
      world.pcSuppress = true;
    }
  });

  it('[PIN] a labeled mint is delivered labeled: telemetry drops it, the problems plane shows a value-free entry', () => {
    const tree: Expr = { t: 'bin', op: '/', a: S(0), b: lit(0) };
    const a = [secret(7), PLAIN0, PLAIN0];
    const b = [secret('x'), PLAIN0, PLAIN0];
    expect(same(tree, a, b)).toBe(true);
    observeRun(tree, a);
    expect(world.reporter.map((r) => r.label)).toEqual([true]);
    expect(problemsOf(tree, a)).toEqual([
      {
        origin: 'binary',
        subclass: 'divide-by-zero',
        message: `cannot divide ${PLACEHOLDER} by zero`,
      },
    ]);
    // Both secrets numeric: both runs mint, and the display entry is the same, value-free.
    expect(problemsOf(tree, [secret(9), PLAIN0, PLAIN0])).toEqual(
      problemsOf(tree, a),
    );
    world.pcSuppress = false;
    expect(same(tree, a, b)).toBe(false);
  });

  it('[PIN] a structural error is labeled by ANY labeled operand: spread(undefined, secret.a)', () => {
    const tree: Expr = {
      t: 'spread',
      a: lit(undefined),
      b: { t: 'mem', o: S(0), k: 'a' },
    };
    const a = [secret(0), PLAIN0, PLAIN0];
    const b = [secret(null), PLAIN0, PLAIN0];
    expect(same(tree, a, b)).toBe(true);
    world.mode = true;
    const minted = evaluate(tree, { srcs: [box(0)], deps: [] }, newCtx());
    world.mode = false;
    expect(isLabeledAbsorber(minted)).toBe(true);
  });

  it('[PIN] callbacks over a boxed receiver run under the labeled branch: their count is the secret', () => {
    const tree: Expr = {
      t: 'map',
      a: { t: 'key', o: lit([[0]]), k: S(0) },
      body: { t: 'map', a: lit(0), body: lit(0) },
    };
    expect(
      same(tree, [secret(0), PLAIN0, PLAIN0], [secret(''), PLAIN0, PLAIN0]),
    ).toBe(true);
  });

  it("[PIN] the deep absorber stage counts the top operands' labels: key(secret ?? pending, [pending])", () => {
    const tree: Expr = {
      t: 'key',
      o: { t: 'coal', a: S(0), b: S(1) },
      k: { t: 'arr', es: [S(1)] },
    };
    const pend: SourceSpec = { kind: 'pending' };
    expect(
      same(tree, [secret(0), pend, PLAIN0], [secret(null), pend, PLAIN0]),
    ).toBe(true);
  });

  it('[FINDING] a structural mint counts a label at the scan depth of the other operand: slice(NaN, [!(secret && error)])', () => {
    const tree: Expr = {
      t: 'slice',
      a: { t: 'bin', op: '+', a: lit(undefined), b: lit(undefined) },
      s: {
        t: 'arr',
        es: [{ t: 'un', op: '!', a: { t: 'and', a: S(0), b: S(1) } }],
      },
    };
    const err: SourceSpec = { kind: 'error', cause: 0, sens: false };
    expect(
      same(tree, [secret(0), err, PLAIN0], [secret(true), err, PLAIN0]),
    ).toBe(true);
  });

  it('[FINDING] a host copy maps back when the argument holds a labeled absorber, not only a box', () => {
    // { a: 'UNDEFINED', b: secret.a }: secret = 0 gives a box at b, secret = undefined a labeled error.
    const tree: Expr = {
      t: 'obj',
      a: { t: 'call', fn: 'upper', args: [lit(undefined)] },
      b: { t: 'mem', o: S(0), k: 'a' },
    };
    expect(
      same(
        tree,
        [secret(0), PLAIN0, PLAIN0],
        [secret(undefined), PLAIN0, PLAIN0],
      ),
    ).toBe(true);
  });

  it('[PIN] the console row still sees a call absorbed by a labeled absorber (the absorption is the secret)', () => {
    const tree: Expr = {
      t: 'call',
      fn: 'log',
      args: [{ t: 'and', a: S(0), b: fail }],
    };
    const a = [secret(0), PLAIN0, PLAIN0];
    const b = [secret(1), PLAIN0, PLAIN0];
    expect(same(tree, a, b)).toBe(true);
    expect(observeRun(tree, a).trace[0]).toEqual({
      kind: 'console',
      value: PLACEHOLDER,
    });
  });

  it('[PIN] the observing host returns its argument: the reader gets the same whole placeholder in both runs; unproxied it fails', () => {
    const tree: Expr = { t: 'arr', es: [S(0), lit(2)] };
    const a = [secret(2), PLAIN0, PLAIN0];
    const b = [secret(3), PLAIN0, PLAIN0];
    expect(JSON.stringify(observeRun(tree, a))).toBe(
      JSON.stringify(observeRun(tree, b)),
    );
    // The observing host's own return (the first action) is whole, not its argument's partial labels.
    const returns = observeRun(tree, a).trace.filter(
      (e) => (e as { kind: string }).kind === 'return',
    );
    expect(returns[0]).toEqual({ kind: 'return', value: PLACEHOLDER });
    expect(JSON.stringify(observeRun(tree, a, false))).not.toBe(
      JSON.stringify(observeRun(tree, b, false)),
    );
    // In the engine, identity recovery keeps the write precise: the state holds the original box.
    world.mode = true;
    const original = [box(2), 2];
    invokeAction(ACTIONS['stash'], [original]);
    world.mode = false;
    expect(world.state['last'].value).toBe(original);
  });

  it('[PIN] host-side gaps close by position: a derived value, host control flow, a structural primitive; value taint fails the last', () => {
    const GAPS: Record<string, HostAction> = {
      derive: ([x], io) => void io.log(`${String(x)}!`),
      branch: ([x], io) => void (x ? io.log('yes') : undefined),
      count: ([x]) => (Array.isArray(x) ? x.length : 0),
    };
    const pairs: Record<string, [() => unknown, () => unknown]> = {
      derive: [() => box('p'), () => box('q')],
      branch: [() => box(1), () => box(0)],
      count: [() => [box(2), 7], () => [box(3), 7]],
    };
    const observeAction = (fn: HostAction, mk: () => unknown) => {
      world.events = [];
      world.mode = true;
      try {
        invokeAction(fn, [mk()]);
        return JSON.stringify(publicTrace(world.events));
      } finally {
        world.mode = false;
      }
    };
    for (const [name, fn] of Object.entries(GAPS)) {
      const [mkA, mkB] = pairs[name];
      expect(observeAction(fn, mkA)).toBe(observeAction(fn, mkB));
    }
    world.taint = 'value';
    expect(observeAction(GAPS['count'], pairs['count'][0])).not.toBe(
      observeAction(GAPS['count'], pairs['count'][1]),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The built-in roster contract and argument aliasing
// ---------------------------------------------------------------------------------------------

/** A return's shape: containers by structure, an argument (or part of one) returned as such. */

/**
 * The contract over a roster: for two argument values of one shape, each member's write set is
 * equal (a destination chosen by a value would reveal it; a return shape chosen by a value is
 * covered by the whole label); no member's behavior depends on an earlier invocation of any
 * member; no capability is used after its invocation returned (settled).
 */
const contractViolations = (
  roster: Record<string, HostAction>,
  argsA: unknown[],
  argsB: unknown[],
  drain: () => void = () => undefined,
): string[] => {
  const out: string[] = [];
  const once = (fn: HostAction, args: unknown[]) => {
    const writes: string[] = [];
    const io: Io = { log: () => undefined, write: (k) => void writes.push(k) };
    const ret = fn(args, io);
    return { writes, ret };
  };
  for (const [name, fn] of Object.entries(roster)) {
    const a = once(fn, argsA);
    const b = once(fn, argsB);
    if (JSON.stringify(a.writes) !== JSON.stringify(b.writes))
      out.push(`${name}: write set depends on argument values`);
  }
  for (const [first, f] of Object.entries(roster))
    for (const [second, g] of Object.entries(roster)) {
      once(f, argsA);
      const afterA = once(g, argsA);
      once(f, argsB);
      const afterB = once(g, argsA);
      if (
        JSON.stringify([afterA.writes, afterA.ret]) !==
        JSON.stringify([afterB.writes, afterB.ret])
      )
        out.push(`${second} after ${first}: retains state across invocations`);
    }
  world.lateCalls = 0;
  world.mode = true;
  try {
    for (const fn of Object.values(roster)) invokeAction(fn, argsA);
    drain();
  } finally {
    world.mode = false;
  }
  if (world.lateCalls > 0)
    out.push('a capability was used after its invocation returned');
  return out;
};

describe('the built-in roster contract', () => {
  it('[PIN] the roster (observe, stash) keeps the contract', () => {
    expect(
      contractViolations(ACTIONS, [{ a: 1, b: 7 }], [{ a: 'x', b: 8 }]),
    ).toEqual([]);
  });

  it('[PIN] the four contract-breaking constructions (conditional write, identity-dependent return, retained primitive, delayed write) each break it', () => {
    const conditional: HostAction = ([s], io) => {
      if (s) io.write('leaked', 7);
      return 0;
    };
    const identityReturn: HostAction = ([x]) => {
      const r = x as { a: unknown; b: unknown };
      return r.a ? r : { a: r.a, b: r.b };
    };
    let saved: unknown;
    const retainFirst: HostAction = ([s]) => {
      saved = s;
      return 0;
    };
    const retainSecond: HostAction = () => saved;
    let later: () => void = () => undefined;
    const delayed: HostAction = ([s], io) => {
      later = () => io.write(s ? 'yes' : 'no', 7);
      return 0;
    };
    expect(contractViolations({ conditional }, [true], [false])).toEqual([
      'conditional: write set depends on argument values',
    ]);
    // A return shape chosen by a value keeps the contract: the whole label covers it (pinned below).
    expect(
      contractViolations(
        { identityReturn },
        [{ a: 1, b: 7 }],
        [{ a: 0, b: 7 }],
      ),
    ).toEqual([]);
    expect(
      contractViolations({ retainFirst, retainSecond }, [true], [false]),
    ).toContain(
      'retainSecond after retainFirst: retains state across invocations',
    );
    expect(
      contractViolations({ delayed }, [true], [true], () => later()),
    ).toEqual(['a capability was used after its invocation returned']);
  });

  it('[PIN] two distinct arguments holding equal boxes stay distinct for the host: the memo is keyed by identity', () => {
    world.mode = true;
    const same: HostAction = ([a, b]) => a === b;
    expect(
      invokeAction(same, [{ a: box(1) }, { a: box(1) }]).raw.plainRet,
    ).toBe(false);
  });

  it('[PIN] a whole box hands the host its real inner object (a mutation lands on the same object in both modes); a per-field view hands a copy', () => {
    const mutate: HostAction = ([x]) => {
      (x as { a: number }).a = 9;
      return 0;
    };
    const raw = { a: 1 };
    invokeAction(mutate, [raw]);
    expect(raw.a).toBe(9);
    world.mode = true;
    const raw2 = { a: 1 };
    invokeAction(mutate, [box(raw2)]);
    expect(raw2.a).toBe(9);
    const view = { a: box(1) };
    invokeAction(mutate, [view]);
    expect(unbox(view.a)).toBe(1);
  });

  it('[PROVEN] one alias-preserving unwrap per invocation: [x, x] reaches the host as one object, as in mode off', () => {
    const same: HostAction = ([a, b]) => a === b;
    fc.assert(
      fc.property(exprArb(0), sourcesArb, (tree, specs) => {
        const v = run(tree, specs, true).v;
        const plain = run(tree, specs, false).v;
        world.mode = true;
        const on = invokeAction(same, [v, v]).raw.plainRet;
        world.mode = false;
        const off = invokeAction(same, [plain, plain]).raw.plainRet;
        expect(on).toBe(off);
      }),
      { numRuns: NUM_RUNS * 2 },
    );
    world.mode = true;
    const x = { a: box(1) };
    expect(invokeAction(same, [x, x]).raw.plainRet).toBe(true);
    expect(invokeAction(same, [x, x], true, false).raw.plainRet).toBe(false);
    world.mode = false;
  });
});

describe('T0 across time: a signal graph under independently paired histories', () => {
  const graphPairArb = fc.tuple(graphArb, streamArb).map(([g, stream]) => {
    const next = replacer(stream);
    return {
      nodes: g.nodes,
      a: { initial: g.initial, writes: g.writes },
      b: {
        initial: pairOf(g.initial, next),
        writes: g.writes.map((w): Write =>
          'action' in w || w.spec === 'same'
            ? w
            : { ...w, spec: varySpec(w.spec, next) },
        ),
      },
    };
  });
  const observeGraph = (
    nodes: readonly Expr[],
    h: { initial: SourceSpec[]; writes: Write[] },
    opts: Omit<GraphOptions, 'mode'> = {},
  ) => {
    const r = runGraph(nodes, h.initial, h.writes, { mode: true, ...opts });
    return { trace: publicTrace(r.events), views: r.views };
  };

  it('[PROVEN] under label-aware equality and scheduling labels, the full ordered trace is identical between the pair', () => {
    const seen = { labeledRecompute: 0 };
    fc.assert(
      fc.property(graphPairArb, ({ nodes, a, b }) => {
        const oa = observeGraph(nodes, a);
        if (world.events.some((e) => e.kind === 'recompute' && e.label))
          seen.labeledRecompute++;
        expect(observeGraph(nodes, b)).toEqual(oa);
      }),
      { numRuns: GRAPH_T0_RUNS },
    );
    expect(seen.labeledRecompute).toBeGreaterThan(20);
  }, 120_000);

  it("[PIN] the history construction: { a: secret, b: parse('a') } with secret 1 then 1 vs 2 then 3; public counts equal", () => {
    const nodes: Expr[] = [
      {
        t: 'obj',
        a: { t: 'src', i: 0 },
        b: { t: 'call', fn: 'parse', args: [{ t: 'lit', v: 'a' }] },
      },
    ];
    const hist = (x: Plain, y: Plain) => ({
      initial: [
        { kind: 'value', v: x, sens: 'whole' } as SourceSpec,
        PLAIN0,
        PLAIN0,
      ],
      writes: [{ i: 0, spec: { kind: 'value', v: y, sens: 'whole' } } as Write],
    });
    expect(observeGraph(nodes, hist(1, 1))).toEqual(
      observeGraph(nodes, hist(2, 3)),
    );
    world.schedLabel = false;
    expect(observeGraph(nodes, hist(1, 1))).not.toEqual(
      observeGraph(nodes, hist(2, 3)),
    );
  });

  it('[PIN] the draw history: { a: secret, b: uuid() }, n1 = n0.b, n2 = n1 === saved; a changing secret redraws and the agent cannot tell', () => {
    const nodes: Expr[] = [
      { t: 'obj', a: { t: 'src', i: 0 }, b: { t: 'call', fn: 'uuid', args: [] } },
      { t: 'mem', o: { t: 'dep', j: 0 }, k: 'b' },
      { t: 'bin', op: '===', a: { t: 'dep', j: 1 }, b: { t: 'src', i: 1 } },
    ];
    const hist = (x: Plain, y: Plain) => ({
      initial: [
        { kind: 'value', v: x, sens: 'whole' } as SourceSpec,
        PLAIN0,
        PLAIN0,
      ],
      writes: [
        { i: 1, action: 'stash', from: 1 },
        { i: 0, spec: { kind: 'value', v: y, sens: 'whole' } },
      ] as Write[],
    });
    expect(observeGraph(nodes, hist(1, 1))).toEqual(
      observeGraph(nodes, hist(2, 3)),
    );
    // Without the whole label on a drawing node, the fresh draw's identity tells the two apart.
    world.drawLabel = false;
    expect(observeGraph(nodes, hist(1, 1))).not.toEqual(
      observeGraph(nodes, hist(2, 3)),
    );
  });

  it('[PIN] a host whose return shape follows a value (x.a ? x : x.b) keeps the contract; the agent sees one whole placeholder in both runs, through state re-entry too', () => {
    const nodes: Expr[] = [
      { t: 'src', i: 0 },
      { t: 'src', i: 1 },
    ];
    const h = (a: Plain) => ({
      initial: [
        { kind: 'value', v: { a, b: [1] }, sens: 'fields' } as SourceSpec,
        PLAIN0,
        PLAIN0,
      ],
      writes: [{ i: 1, action: 'pick', from: 0 }] as Write[],
    });
    expect(observeGraph(nodes, h(true))).toEqual(observeGraph(nodes, h(false)));
    expect(observeGraph(nodes, h(true)).views[1][1]).toBe(PLACEHOLDER);
    expect(observeGraph(nodes, h(false)).views[1][1]).toBe(PLACEHOLDER);
  });

  // Two histories the graph T0 fuzz found while the scheduling label was being refined; each
  // stays as the witness of one refinement (see the round-5 findings in the log).
  const ALWAYS = (v: Plain): SourceSpec => ({
    kind: 'value',
    v,
    sens: 'none',
    always: true,
  });
  const PLAIN = (v: Plain): SourceSpec => ({ kind: 'value', v, sens: 'none' });

  it('[PIN] a change made inside a labeled region is labeled downstream (a fresh list is still a change)', () => {
    // n1 = ifLoading([], secret && map([], n0)) recomputes only when the secret changes, and its
    // fresh [] is a change; n2 reads n1 and must not recompute publicly because of it.
    const nodes: Expr[] = [
      {
        t: 'join',
        a: { t: 'map', a: { t: 'src', i: 0 }, body: { t: 'param' } },
        sep: { t: 'lit', v: 0 },
      },
      {
        t: 'aware',
        fn: 'ifLoading',
        args: [
          { t: 'arr', es: [] },
          {
            t: 'and',
            a: { t: 'src', i: 1 },
            b: { t: 'map', a: { t: 'arr', es: [] }, body: { t: 'dep', j: 0 } },
          },
        ],
      },
      {
        t: 'mem',
        o: { t: 'key', o: { t: 'dep', j: 1 }, k: { t: 'src', i: 0 } },
        k: 'a',
      },
    ];
    const err: SourceSpec = { kind: 'error', cause: [], sens: false };
    const h = (x: Plain, y: Plain) => ({
      initial: [PLAIN(0), ALWAYS(x), err],
      writes: [
        { i: 1, spec: ALWAYS(y) },
        { i: 0, spec: 'same' },
      ] as Write[],
    });
    expect(observeGraph(nodes, h(-1, -1))).toEqual(
      observeGraph(nodes, h(0, '')),
    );
  });

  it('[PIN] a labeled region does not label the reads it makes (the other run kept the same public reads)', () => {
    // n2 reads source 1 publicly in both runs; in one run it also recomputed in a labeled region
    // (its secret operand changed), which must not turn its source-1 dependency into a labeled one.
    const nodes: Expr[] = [
      { t: 'lit', v: 0 },
      { t: 'lit', v: 0 },
      {
        t: 'obj',
        a: {
          t: 'includes',
          a: { t: 'lit', v: [1] },
          x: { t: 'and', a: { t: 'src', i: 2 }, b: { t: 'src', i: 0 } },
        },
        b: { t: 'src', i: 1 },
      },
    ];
    const fields = (v: Plain): SourceSpec => ({
      kind: 'value',
      v,
      sens: 'fields',
    });
    const h = (x: Plain) => ({
      initial: [PLAIN(0), PLAIN({ a: 0, b: 0 }), fields(x)],
      writes: [
        { i: 0, spec: PLAIN(1) },
        { i: 1, spec: PLAIN(2) },
      ] as Write[],
    });
    expect(observeGraph(nodes, h(0))).toEqual(observeGraph(nodes, h('x')));
  });

  it('[PIN] the stale-window graph: label-aware passes; slot and structural pulls fail T0; the high-water pull fails freshness', () => {
    const nodes: Expr[] = [
      {
        t: 'cond',
        c: { t: 'src', i: 0 },
        a: { t: 'src', i: 1 },
        b: { t: 'src', i: 2 },
      },
      { t: 'bin', op: '+', a: { t: 'dep', j: 0 }, b: { t: 'lit', v: 0 } },
    ];
    const init = (v: Plain): SourceSpec[] => [
      { kind: 'value', v: true, sens: 'none' },
      { kind: 'value', v, sens: 'whole' },
      { kind: 'value', v: 5, sens: 'none' },
    ];
    const writes: Write[] = [
      { i: 0, spec: { kind: 'value', v: false, sens: 'none' } },
    ];
    const h = (v: Plain) => ({ initial: init(v), writes });
    expect(observeGraph(nodes, h(5))).toEqual(observeGraph(nodes, h(3)));
    expect(observeGraph(nodes, h(5)).views[1]).toEqual([5, 5]);
    for (const pull of ['slot', 'structural'] as const)
      expect(
        observeGraph(nodes, h(5), { equality: 'blind', pull }),
      ).not.toEqual(observeGraph(nodes, h(3), { equality: 'blind', pull }));
    const hw = runGraph(nodes, init(3), writes, {
      mode: true,
      equality: 'blind',
      pull: 'sticky',
    });
    expect(
      observeGraph(nodes, h(5), { equality: 'blind', pull: 'sticky' }).views,
    ).toEqual(hw.views);
    expect(hw.views[1]).toEqual([PLACEHOLDER, PLACEHOLDER]);
    expect(hw.fresh.map((f) => readAs('agent', f))).toEqual([5, 5]);
  });

  it('[PIN] error equality by occurrence: a label flip at equal value re-evaluates the first dependent once, mints once, and stops', () => {
    // n0 = flag ? secretFive : plainFive; n1 = parse('x') + [n0]; n2 = n1 + 1. Flag flips.
    const nodes: Expr[] = [
      {
        t: 'cond',
        c: { t: 'src', i: 0 },
        a: { t: 'src', i: 1 },
        b: { t: 'src', i: 2 },
      },
      {
        t: 'bin',
        op: '+',
        a: { t: 'call', fn: 'parse', args: [{ t: 'lit', v: 'x' }] },
        b: { t: 'arr', es: [{ t: 'dep', j: 0 }] },
      },
      { t: 'bin', op: '+', a: { t: 'dep', j: 1 }, b: { t: 'lit', v: 1 } },
    ];
    const initial: SourceSpec[] = [
      { kind: 'value', v: false, sens: 'none' },
      { kind: 'value', v: 5, sens: 'whole' },
      { kind: 'value', v: 5, sens: 'none' },
    ];
    const writes: Write[] = [
      { i: 0, spec: { kind: 'value', v: true, sens: 'none' } },
    ];
    const off = runGraph(nodes, initial, writes, { mode: false });
    const on = runGraph(nodes, initial, writes, { mode: true });
    expect(off.recomputes).toEqual([2, 1, 1]);
    expect(on.recomputes).toEqual([2, 2, 1]);
    const reports = (r: GraphRun) =>
      r.events.filter((e) => e.kind === 'report');
    expect(reports(off)).toHaveLength(1);
    expect(reports(on)).toHaveLength(2);
    // The extra mint ran in a labeled region: withholding readers see exactly mode off's count.
    expect(publicTrace(reports(on))).toEqual(publicTrace(reports(off)));
    world.errorEq = 'identity';
    expect(runGraph(nodes, initial, writes, { mode: true }).recomputes).toEqual(
      [2, 2, 2],
    );
  });

  it('[PROVEN] each killed pull breaks exact freshness on generated graphs (label-aware never does)', () => {
    const broken = { slot: 0, structural: 0, sticky: 0 };
    fc.assert(
      fc.property(graphArb, ({ nodes, initial, writes }) => {
        for (const pull of ['slot', 'structural', 'sticky'] as const) {
          const r = runGraph(nodes, initial, writes, {
            mode: true,
            equality: 'blind',
            pull,
          });
          const freshViews = r.fresh.map((f) => readAs('agent', f));
          if (
            JSON.stringify(r.views[r.views.length - 1]) !==
            JSON.stringify(freshViews)
          )
            broken[pull]++;
        }
      }),
      { numRuns: NUM_RUNS * 3 },
    );
    expect(broken.slot).toBeGreaterThan(0);
    expect(broken.structural).toBeGreaterThan(0);
    expect(broken.sticky).toBeGreaterThan(0);
  });
});

describe('error identity is typed', () => {
  it('[PIN] a source error whose cause goes from { a: NaN, b: 0 } to { a: null, b: 0 } is a change: the dependent recomputes and holds the new payload', () => {
    const nodes: Expr[] = [{ t: 'src', i: 0 }];
    const err = (cause: Plain): SourceSpec => ({ kind: 'error', cause, sens: false });
    const r = runGraph(
      nodes,
      [err({ a: NaN, b: 0 }), PLAIN0, PLAIN0],
      [{ i: 0, spec: err({ a: null, b: 0 }) }],
      { mode: true },
    );
    expect(r.recomputes).toEqual([2]);
    expect((r.finals[0] as ErrorAbs).cause).toEqual({ a: null, b: 0 });
  });

  it('[PIN] undefined and a missing key differ, -0 and 0 differ, NaN and null differ, NaN equals NaN; labels are compared beside the value, not inside it', () => {
    world.mode = true;
    const mk = (cause: unknown, hide = false) =>
      mintError('x', 'y', cause, 'm', hide, false, false);
    const fp = errorFingerprint;
    expect(fp(mk({ a: undefined }))).not.toBe(fp(mk({})));
    expect(fp(mk(-0))).not.toBe(fp(mk(0)));
    expect(fp(mk(NaN))).not.toBe(fp(mk(null)));
    expect(fp(mk(NaN))).toBe(fp(mk(NaN)));
    expect(fp(mk({ a: 1 }, true))).toBe(fp(mk({ a: 1 })));
  });
});

// ---------------------------------------------------------------------------------------------
// T3 commutation
// ---------------------------------------------------------------------------------------------

describe('T3 commutation: boxing commutes with absorption; absorbers rank above boxes', () => {
  const operandArb = fc.oneof(
    fc.constant<SourceSpec>({ kind: 'pending' }),
    valueArb.map((cause): SourceSpec => ({ kind: 'error', cause, sens: true })),
    valueArb.map((v): SourceSpec => ({ kind: 'value', v, sens: 'whole' })),
  );
  const s = (i: number): Expr => ({ t: 'src', i });
  // Every strict position: the operands are sources 0..2, all of them absorbers or boxes.
  const SHAPES: ReadonlyArray<readonly [string, Expr, number[]]> = [
    ['unary !', { t: 'un', op: '!', a: s(0) }, [0]],
    ['unary -', { t: 'un', op: '-', a: s(0) }, [0]],
    ...(['+', '===', '<', '/'] as const).map(
      (op): readonly [string, Expr, number[]] => [
        `binary ${op}`,
        { t: 'bin', op, a: s(0), b: s(1) },
        [0, 1],
      ],
    ),
    ['member', { t: 'mem', o: s(0), k: 'a' }, [0]],
    ['dynamic key', { t: 'key', o: s(0), k: s(1) }, [0, 1]],
    ['invoke', { t: 'call', fn: 'upper', args: [s(0), s(1)] }, [0, 1]],
    ['conditional test', { t: 'cond', c: s(0), a: s(1), b: s(2) }, [0]],
    ['and', { t: 'and', a: s(0), b: s(1) }, [0]],
    ['or', { t: 'or', a: s(0), b: s(1) }, [0]],
    ['coalesce', { t: 'coal', a: s(0), b: s(1) }, [0]],
    ['map receiver', { t: 'map', a: s(0), body: { t: 'param' } }, [0]],
    ['find receiver', { t: 'find', a: s(0), body: { t: 'param' } }, [0]],
    ['slice', { t: 'slice', a: s(0), s: s(1) }, [0, 1]],
    ['join', { t: 'join', a: s(0), sep: s(1) }, [0, 1]],
    ['includes', { t: 'includes', a: s(0), x: s(1) }, [0, 1]],
    ['spread', { t: 'spread', a: s(0), b: s(1) }, [0, 1]],
    ['sort', { t: 'sort', a: s(0) }, [0]],
  ];

  it('[PROVEN] [PIN S3] an op over {box, absorber} is the ranked absorber and never reads an inner value', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHAPES),
        fc.array(operandArb, { minLength: 3, maxLength: 3 }),
        ([, tree, used], specs) => {
          fc.pre(used.some((i) => specs[i].kind !== 'value'));
          world.mode = true;
          const srcs = specs.map(materialize);
          world.unboxReads = 0;
          const out = evaluate(tree, { srcs, deps: [] }, newCtx());
          world.mode = false;
          // The rank and the occurrence are the algebra's; the label only says a box was scanned.
          expect(stripLabel(out)).toBe(joinAbsorbers(used.map((i) => srcs[i])));
          expect(isLabeledAbsorber(out)).toBe(used.some((i) => isBox(srcs[i])));
          expect(world.unboxReads).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS * 5 },
    );
  });

  it('[PROVEN] [PIN S3] box(pending) is pending and box(error) is that error, to every predicate and fold', () => {
    fc.assert(
      fc.property(
        fc.array(operandArb, { minLength: 1, maxLength: 5 }),
        (specs) => {
          world.mode = true;
          const xs = specs.map(materialize);
          const boxed = xs.map(box);
          world.mode = false;
          xs.forEach((x, i) => {
            if (!isAbsorber(x)) return;
            expect(boxed[i]).toBe(x);
            for (const p of [isAbsorber, isPending, isError, isBox, rank])
              expect(p(boxed[i])).toBe(p(x));
          });
          expect(joinAbsorbers(boxed)).toBe(joinAbsorbers(xs));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// T5 idempotence and equality upward (keyed identity)
// ---------------------------------------------------------------------------------------------

type KeyedOp = readonly ['add' | 'keep' | 'move' | 'remove', unknown];

/** Toy keyed reconcile: previous keys vs next items; first occurrence of a key wins. */
const reconcile = (
  prev: readonly unknown[],
  next: readonly unknown[],
  identity: (item: unknown) => unknown,
  keyOf: (id: unknown) => unknown,
): { ops: KeyedOp[]; keys: unknown[] } => {
  const before = new Map<unknown, number>();
  prev.forEach((k, i) => before.has(k) || before.set(k, i));
  const keys: unknown[] = [];
  const seen = new Set<unknown>();
  const ops: KeyedOp[] = [];
  for (const item of next) {
    const k = keyOf(identity(item));
    if (seen.has(k)) continue;
    seen.add(k);
    const at = before.get(k);
    ops.push([
      at === undefined ? 'add' : at === keys.length ? 'keep' : 'move',
      k,
    ]);
    keys.push(k);
  }
  for (const k of before.keys()) if (!seen.has(k)) ops.push(['remove', k]);
  return { ops, keys };
};

describe('T5 idempotence and equality upward', () => {
  // Signed zeros and NaN are where `===` and `Object.is` part ways; signal equality is `Object.is`.
  const edgeValueArb = fc.oneof(valueArb, fc.constantFrom<Plain>(0, -0, NaN));

  it('[PROVEN] [PIN S7] box(box(x)) is box(x); engine equality: equal(box(a), box(b)) = equal(a, b), only the mixed case is unequal', () => {
    fc.assert(
      fc.property(edgeValueArb, edgeValueArb, (x, y) => {
        world.mode = true;
        const bx = box(x);
        expect(box(bx)).toBe(bx);
        const ctx = newCtx();
        const plain = engineEquals(ctx, x, y);
        expect(plain).toBe(Object.is(x, y));
        // Transparency between equal labels; a change of label alone is a change.
        expect(engineEquals(ctx, box(x), box(y))).toBe(plain);
        expect(engineEquals(ctx, box(x), y)).toBe(false);
        expect(engineEquals(ctx, x, box(y))).toBe(false);
        expect(engineEquals({ ...ctx, equality: 'blind' }, box(x), y)).toBe(
          plain,
        );
        // In-language `===` over boxes compares inner values and answers boxed.
        const eq = strictBinary(ctx, '===', box(x), box(y));
        expect(isBox(eq)).toBe(true);
        expect(unbox(eq)).toBe(x === y);
        world.mode = false;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Each fetch is a fresh list of fresh items whose `a` (the id) is boxed per field in mode on.
  const fetchesArb = fc.array(
    fc.array(
      fc.record(
        {
          a: fc.constantFrom<Plain>(0, 1, 2, 3, 'k', 'm'),
          b: fc.constantFrom<Plain>('x', 'y'),
        },
        { noNullPrototype: true },
      ),
      { maxLength: 5 },
    ),
    { minLength: 2, maxLength: 4 },
  );
  const identityExpr: Expr = { t: 'mem', o: { t: 'param' }, k: 'a' };

  const reconcileAll = (
    fetches: Plain[][],
    mode: boolean,
    keyBy: 'inner' | 'box',
  ): KeyedOp[][] => {
    world.mode = mode;
    try {
      let prev: unknown[] = [];
      return fetches.map((items) => {
        const live = items.map((it) =>
          materialize({
            kind: 'value',
            v: { ...(it as object) } as Plain,
            sens: 'fields',
          }),
        );
        const identity = (item: unknown) =>
          evaluate(identityExpr, { srcs: [], deps: [], param: item }, newCtx());
        const r = reconcile(
          prev,
          live,
          identity,
          keyBy === 'inner' ? canon : (id) => id,
        );
        prev = r.keys;
        return r.ops.map(([op, k]) => [op, unboxAll(k)] as const);
      });
    } finally {
      world.mode = false;
    }
  };

  it('[PROVEN] [PIN D9] a keyed container keyed by a boxed identity reconciles exactly as mode off, and as specified', () => {
    // An independent statement of keyed reconciliation over deduplicated key lists: new keys are
    // added, vanished keys removed, a common key is kept iff its position is unchanged.
    const specified = (prev: unknown[], next: unknown[]): string[] => {
      const p = [...new Set(prev)];
      const n = [...new Set(next)];
      return [
        ...n.map((k, i) =>
          !p.includes(k)
            ? `add ${String(k)}`
            : p.indexOf(k) === i
              ? `keep ${String(k)}`
              : `move ${String(k)}`,
        ),
        ...p.filter((k) => !n.includes(k)).map((k) => `remove ${String(k)}`),
      ];
    };
    fc.assert(
      fc.property(fetchesArb, (fetches) => {
        const off = reconcileAll(fetches as Plain[][], false, 'inner');
        expect(reconcileAll(fetches as Plain[][], true, 'inner')).toEqual(off);
        let prev: unknown[] = [];
        (fetches as Plain[][]).forEach((items, i) => {
          const next = items.map((it) => (it as { a: unknown }).a);
          expect(off[i].map(([op, k]) => `${op} ${String(k)}`)).toEqual(
            specified(prev, next),
          );
          prev = [...new Set(next)];
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PROVEN] [PIN S11] items read out of a boxed fetch reach the keyed container boxed and reconcile as mode off', () => {
    fc.assert(
      fc.property(fetchesArb, (fetches) => {
        const reconcileWhole = (
          mode: boolean,
        ): { ops: KeyedOp[][]; allBoxed: boolean } => {
          world.mode = mode;
          try {
            let prev: unknown[] = [];
            let allBoxed = true;
            const ops = (fetches as Plain[][]).map((items) => {
              const list = materialize({
                kind: 'value',
                v: items,
                sens: 'whole',
              });
              const live = handOn(list, shallow(list) as unknown[]);
              if (mode) allBoxed &&= live.every(isBox);
              const identity = (item: unknown) =>
                evaluate(
                  identityExpr,
                  { srcs: [], deps: [], param: item },
                  newCtx(),
                );
              const r = reconcile(prev, live, identity, canon);
              prev = r.keys;
              return r.ops.map(([op, k]) => [op, unboxAll(k)] as const);
            });
            return { ops, allBoxed };
          } finally {
            world.mode = false;
          }
        };
        const on = reconcileWhole(true);
        expect(on.ops).toEqual(reconcileWhole(false).ops);
        expect(on.allBoxed).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PIN D9] keyed by the box object itself, every re-fetch removes and re-adds every row', () => {
    const fetches: Plain[][] = [[{ a: 1, b: 'x' }], [{ a: 1, b: 'x' }]];
    expect(reconcileAll(fetches, false, 'box')[1]).toEqual([['keep', 1]]);
    expect(reconcileAll(fetches, true, 'box')[1]).toEqual([
      ['add', 1],
      ['remove', 1],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// T7 the reader table: closed union, exact cover, unlisted = deny
// ---------------------------------------------------------------------------------------------

type Reader =
  | 'agent'
  | 'telemetry'
  | 'audit'
  | 'display'
  | 'store'
  | 'relay'
  | 'persist'
  | 'connector'
  | 'clipboard'
  | 'identity'
  | 'console';
type Clearance = 'withhold' | 'clear';

const READERS = [
  'agent',
  'telemetry',
  'audit',
  'display',
  'store',
  'relay',
  'persist',
  'connector',
  'clipboard',
  'identity',
  'console',
] as const;

const CLEARANCE = {
  agent: 'withhold',
  telemetry: 'withhold',
  audit: 'withhold',
  display: 'clear',
  store: 'clear',
  relay: 'clear',
  persist: 'clear',
  connector: 'clear',
  clipboard: 'clear',
  identity: 'clear',
  // The console withholds while the mode is on, inside action code too (via the proxied console).
  console: 'withhold',
} as const satisfies Record<Reader, Clearance>;

// Type-level exact cover: the table names every reader and nothing else; the list names every reader.
type Exactly<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never]
  ? true
  : false;
const tableCoversUnion: Exactly<keyof typeof CLEARANCE, Reader> = true;
const listCoversUnion: Exactly<(typeof READERS)[number], Reader> = true;
// A table missing a reader does not type-check against the closed union.
// @ts-expect-error `identity` is missing
const missingReader: Record<Reader, Clearance> = {
  agent: 'withhold',
  telemetry: 'withhold',
  audit: 'withhold',
  display: 'clear',
  store: 'clear',
  relay: 'clear',
  persist: 'clear',
  connector: 'clear',
  clipboard: 'clear',
  console: 'withhold',
};

/** The one place readers unbox. Withholding and unlisted readers see the placeholder. */
const readAs = (reader: string, v: unknown): unknown => {
  const listed = Object.prototype.hasOwnProperty.call(CLEARANCE, reader);
  const clearance: Clearance | 'deny' = listed
    ? CLEARANCE[reader as Reader]
    : 'deny';
  if (clearance === 'clear') return unboxAll(v);
  const hide = (x: unknown): unknown => {
    if (isBox(x)) {
      if (clearance === 'deny') return coerced(x, `reader:${reader}`);
      return PLACEHOLDER;
    }
    // An absorber in a labeled position: its kind is as secret as the value it stands for.
    if (isLabeledAbsorber(x)) {
      if (clearance === 'deny') {
        if (world.policy === 'strict') throw new ToyLeakError();
        world.reports.push(`reader:${reader}`);
      }
      return PLACEHOLDER;
    }
    if (isError(x))
      return {
        kind: 'error',
        origin: x.origin,
        subclass: x.subclass,
        cause: hide(x.cause),
        renderableMessage: hide(x.renderableMessage),
      };
    if (Array.isArray(x)) return x.map(hide);
    if (isRec(x))
      return Object.fromEntries(
        Object.entries(x).map(([k, y]) => [k, hide(y)]),
      );
    return x;
  };
  return hide(v);
};

describe('T7 the reader table', () => {
  it('[PROVEN] [PIN S6] exact cover at runtime and at the type level', () => {
    expect([tableCoversUnion, listCoversUnion]).toEqual([true, true]);
    expect(missingReader).toBeDefined();
    expect(Object.keys(CLEARANCE).sort()).toEqual([...READERS].sort());
    expect(READERS.filter((r) => CLEARANCE[r] === 'withhold')).toEqual([
      'agent',
      'telemetry',
      'audit',
      'console',
    ]);
  });

  // Sources carry an unguessable token; any output a withholding reader sees must not contain it.
  const tokenSourcesArb = fc
    .tuple(tokenArb, sourcesArb)
    .map(([{ token, inner }, specs]) => ({
      token,
      specs: [
        { kind: 'value', v: inner as Plain, sens: 'whole' } as SourceSpec,
        ...specs
          .slice(1)
          .map((s) =>
            s.kind === 'value' && s.sens !== 'none'
              ? { ...s, v: [token, s.v] as Plain }
              : s,
          ),
      ],
    }));
  const hasToken = (v: unknown, token: string): boolean =>
    JSON.stringify(v ?? null)
      .toLowerCase()
      .includes(token.toLowerCase());

  it('[PROVEN] withholding readers never see the token; clearing readers see exactly the mode-off value', () => {
    fc.assert(
      fc.property(exprArb(0), tokenSourcesArb, (tree, { token, specs }) => {
        const on = run(tree, specs, true);
        const off = run(tree, specs, false);
        for (const r of READERS) {
          const seen = readAs(r, on.v);
          if (CLEARANCE[r] === 'withhold')
            expect(hasToken(seen, token)).toBe(false);
          else expect(seen).toEqual(unboxAll(off.v));
        }
        expect(world.reports).toHaveLength(0);
      }),
      { numRuns: NUM_RUNS * 15 },
    );
  });

  it('[PROVEN] an unlisted reader is denied: placeholder and a report under soft, a throw under strict', () => {
    fc.assert(
      fc.property(
        exprArb(0),
        tokenSourcesArb,
        fc.constantFrom('devtools', 'hints', 'download', 'toString'),
        (tree, { token, specs }, reader) => {
          world.reports = [];
          world.reported = new WeakSet();
          const on = run(tree, specs, true);
          const boxes = containsBox(on.v);
          expect(hasToken(readAs(reader, on.v), token)).toBe(false);
          expect(world.reports.length > 0).toBe(boxes);
          world.policy = 'strict';
          if (boxes) expect(() => readAs(reader, on.v)).toThrow(ToyLeakError);
          else expect(readAs(reader, on.v)).toEqual(unboxAll(on.v));
          world.policy = 'soft';
        },
      ),
      { numRuns: NUM_RUNS * 15 },
    );
  });
});

describe('T7 named counterexamples: payload leaks the uniform oracle agreed with', () => {
  const TOKEN = 'tok_named_counterexample';
  const secret: SourceSpec = { kind: 'value', v: TOKEN, sens: 'whole' };
  const secretList: SourceSpec = { kind: 'value', v: [TOKEN], sens: 'whole' };
  const agentSees = (tree: Expr, specs: SourceSpec[]): string => {
    const on = run(tree, specs, true);
    return JSON.stringify(readAs('agent', on.v));
  };

  it('[PIN] an error whose cause holds an object key with a box inside hides its payload', () => {
    // null[{ a: secret }]: the key is not boxed at coercion depth, but the cause carries it whole.
    const tree: Expr = {
      t: 'key',
      o: { t: 'lit', v: null },
      k: { t: 'obj', a: { t: 'src', i: 0 }, b: { t: 'lit', v: 0 } },
    };
    const specs = [secret, PLAIN0, PLAIN0];
    expect(agentSees(tree, specs)).not.toContain(TOKEN);
    const on = run(tree, specs, true).v as ErrorAbs;
    expect(isBox(on.cause)).toBe(true);
    expect(runOracle(tree, specs).l.hidden).toBe(true);
  });

  it('[PIN S11] an error minted inside an arrow over a boxed list cannot escape with a plain payload', () => {
    // secretList.map(x => [...x]): `x` is a string, the spread mints "expected a list, got <x>".
    const tree: Expr = {
      t: 'filter',
      a: { t: 'src', i: 0 },
      body: { t: 'spread', a: { t: 'param' }, b: { t: 'lit', v: [] } },
    };
    const specs = [secretList, PLAIN0, PLAIN0];
    const on = run(tree, specs, true).v;
    expect(isError(on)).toBe(true);
    expect(agentSees(tree, specs)).not.toContain(TOKEN);
    expect(isBox((on as ErrorAbs).renderableMessage)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// T9 error hiding
// ---------------------------------------------------------------------------------------------

/** Pairs every error in the mode-on result with its mode-off counterpart (same position). */
const errorPairs = (
  on: unknown,
  off: unknown,
  out: Array<[ErrorAbs, ErrorAbs]> = [],
): Array<[ErrorAbs, ErrorAbs]> => {
  const inner = shallow(on);
  if (isError(inner) && isError(off)) out.push([inner, off]);
  else if (Array.isArray(inner) && Array.isArray(off))
    inner.forEach((x, i) => errorPairs(x, off[i], out));
  else if (isRec(inner) && isRec(off))
    Object.keys(inner).forEach((k) => errorPairs(inner[k], off[k], out));
  return out;
};

describe('T9 error hiding: payload boxed, identity and rank as mode off', () => {
  it('[PROVEN] every error: same kind/origin/subclass/rank as mode off; cause and message hidden together', () => {
    let hidden = 0;
    fc.assert(
      fc.property(exprArb(0), sourcesArb, (tree, specs) => {
        const on = run(tree, specs, true);
        const off = run(tree, specs, false);
        for (const [e1, e0] of errorPairs(on.v, off.v)) {
          expect([
            e1.kind,
            e1.origin,
            e1.subclass,
            rank(e1),
            isBox(e1),
          ]).toEqual([e0.kind, e0.origin, e0.subclass, rank(e0), false]);
          expect(isBox(e1.cause)).toBe(isBox(e1.renderableMessage));
          expect(unboxAll(e1.cause)).toEqual(unboxAll(e0.cause));
          expect(unboxAll(e1.renderableMessage)).toEqual(e0.renderableMessage);
          // Folds see the bare sentinel: pending still beats it, it still beats any value or box.
          expect(joinAbsorbers([e1, PENDING])).toBe(PENDING);
          expect(joinAbsorbers([box(1), e1, 2])).toBe(e1);
          if (isBox(e1.cause)) hidden++;
        }
      }),
      { numRuns: NUM_RUNS * 5 },
    );
    expect(hidden).toBeGreaterThan(20);
  });

  it('[PROVEN] every sensitive source error hides its cause and message (required per source, not agreement)', () => {
    fc.assert(
      fc.property(valueArb, (cause) => {
        world.mode = true;
        const e = materialize({ kind: 'error', cause, sens: true }) as ErrorAbs;
        world.mode = false;
        expect([isBox(e.cause), isBox(e.renderableMessage)]).toEqual([
          true,
          true,
        ]);
        expect(e.diagnostic).toBe(sourceMessage(PLACEHOLDER));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PROVEN] the diagnostic seam: problems entries and tooltips quote labeled values as the placeholder, never the inner', () => {
    const tokenSpecArb = fc
      .tuple(
        fc.array(fc.constantFrom(...'0123456789abcdef'), {
          minLength: 12,
          maxLength: 12,
        }),
        sourcesArb,
      )
      .map(([hex, specs]) => ({
        token: `tok${hex.join('')}`,
        specs: specs.map((s, i): SourceSpec =>
          i === 0
            ? { kind: 'value', v: `tok${hex.join('')}`, sens: 'whole' }
            : s.kind === 'error' && s.sens
              ? { ...s, cause: `tok${hex.join('')}` }
              : s,
        ),
      }));
    const tooltips = (v: unknown, out: string[] = []): string[] => {
      const x = shallow(v);
      if (isError(x)) out.push(x.diagnostic);
      else if (Array.isArray(x)) x.forEach((y) => tooltips(y, out));
      else if (isRec(x)) Object.values(x).forEach((y) => tooltips(y, out));
      return out;
    };
    let quoted = 0;
    fc.assert(
      fc.property(exprArb(0), tokenSpecArb, (tree, { token, specs }) => {
        const v = observeRun(tree, specs) && run(tree, specs, true).v;
        const text = JSON.stringify([problemsOf(tree, specs), tooltips(v)]);
        expect(text.toLowerCase()).not.toContain(token);
        if (text.includes(PLACEHOLDER)) quoted++;
      }),
      { numRuns: NUM_RUNS * 3 },
    );
    expect(quoted).toBeGreaterThan(20);
  });

  it('[PIN] the diagnostic is built once at the mint: box(7) / 0 reads "cannot divide [placeholder] by zero"', () => {
    world.mode = true;
    const e = strictBinary(newCtx(), '/', box(7), 0) as ErrorAbs;
    world.mode = false;
    expect(e.diagnostic).toBe(`cannot divide ${PLACEHOLDER} by zero`);
    expect(unbox(e.renderableMessage)).toBe('cannot divide 7 by zero');
  });

  const TOKEN = 'tok_error_payload';
  // [name, tree, source 0, the text of the inner value the mode-off message echoes]
  const MINTS: ReadonlyArray<readonly [string, Expr, SourceSpec, string]> = [
    [
      'divide by zero',
      { t: 'bin', op: '/', a: { t: 'src', i: 0 }, b: { t: 'lit', v: 0 } },
      { kind: 'value', v: 7, sens: 'whole' },
      'divide 7',
    ],
    [
      'member of nullish',
      { t: 'mem', o: { t: 'src', i: 0 }, k: 'a' },
      { kind: 'value', v: null, sens: 'whole' },
      'of null',
    ],
    [
      'list op on a non-list',
      { t: 'sort', a: { t: 'src', i: 0 } },
      { kind: 'value', v: TOKEN, sens: 'whole' },
      TOKEN,
    ],
    [
      'host function throws',
      { t: 'call', fn: 'parse', args: [{ t: 'src', i: 0 }] },
      { kind: 'value', v: TOKEN, sens: 'whole' },
      TOKEN,
    ],
    [
      'error at a sensitive source',
      { t: 'src', i: 0 },
      { kind: 'error', cause: { body: TOKEN }, sens: true },
      TOKEN,
    ],
  ];

  for (const [name, tree, spec, echo] of MINTS) {
    it(`[PIN D2] ${name}: bare sentinel, boxed cause and message, mode-off payload under the box`, () => {
      const specs = [spec, PLAIN0, PLAIN0];
      world.reporter = [];
      const on = run(tree, specs, true).v as ErrorAbs;
      // The reporter channel: every mint is delivered with its cause already boxed. A source's own
      // error is unlabeled (telemetry shows it, payload hidden); a labeled mint (its occurrence
      // decided by a box) carries the label, telemetry drops it, the problems plane shows it.
      const reports = world.reporter;
      expect(reports).toHaveLength(1);
      expect(isBox(reports[0].cause)).toBe(true);
      expect(reports[0].label).toBe(spec.kind !== 'error');
      expect(telemetryReports()).toHaveLength(spec.kind === 'error' ? 1 : 0);
      expect(problemsView()).toHaveLength(1);
      expect(
        JSON.stringify([telemetryReports(), problemsView()]),
      ).not.toContain(echo);
      const off = run(tree, specs, false).v as ErrorAbs;
      expect(isError(on) && isError(off)).toBe(true);
      expect(isBox(on)).toBe(false);
      expect(isBox(on.cause) && isBox(on.renderableMessage)).toBe(true);
      expect(unbox(on.renderableMessage)).toBe(off.renderableMessage);
      expect(off.renderableMessage).toContain(echo);
      expect(JSON.stringify(readAs('agent', on))).not.toContain(echo);
      expect(JSON.stringify(readAs('telemetry', on))).toContain(PLACEHOLDER);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Named counterexamples
// ---------------------------------------------------------------------------------------------

describe('named counterexamples', () => {
  const S0: Expr = { t: 'src', i: 0 };
  const lit = (v: Plain): Expr => ({ t: 'lit', v });
  const on = (tree: Expr, s0: SourceSpec) =>
    run(tree, [s0, PLAIN0, PLAIN0], true);
  const off = (tree: Expr, s0: SourceSpec) =>
    run(tree, [s0, PLAIN0, PLAIN0], false);

  it('[PIN D1] box ? a : b takes the mode-off branch and boxes the result', () => {
    for (const v of [0, 1, '', 'x', null] as Plain[]) {
      const tree: Expr = { t: 'cond', c: S0, a: lit('a'), b: lit('b') };
      const spec: SourceSpec = { kind: 'value', v, sens: 'whole' };
      const r = on(tree, spec);
      expect(r.ctx.trace).toEqual(off(tree, spec).ctx.trace);
      expect(isBox(r.v)).toBe(true);
      expect(unbox(r.v)).toBe(v ? 'a' : 'b');
    }
  });

  it('[PIN D4] an aware host function that coerces a raw box gets the leak guard, never the value', () => {
    const token = 'tok_aware_host';
    // A trusted host function in the aware set that did not declare box handling.
    const hostLog = (x: unknown): string => `log: ${x}`;
    world.mode = true;
    const b = box(token);
    expect(hostLog(b)).toBe(`log: ${PLACEHOLDER}`);
    expect(world.reports).toHaveLength(1);
    world.policy = 'strict';
    expect(() => hostLog(box(token))).toThrow(ToyLeakError);
  });

  it('[PIN D6] box ?? x is the box itself; a boxed nullish picks x, boxed', () => {
    const tree: Expr = { t: 'coal', a: S0, b: lit('x') };
    world.mode = true;
    const srcs = [materialize({ kind: 'value', v: 'v', sens: 'whole' })];
    expect(evaluate(tree, { srcs, deps: [] }, newCtx())).toBe(srcs[0]);
    world.mode = false;
    const nullish = on(tree, { kind: 'value', v: null, sens: 'whole' }).v;
    expect(isBox(nullish)).toBe(true);
    expect(unboxAll(nullish)).toBe('x');
  });

  it('[PIN D7] [box].join(",") is boxed; [box].length is plain; the box stays in place', () => {
    const list: Expr = { t: 'arr', es: [S0, lit('y')] };
    const spec: SourceSpec = { kind: 'value', v: 'x', sens: 'whole' };
    const joined = on({ t: 'join', a: list, sep: lit(',') }, spec).v;
    expect(isBox(joined)).toBe(true);
    expect(unbox(joined)).toBe('x,y');
    const length = on({ t: 'mem', o: list, k: 'length' }, spec).v;
    expect(length).toBe(2);
    const kept = on(list, spec).v as unknown[];
    expect([isBox(kept), isBox(kept[0]), isBox(kept[1])]).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('[PIN D8] box(pending) is pending to every predicate, hook and fold', () => {
    world.mode = true;
    const b = box(PENDING);
    expect(b).toBe(PENDING);
    const ctx = newCtx();
    expect(
      evaluate(
        { t: 'aware', fn: 'isLoading', args: [S0, lit(0)] },
        { srcs: [b], deps: [] },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluate(
        { t: 'aware', fn: 'ifLoading', args: [S0, lit('fallback')] },
        { srcs: [b], deps: [] },
        ctx,
      ),
    ).toBe('fallback');
    // The algebra sees pending; the operand mix carries the box's label (see the mixing finding).
    expect(stripLabel(strictBinary(ctx, '+', b, box(1)))).toBe(PENDING);
    expect(isPending(strictBinary(ctx, '+', b, box(1)))).toBe(true);
    expect(joinAbsorbers([box(1), b])).toBe(PENDING);
    world.mode = false;
  });
});

// ---------------------------------------------------------------------------------------------
// S11 propagation, not membership
// ---------------------------------------------------------------------------------------------

describe('S11 propagation, observed at the callback', () => {
  it('[PROVEN] every argument a callback receives from a boxed list is labeled', () => {
    let seen = 0;
    fc.assert(
      fc.property(
        fc.array(valueArb, { minLength: 1, maxLength: 4 }),
        fc.constantFrom('map' as const, 'filter' as const, 'find' as const),
        exprArb(0),
        (list, op, body) => {
          world.mode = true;
          const ctx = { ...newCtx(), params: [] as unknown[] };
          try {
            evaluate(
              { t: op, a: { t: 'src', i: 0 }, body },
              { srcs: [box(list), 0, 0], deps: [] },
              ctx,
            );
          } finally {
            world.mode = false;
          }
          for (const p of ctx.params) expect(isLabeled(p)).toBe(true);
          seen += ctx.params.length;
        },
      ),
      { numRuns: NUM_RUNS },
    );
    expect(seen).toBeGreaterThan(NUM_RUNS);
  });
});

describe('S11 propagation: every element read out of a boxed container stays boxed', () => {
  const hexArb = fc
    .array(fc.constantFrom(...'0123456789abcdef'), {
      minLength: 24,
      maxLength: 24,
    })
    .map((cs) => cs.join(''));
  // A container of unguessable tokens in the shapes app data takes.
  const tokenListArb = (hex: string) =>
    fc
      .array(fc.constantFrom('s', 'r', 'l'), { minLength: 1, maxLength: 4 })
      .map((shapes) =>
        shapes.map((shape, i): Plain => {
          const tok = `tok_${hex}_${i}`;
          return shape === 's'
            ? tok
            : shape === 'r'
              ? { a: tok, b: [tok] }
              : [tok, i];
        }),
      );
  const P: Expr = { t: 'param' };
  // Arrow bodies that echo the element into results and into thrown or minted error messages.
  const ECHO: Expr[] = [
    { t: 'call', fn: 'parse', args: [P] },
    { t: 'spread', a: P, b: { t: 'lit', v: [] } },
    { t: 'key', o: { t: 'lit', v: null }, k: P },
    { t: 'bin', op: '+', a: P, b: { t: 'lit', v: 'x' } },
    { t: 'obj', a: P, b: { t: 'lit', v: 0 } },
    { t: 'call', fn: 'upper', args: [P] },
    { t: 'mem', o: P, k: 'a' },
    { t: 'join', a: P, sep: { t: 'lit', v: ',' } },
    { t: 'cond', c: P, a: P, b: { t: 'lit', v: 0 } },
    { t: 'arr', es: [P, P] },
    { t: 'sort', a: P },
    { t: 'map', a: P, body: { t: 'call', fn: 'parse', args: [P] } },
  ];
  const bodyArb = fc.oneof(fc.constantFrom(...ECHO), exprArb(0));
  const opArb = fc.constantFrom(
    'map',
    'filter',
    'find',
    'sort',
    'slice',
    'spread',
    'key',
    'mem',
  );
  const treeOf = (op: string, a: Expr, body: Expr): Expr => {
    switch (op) {
      case 'map':
      case 'filter':
      case 'find':
        return { t: op, a, body };
      case 'sort':
        return { t: 'sort', a };
      case 'slice':
        return { t: 'slice', a, s: { t: 'lit', v: 1 } };
      case 'spread':
        return { t: 'spread', a, b: { t: 'lit', v: [] } };
      case 'key':
        return { t: 'key', o: a, k: { t: 'lit', v: 0 } };
      default:
        return { t: 'mem', o: a, k: 0 };
    }
  };

  it('[PROVEN] [PIN S11] no token reaches a withholding or unlisted reader, through results or errors', () => {
    const errors = { seen: 0 };
    fc.assert(
      fc.property(
        hexArb.chain((hex) => fc.tuple(fc.constant(hex), tokenListArb(hex))),
        opArb,
        bodyArb,
        bodyArb,
        fc.constantFrom<Sensitivity>('whole', 'fields'),
        sourceArb,
        ([hex, list], op, body, outer, sens, other) => {
          const specs: SourceSpec[] = [
            { kind: 'value', v: list, sens },
            other,
            PLAIN0,
          ];
          const inner = treeOf(op, { t: 'src', i: 0 }, body);
          // The container result flows on: once as is, once through a second random arrow.
          const tree: Expr = {
            t: 'arr',
            es: [inner, { t: 'map', a: inner, body: outer }],
          };
          const on = run(tree, specs, true);
          expect(unboxAll(on.v)).toEqual(unboxAll(run(tree, specs, false).v));
          const hasError = (v: unknown): boolean => {
            const x = shallow(v);
            return (
              isError(x) ||
              (Array.isArray(x)
                ? x.some(hasError)
                : isRec(x) && Object.values(x).some(hasError))
            );
          };
          if (hasError(on.v)) errors.seen++;
          for (const r of [
            ...READERS.filter((x) => CLEARANCE[x] === 'withhold'),
            'console',
          ]) {
            const seen = JSON.stringify(readAs(r, on.v) ?? null).toLowerCase();
            expect(seen).not.toContain(hex);
          }
        },
      ),
      { numRuns: NUM_RUNS * 10 },
    );
    expect(errors.seen).toBeGreaterThan(50);
  });
});
