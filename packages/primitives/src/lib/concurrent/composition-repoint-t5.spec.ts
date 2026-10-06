/**
 * The composition model's display part, replayed against the real `*mmTransition` and
 * `*mmErrored`. A reduced trace set: one page scope (each branch's per-view scope inherits its
 * hold), no guesses, at most two transaction bodies, two signals, one branch component whose
 * constructor reads `s1` and whose template binds the instance number, a held `s0`, the live
 * `s1` and a value computed from both. A value containing `!` is poisoned: reading it throws.
 *
 * The rules are transcribed from composition-proofs.spec.ts (`World`: render, evaluate, fault,
 * retry, swap; the undo ledger) and the hold registry (a reader first evaluated during a hold
 * starts from the pre of the earliest entry recorded since the hold began). One deliberate
 * refinement over that model: a returned body settles at the render after it returned, as the
 * real async transaction does, and a render runs to a fixpoint (the real flush is several passes).
 *
 * Compared after every step: which branch is committed, whether its fallback shows, whether its
 * content shows, and the text of every binding. Independently of the model, the real DOM must
 * show exactly one branch, and shown content must be one consistent frame with no poisoned text.
 */
/* eslint-disable @angular-eslint/component-selector */
import {
  Component,
  computed,
  ErrorHandler,
  inject,
  Injectable,
  signal,
  untracked,
} from '@angular/core';
import {
  type AsyncTransactionRef,
  injectStartTransaction,
  injectTransitionScope,
  provideTransitionScope,
  type Transaction,
  transactional,
} from '@mmstack/primitives/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { MmErrored } from './errored';
import { MmTransition } from './transition';

type Id = 'A' | 'B';
type Sig = 's0' | 's1';
const SIGS: readonly Sig[] = ['s0', 's1'];
const poisoned = (v: string) => v.includes('!');

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Options = {
  /** hide a faulted view, or leave the faulted frame on screen */
  readonly boundary: 'hide' | 'last-good-frame';
  /** the swap waits for the hold, or commits on not pending alone */
  readonly swap: 'unheld' | 'pending';
};
const REFERENCE: Options = { boundary: 'hide', swap: 'unheld' };

/** composition-proofs `LEntry`, reduced to plain signals. */
type Entry = {
  readonly tx: Id;
  readonly target: Sig;
  readonly seq: number;
  readonly pre: string;
  mine: string | undefined;
  open: boolean;
  readonly prev: Entry | undefined;
};
type Txn = {
  readonly id: Id;
  status: 'running' | 'returned' | 'settled';
  log: Entry[];
};
type Content = {
  readonly inst: number;
  /** the held `s0` reader: its linkedSignal memory */
  last: string | undefined;
  readonly dom: string[];
  hidden: boolean;
  attached: boolean;
};
type Branch = {
  readonly key: number;
  content: Content | undefined;
  fault: { kind: 'update' | 'creation'; inst: number } | undefined;
  /** the boundary mounted its content (at the branch's first render) */
  mounted: boolean;
};

class Model {
  readonly vals = new Map<Sig, string>(SIGS.map((n) => [n, `init:${n}`]));
  readonly txns = new Map<Id, Txn>();
  private readonly owners = new Map<Sig, Entry>();
  private readonly entries: Entry[] = [];
  private seqs = 0;
  private stack: Id[] = [];
  private since: number | undefined;
  private insts = 0;
  private keys = 0;
  current: Branch;
  incoming: Branch | undefined;
  readonly bad = new Set<string>();
  readonly stats = new Map<string, number>();

  constructor(readonly opt: Options) {
    this.current = this.branch();
    this.render();
  }
  bump(k: string): void {
    this.stats.set(k, (this.stats.get(k) ?? 0) + 1);
  }
  open(): Txn[] {
    return [...this.txns.values()].filter((t) => t.status !== 'settled');
  }
  get holding(): boolean {
    return this.open().length > 0;
  }
  private branch(): Branch {
    return {
      key: this.keys++,
      content: undefined,
      fault: undefined,
      mounted: false,
    };
  }

  // ─── the undo ledger (composition-proofs `record` / `finalize` / `undo`) ───────────────
  write(n: Sig, v: string): void {
    const cur = this.stack[this.stack.length - 1];
    const t = cur ? this.txns.get(cur) : undefined;
    if (t && t.status !== 'settled') {
      const own = this.owners.get(n);
      if (!(own && own.tx === t.id && own.open)) {
        if (own) this.finalize(own);
        const e: Entry = {
          tx: t.id,
          target: n,
          seq: ++this.seqs,
          pre: this.vals.get(n) as string,
          mine: undefined,
          open: true,
          prev: own,
        };
        t.log.push(e);
        this.owners.set(n, e);
        this.entries.push(e);
      }
    }
    this.vals.set(n, v);
  }
  private finalize(e: Entry): void {
    if (!e.open) return;
    e.open = false;
    e.mine = this.vals.get(e.target);
  }
  private undo(e: Entry): void {
    const owned = this.owners.get(e.target) === e;
    if (owned && this.vals.get(e.target) === e.mine)
      this.vals.set(e.target, e.pre);
    if (owned) {
      if (e.prev) this.owners.set(e.target, e.prev);
      else this.owners.delete(e.target);
    }
  }

  // ─── bodies (composition-proofs lifecycle; a returned body settles at the next render) ──
  openBody(id: Id): void {
    if (!this.holding) this.since = this.seqs;
    this.txns.set(id, { id, status: 'running', log: [] });
  }
  /** `enter`: false (and nothing runs) once the transaction settled. */
  enter(id: Id, fn: () => void): boolean {
    const t = this.txns.get(id) as Txn;
    if (t.status === 'settled') return false;
    this.stack.push(id);
    try {
      fn();
    } finally {
      this.stack.pop();
      for (const e of t.log) this.finalize(e);
    }
    return true;
  }
  bodyReturn(id: Id): void {
    const t = this.txns.get(id) as Txn;
    if (t.status === 'running') t.status = 'returned';
  }
  cancel(id: Id): void {
    const t = this.txns.get(id) as Txn;
    if (t.status !== 'settled') this.settle(t, true);
  }
  private settle(t: Txn, restore: boolean): void {
    for (const e of t.log) this.finalize(e);
    if (restore)
      for (let i = t.log.length - 1; i >= 0; i--) this.undo(t.log[i]);
    t.log = [];
    t.status = 'settled';
    if (!this.holding) this.since = undefined;
  }

  // ─── display ───────────────────────────────────────────────────────────────────────────
  /** `scope.hold(s0)`: a linkedSignal; first evaluated in a hold, the hold registry's seed. */
  private held(c: Content): string {
    const live = this.vals.get('s0') as string;
    if (c.last === undefined) {
      let seed: Entry | undefined;
      if (this.holding)
        for (const e of this.entries)
          if (e.target === 's0' && e.seq > (this.since as number))
            if (!seed || e.seq < seed.seq) seed = e;
      if (seed) this.bump('born-in-hold-seeded');
      return (c.last = seed ? seed.pre : live);
    }
    if (this.holding) return c.last;
    return (c.last = live);
  }
  /** The constructor reads `s1`: a poisoned `s1` is a creation throw. */
  private createContent(): Content | undefined {
    if (poisoned(this.vals.get('s1') as string)) return undefined;
    return {
      inst: ++this.insts,
      last: undefined,
      dom: ['', '', '', ''],
      hidden: false,
      attached: true,
    };
  }
  /** Bindings in template order; a poisoned one throws with the earlier ones already written. */
  private evaluate(c: Content): boolean {
    const s1 = this.vals.get('s1') as string;
    const bindings = [
      () => String(c.inst),
      () => this.held(c),
      () => s1,
      () => `${this.held(c)}|${s1}`,
    ];
    for (let k = 0; k < bindings.length; k++) {
      const v = bindings[k]();
      if (poisoned(v)) return false;
      c.dom[k] = v;
    }
    return true;
  }
  private fault(b: Branch, c: Content): void {
    if (this.opt.boundary === 'hide') c.hidden = true;
    c.attached = false;
    b.fault = { kind: 'update', inst: c.inst };
    this.bump('update-faults');
  }
  private renderBranch(b: Branch | undefined): void {
    if (!b) return;
    if (!b.mounted) {
      b.mounted = true;
      b.content = this.createContent();
      if (!b.content) {
        b.fault = { kind: 'creation', inst: 0 };
        this.bump('creation-faults');
        return;
      }
    }
    const c = b.content;
    if (!c || !c.attached || b.fault) return;
    if (!this.evaluate(c)) this.fault(b, c);
  }
  /** MmTransition: the incoming branch commits once it rendered and nothing holds the page. */
  private swap(): boolean {
    const inc = this.incoming;
    if (!inc || !inc.mounted) return false;
    if (this.opt.swap === 'unheld' && this.holding) {
      this.bump('swap-waits-for-hold');
      return false;
    }
    if (this.holding) this.bad.add('T5-swap-under-hold');
    if (inc.fault) this.bump('commits-faulted');
    this.bump('commits');
    this.current = inc;
    this.incoming = undefined;
    return true;
  }
  /** One frame to a fixpoint: render, swap, settle the bodies that returned, again. */
  render(): void {
    for (let pass = 0; pass < 6; pass++) {
      this.renderBranch(this.current);
      this.renderBranch(this.incoming);
      let moved = this.swap();
      const done = this.open().filter((t) => t.status === 'returned');
      for (const t of done) this.settle(t, false);
      if (done.length) moved = this.swap() || true;
      if (!moved) break;
    }
    this.check();
  }
  navigate(): void {
    if (this.incoming) this.bump('retargets');
    this.incoming = this.branch();
  }
  /** errored.ts `retry`: render the kept view now, or build it anew (creation throw or rebuild). */
  retry(rebuild: boolean): void {
    const b = this.current;
    if (!b.fault) return;
    this.bump(rebuild ? 'rebuilds' : 'retries');
    const before = this.visible();
    const kept = b.fault.kind === 'update' ? b.fault.inst : undefined;
    if (rebuild) b.content = undefined;
    let c = b.content;
    if (b.fault.kind === 'creation' || !c) {
      c = this.createContent();
      if (!c) {
        b.fault = { kind: 'creation', inst: 0 }; // the boundary now holds a creation fault
        this.bump('retry-failed');
        if (this.visible() !== before) this.bad.add('T5-retry-changed');
        return;
      }
      b.content = c;
    }
    c.hidden = false;
    c.attached = true;
    if (!this.evaluate(c)) {
      this.fault(b, c);
      this.bump('retry-failed');
      return;
    }
    if (!rebuild && kept !== undefined && kept !== c.inst)
      this.bad.add('T5-instance-lost');
    b.fault = undefined;
    this.bump(rebuild ? 'rebuild-clean' : 'retry-clean');
  }
  /** What the user sees of the committed branch. */
  visible(): string {
    const b = this.current;
    const c = b.content;
    const shown = c && !c.hidden ? c.dom.join(',') : 'hidden';
    return `${b.key}:${b.fault ? 'fallback' : '-'}:${shown}`;
  }
  /** T5: the committed content is one clean frame, or hidden behind the fallback. */
  check(): void {
    const c = this.current.content;
    if (c && !c.hidden && !consistent(c.dom)) this.bad.add('T5-torn-visible');
  }
}

/** One clean frame: nothing poisoned, the computed binding agrees with the two it reads. */
const consistent = (dom: readonly string[]): boolean =>
  dom.every((v) => !poisoned(v)) && dom[3] === `${dom[1]}|${dom[2]}`;

// ─── generated traces ────────────────────────────────────────────────────────────────────

type Write = { readonly n: Sig; readonly v: string };
type Step =
  | { readonly k: 'open'; readonly id: Id; readonly ops: readonly Write[] }
  | { readonly k: 'slice'; readonly id: Id; readonly ops: readonly Write[] }
  | { readonly k: 'foreign'; readonly w: Write }
  | { readonly k: 'return' | 'throw' | 'abort'; readonly id: Id }
  | { readonly k: 'render' | 'navigate' }
  | { readonly k: 'retry'; readonly rebuild: boolean };
type Recorded = { readonly step: Step; readonly visible: string };

/** One trace on the model; every step with what the model shows after it. */
function trace(
  seed: number,
  biased: boolean,
  opt: Options = REFERENCE,
): { readonly steps: Recorded[]; readonly model: Model } {
  const r = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const m = new Model(opt);
  const steps: Recorded[] = [];
  let uid = 0;
  const value = (by: string) => `${by}#${++uid}${r() < 0.25 ? '!' : ''}`;
  const writes = (by: Id): Write[] =>
    Array.from({ length: 1 + Math.floor(r() * 2) }, () => ({
      n: pick(SIGS),
      v: value(by),
    }));
  const apply = (ops: readonly Write[]) =>
    ops.forEach((w) => m.write(w.n, w.v));
  const run = (step: Step): void => {
    switch (step.k) {
      case 'open':
        m.openBody(step.id);
        m.enter(step.id, () => apply(step.ops));
        break;
      case 'slice':
        if (!m.enter(step.id, () => apply(step.ops))) m.bump('closed-enters');
        break;
      case 'foreign':
        m.write(step.w.n, step.w.v);
        break;
      case 'return':
        m.bodyReturn(step.id);
        break;
      case 'throw':
      case 'abort':
        m.cancel(step.id);
        break;
      case 'render':
        m.render();
        break;
      case 'navigate':
        m.navigate();
        break;
      case 'retry':
        m.retry(step.rebuild);
        m.check();
        break;
    }
    steps.push({ step, visible: m.visible() });
  };

  const ids: Id[] = r() < 0.5 ? ['A'] : ['A', 'B'];
  const scripts = new Map<Id, Step[]>(
    ids.map((id) => {
      const s: Step[] = [{ k: 'open', id, ops: writes(id) }];
      const more = Math.floor(r() * 3);
      for (let i = 0; i < more; i++)
        s.push({ k: 'slice', id, ops: writes(id) });
      s.push({ k: r() < 0.8 ? 'return' : 'throw', id });
      return [id, s];
    }),
  );
  const live = () => ids.filter((id) => (scripts.get(id) as Step[]).length);
  const opened = new Set<Id>();
  for (let turn = 0; turn < 40; turn++) {
    const x = r();
    if (x < 0.25 && live().length) {
      const id = pick(live());
      const step = (scripts.get(id) as Step[]).shift() as Step;
      opened.add(id);
      run(step);
      // a branch mounted right after a body wrote: it joins the held frame
      if (biased && step.k !== 'return' && r() < 0.4) run({ k: 'navigate' });
    } else if (x < 0.35)
      run({ k: 'foreign', w: { n: pick(SIGS), v: value('F') } });
    else if (x < 0.6) run({ k: 'render' });
    else if (x < 0.72) run({ k: 'navigate' });
    else if (x < 0.86) {
      if (biased) {
        // fix whatever is poisoned, then retry
        for (const n of SIGS)
          if (poisoned(m.vals.get(n) as string))
            run({ k: 'foreign', w: { n, v: `F#${++uid}` } });
      }
      run({ k: 'retry', rebuild: r() < 0.35 });
    } else if (x < 0.9) {
      const open = [...opened].filter(
        (id) => m.txns.get(id)?.status !== 'settled',
      );
      if (open.length) run({ k: 'abort', id: pick(open) });
    } else run({ k: 'render' });
  }
  for (const id of ids) for (const step of scripts.get(id) as Step[]) run(step);
  run({ k: 'render' });
  run({ k: 'render' });
  return { steps, model: m };
}

// ─── the real host ───────────────────────────────────────────────────────────────────────

class QuietErrorHandler extends ErrorHandler {
  override handleError(): void {
    // reported faults are expected here
  }
}

@Injectable()
class T5State {
  readonly raw = { s0: signal('init:s0'), s1: signal('init:s1') };
  readonly tx = {
    s0: transactional(this.raw.s0),
    s1: transactional(this.raw.s1),
  };
  readonly key = signal(0);
  insts = 0;
}

const check = (v: string): string => {
  if (poisoned(v)) throw new Error(`poisoned ${v}`);
  return v;
};

@Component({
  selector: 't5-content',
  template: `<i class="b">{{ inst }}</i
    ><i class="b">{{ b1() }}</i
    ><i class="b">{{ b2() }}</i
    ><i class="b">{{ b3() }}</i>`,
})
class T5Content {
  private readonly st = inject(T5State);
  private readonly held = injectTransitionScope().hold(this.st.raw.s0);
  readonly inst: number;
  protected readonly b1 = computed(() => check(this.held()));
  protected readonly b2 = computed(() => check(this.st.raw.s1()));
  protected readonly b3 = computed(() =>
    check(`${this.held()}|${this.st.raw.s1()}`),
  );
  constructor() {
    if (poisoned(untracked(this.st.raw.s1))) throw new Error('creation');
    this.inst = ++this.st.insts;
  }
}

@Component({
  selector: 't5-host',
  imports: [MmTransition, MmErrored, T5Content],
  providers: [
    provideTransitionScope(),
    T5State,
    { provide: ErrorHandler, useClass: QuietErrorHandler },
  ],
  template: `
    <div class="wrap" *mmTransition="st.key(); let k" [attr.data-key]="k">
      <ng-container *mmErrored="fb"><t5-content /></ng-container>
      <ng-template #fb let-retry="retry">
        <em class="fallback"></em>
        <button class="retry" (click)="retry()">retry</button>
        <button class="rebuild" (click)="retry({ rebuild: true })">
          rebuild
        </button>
      </ng-template>
    </div>
  `,
})
class T5Host {
  readonly st = inject(T5State);
  readonly start = injectStartTransaction();
}

const shown = (el: Element | null): el is HTMLElement =>
  el !== null && (el as HTMLElement).style.display !== 'none';

/** What the user sees, in the model's format; `torn` names what no clean frame can show. */
function seen(container: HTMLElement): { visible: string; torn?: string } {
  const wraps = [...container.querySelectorAll('.wrap')].filter(shown);
  if (wraps.length !== 1)
    return { visible: '?', torn: `${wraps.length} branches shown` };
  const w = wraps[0];
  const fallback = !!w.querySelector('.fallback');
  const content = w.querySelector('t5-content');
  const dom = shown(content)
    ? [...content.querySelectorAll('.b')].map((b) => b.textContent ?? '')
    : undefined;
  const visible = `${w.getAttribute('data-key')}:${fallback ? 'fallback' : '-'}:${dom ? dom.join(',') : 'hidden'}`;
  return dom && !consistent(dom) ? { visible, torn: visible } : { visible };
}

const flush = async (detect: () => void) => {
  for (let i = 0; i < 5; i++) {
    detect();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
  }
  detect();
};
const microtasks = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

type Replayed = {
  readonly diffs: string[];
  readonly torn: string[];
  readonly model: Model;
  readonly steps: number;
};

async function replay(seed: number, biased: boolean): Promise<Replayed> {
  const { steps, model } = trace(seed, biased);
  const { fixture, container } = await render(T5Host);
  const host = fixture.componentInstance;
  const st = host.st;
  await flush(() => fixture.detectChanges());
  const diffs: string[] = [];
  const torn: string[] = [];
  const bodies = new Map<
    Id,
    {
      ref?: AsyncTransactionRef;
      tx?: Transaction;
      end?: { ok(): void; fail(): void };
    }
  >();
  const apply = (ops: readonly Write[]) =>
    ops.forEach((w) => st.tx[w.n].set(w.v));
  const click = (cls: string) =>
    seen(container).visible !== '?' &&
    (
      [...container.querySelectorAll('.wrap')]
        .filter(shown)[0]
        ?.querySelector(`.${cls}`) as HTMLElement | null
    )?.click();

  for (let i = 0; i < steps.length; i++) {
    const { step, visible } = steps[i];
    switch (step.k) {
      case 'open': {
        const b: {
          ref?: AsyncTransactionRef;
          tx?: Transaction;
          end?: { ok(): void; fail(): void };
        } = {};
        bodies.set(step.id, b);
        b.ref = host.start(async (tx) => {
          b.tx = tx;
          apply(step.ops);
          await new Promise<void>(
            (ok, fail) =>
              (b.end = { ok, fail: () => fail(new Error(step.id)) }),
          );
        });
        break;
      }
      case 'slice': {
        const tx = bodies.get(step.id)?.tx as Transaction;
        try {
          tx.enter(() => apply(step.ops));
        } catch {
          // closed, as the model's
        }
        break;
      }
      case 'foreign':
        st.raw[step.w.n].set(step.w.v);
        break;
      case 'return':
        bodies.get(step.id)?.end?.ok();
        await microtasks();
        break;
      case 'throw':
        bodies.get(step.id)?.end?.fail();
        await microtasks();
        break;
      case 'abort':
        bodies.get(step.id)?.ref?.abort();
        break;
      case 'render':
        await flush(() => fixture.detectChanges());
        break;
      case 'navigate':
        st.key.update((k) => k + 1);
        break;
      case 'retry':
        click(step.rebuild ? 'rebuild' : 'retry');
        break;
    }
    const real = seen(container);
    if (real.torn) torn.push(`#${i} ${step.k}: ${real.torn}`);
    if (real.visible !== visible)
      diffs.push(`#${i} ${step.k}: real ${real.visible} model ${visible}`);
  }
  fixture.destroy();
  TestBed.resetTestingModule();
  return { diffs, torn, model, steps: steps.length };
}

// ─── sweeps ──────────────────────────────────────────────────────────────────────────────

const sum = (models: readonly Model[], k: string) =>
  models.reduce((n, m) => n + (m.stats.get(k) ?? 0), 0);
const badOf = (opt: Options, seeds: number) => {
  const out = new Map<string, number>();
  for (const biased of [false, true])
    for (let s = 1; s <= seeds; s++)
      for (const k of trace(s, biased, opt).model.bad)
        out.set(k, (out.get(k) ?? 0) + 1);
  return Object.fromEntries(out);
};

describe('display model (reduced): faults hide, retries change only the fallback, the swap commits once nothing holds', () => {
  it('reference: no torn frame, no swap under a hold, no lost instance (600 + 600 traces)', () => {
    expect(badOf(REFERENCE, 600)).toEqual({});
  });
  it('KILLED last good frame (leave the faulted view on screen): a torn frame shows', () => {
    expect(
      Object.keys(badOf({ ...REFERENCE, boundary: 'last-good-frame' }, 300)),
    ).toContain('T5-torn-visible');
  });
  it('KILLED the swap on not pending alone: a branch commits under the hold', () => {
    expect(
      Object.keys(badOf({ ...REFERENCE, swap: 'pending' }, 300)),
    ).toContain('T5-swap-under-hold');
  });
});

describe('RE-POINTED T5: the reduced traces replayed against the real *mmTransition and *mmErrored (40 uniform + 40 biased seeds)', () => {
  const N = 40;
  let all: Replayed[] | undefined;
  const runAll = async () => {
    if (all) return all;
    const out: Replayed[] = [];
    for (const biased of [false, true])
      for (let seed = 1; seed <= N; seed++)
        out.push(await replay(seed, biased));
    return (all = out);
  };

  it('what the user sees matches the model after every step: committed branch, fallback, content shown or hidden, every binding', async () => {
    const runs = await runAll();
    expect(
      runs
        .flatMap((r, k) => r.diffs.slice(0, 2).map((d) => `trace ${k}: ${d}`))
        .slice(0, 10),
    ).toEqual([]);
    expect(runs.reduce((n, r) => n + r.steps, 0)).toBeGreaterThan(3000);
  }, 600_000);

  it('the real DOM never shows two branches, a poisoned binding or a frame mixed from two renders', async () => {
    const runs = await runAll();
    expect(runs.flatMap((r) => r.torn).slice(0, 10)).toEqual([]);
    expect(runs.filter((r) => r.model.bad.size)).toEqual([]);
  }, 600_000);

  it('coverage: the traces reach every display path', async () => {
    const models = (await runAll()).map((r) => r.model);
    const reached = Object.fromEntries(
      [
        ['update-faults', 40],
        ['creation-faults', 20],
        ['commits-faulted', 10],
        ['retry-clean', 10],
        ['rebuild-clean', 5],
        ['retry-failed', 10],
        ['swap-waits-for-hold', 40],
        ['born-in-hold-seeded', 10],
        ['retargets', 10],
        ['commits', 100],
      ].map(([k, min]) => [k, sum(models, k as string) > (min as number)]),
    );
    expect(Object.values(reached).every(Boolean) ? {} : reached).toEqual({});
  }, 600_000);
});
