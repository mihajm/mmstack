import { NgTemplateOutlet } from '@angular/common';
import {
  type AfterViewChecked,
  ChangeDetectorRef,
  Component,
  Directive,
  computed,
  ErrorHandler,
  type ErrorDetails,
  inject,
  Injectable,
  input,
  PLATFORM_ID,
  signal,
  type TemplateRef,
  type Type,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { render } from '@testing-library/angular';
import { injectRenderOnRetry, MmErrored } from './errored';

class RecordingErrorHandler extends ErrorHandler {
  readonly viewErrors: { error: Error; details: ErrorDetails }[] = [];
  override handleError(): void {
    /* quiet */
  }
  override onViewError(error: Error, details: ErrorDetails): void {
    this.viewErrors.push({ error, details });
  }
}

@Injectable()
class Knobs {
  readonly bad = signal(false);
  readonly on = signal(true);
  optIn = true;
  kick = false;
  readonly leaves: object[] = [];
  /** Throws while `bad`; a retry with nothing changed reads the cached throw. */
  readonly value = computed(() => {
    if (this.bad()) throw new Error('bad');
    return 'ok';
  });
  readonly bad2 = signal(false);
  readonly label = signal('one');
  readonly value2 = computed(() => {
    const label = this.label();
    if (this.bad2()) throw new Error('bad2');
    return label;
  });
}

@Component({
  selector: 'rr-leaf',
  template: `<span class="leaf">{{ knobs.value() }}</span>`,
})
class Leaf {
  readonly knobs = inject(Knobs);
  constructor() {
    this.knobs.leaves.push(this);
  }
}

/** Throws inside a block of its own template. */
@Component({
  selector: 'rr-block-leaf',
  template: `@if (knobs.on()) {
    <span class="leaf">{{ knobs.value() }}</span>
  }`,
})
class BlockLeaf {
  readonly knobs = inject(Knobs);
  constructor() {
    this.knobs.leaves.push(this);
  }
}

/** OnPush with nothing to refresh: only traversed on the way to a dirty descendant. */
@Component({
  selector: 'rr-mid',
  imports: [Leaf],
  template: `<rr-leaf />`,
})
class Mid {}

/** OnPush, renders a template it is handed. */
@Component({
  selector: 'rr-outlet',
  imports: [NgTemplateOutlet],
  template: `<ng-container [ngTemplateOutlet]="tpl()" />`,
})
class Outlet {
  readonly tpl = input.required<TemplateRef<unknown>>();
  constructor() {
    inject(Knobs).leaves.push(this);
  }
}

const FALLBACK = `<ng-template #fb let-error><p class="fb">{{ error.message }}</p></ng-template>`;

const DEEP_HOST_TEMPLATE = `<div class="content" *mmErrored="fb"><rr-mid /></div>${FALLBACK}`;

@Component({
  selector: 'rr-deep-host',
  imports: [MmErrored, Mid],
  template: DEEP_HOST_TEMPLATE,
})
class DeepHost {
  readonly boundary = viewChild.required(MmErrored);
}

const BLOCK_HOST_TEMPLATE = `<div class="content" *mmErrored="fb"><rr-block-leaf /></div>${FALLBACK}`;

@Component({
  selector: 'rr-block-host',
  imports: [MmErrored, BlockLeaf],
  template: BLOCK_HOST_TEMPLATE,
})
class BlockHost {
  readonly boundary = viewChild.required(MmErrored);
}

/** The throwing template is declared in the content and rendered inside an OnPush child. */
const INSIDE_TPL_HOST_TEMPLATE = `<div class="content" *mmErrored="fb">
      <ng-template #t
        ><span class="leaf">{{ knobs.value() }}</span></ng-template
      >
      <rr-outlet [tpl]="t" />
    </div>
    ${FALLBACK}`;

@Component({
  selector: 'rr-inside-tpl-host',
  imports: [MmErrored, Outlet],
  template: INSIDE_TPL_HOST_TEMPLATE,
})
class InsideTplHost {
  readonly knobs = inject(Knobs);
  readonly boundary = viewChild.required(MmErrored);
}

/** The throwing template is declared by the boundary's host, outside the content. */
const SIBLING_TPL_HOST_TEMPLATE = `<ng-template #t
      ><span class="leaf">{{ knobs.value() }}</span></ng-template
    >
    <div class="content" *mmErrored="fb"><rr-outlet [tpl]="t" /></div>
    ${FALLBACK}`;

@Component({
  selector: 'rr-sibling-tpl-host',
  imports: [MmErrored, Outlet],
  template: SIBLING_TPL_HOST_TEMPLATE,
})
class SiblingTplHost {
  readonly knobs = inject(Knobs);
  readonly boundary = viewChild.required(MmErrored);
}

const INNER_TEMPLATE = `<div class="content" *mmErrored="fb"><rr-outlet [tpl]="tpl()" /></div>${FALLBACK}`;

@Component({
  selector: 'rr-inner',
  imports: [MmErrored, Outlet],
  template: INNER_TEMPLATE,
})
class Inner {
  readonly tpl = input.required<TemplateRef<unknown>>();
  readonly boundary = viewChild.required(MmErrored);
}

/** The throwing template is declared by a component above the boundary's host. */
@Component({
  selector: 'rr-outer-tpl-host',
  imports: [Inner],
  template: `<ng-template #t
      ><span class="leaf">{{ knobs.value() }}</span></ng-template
    >
    <rr-inner [tpl]="t" />`,
})
class OuterTplHost {
  readonly knobs = inject(Knobs);
  readonly inner = viewChild.required(Inner);
  readonly boundary = computed(() => this.inner().boundary());
}

/** Renders into a shadow root. */
@Component({
  selector: 'rr-shadow',
  imports: [Leaf],
  encapsulation: ViewEncapsulation.ShadowDom,
  template: `<rr-leaf />`,
})
class Shadow {}

const SHADOW_HOST_TEMPLATE = `<div class="content" *mmErrored="fb"><rr-shadow /></div>${FALLBACK}`;

@Component({
  selector: 'rr-shadow-host',
  imports: [MmErrored, Shadow],
  template: SHADOW_HOST_TEMPLATE,
})
class ShadowHost {
  readonly boundary = viewChild.required(MmErrored);
}

/** Takes children and projects none of them. */
@Component({
  selector: 'rr-swallow',
  template: `<span class="swallow"></span>`,
})
class Swallow {}

const SWALLOW_HOST_TEMPLATE = `<div class="content" *mmErrored="fb"><rr-swallow><rr-leaf /></rr-swallow></div>${FALLBACK}`;

@Component({
  selector: 'rr-swallow-host',
  imports: [MmErrored, Swallow, Leaf],
  template: SWALLOW_HOST_TEMPLATE,
})
class SwallowHost {
  readonly boundary = viewChild.required(MmErrored);
}

/** Detached from change detection: it renders only when told to. */
@Component({
  selector: 'rr-detached-leaf',
  template: `<span class="leaf">{{ knobs.value() }}</span>`,
})
class DetachedLeaf {
  readonly knobs = inject(Knobs);
  private readonly cdr = inject(ChangeDetectorRef);
  constructor() {
    this.knobs.leaves.push(this);
    this.cdr.detach();
    if (this.knobs.optIn) injectRenderOnRetry();
  }
  render(): void {
    this.cdr.detectChanges();
  }
}

const DETACHED_HOST_TEMPLATE = `<div class="content" *mmErrored="fb"><rr-detached-leaf /></div>${FALLBACK}`;

@Component({
  selector: 'rr-detached-host',
  imports: [MmErrored, DetachedLeaf],
  template: DETACHED_HOST_TEMPLATE,
})
class DetachedHost {
  readonly boundary = viewChild.required(MmErrored);
}

/** Calls retry from a hook that runs after the content's children rendered. */
@Directive({ selector: '[rrKick]' })
class Kick implements AfterViewChecked {
  private readonly knobs = inject(Knobs);
  private readonly boundary = inject(MmErrored);
  ngAfterViewChecked(): void {
    if (this.knobs.kick) this.boundary.retry();
  }
}

const KICK_HOST_TEMPLATE = `<div class="content" *mmErrored="fb"><rr-leaf /><span rrKick></span></div>${FALLBACK}`;

@Component({
  selector: 'rr-kick-host',
  imports: [MmErrored, Leaf, Kick],
  template: KICK_HOST_TEMPLATE,
})
class KickHost {
  readonly boundary = viewChild.required(MmErrored);
}

/** Throws out of the report once armed, so the interceptor fails and the render throws. */
class ThrowingErrorHandler extends RecordingErrorHandler {
  armed = false;
  override onViewError(error: Error, details: ErrorDetails): void {
    if (this.armed) throw new Error('handler-failed');
    super.onViewError(error, details);
  }
}

/** A leaf the boundary cannot find by itself that opts in. */
@Component({
  selector: 'rr-opted-leaf',
  template: `<span class="leaf">{{ knobs.value() }}</span>`,
})
class OptedLeaf {
  readonly knobs = inject(Knobs);
  constructor() {
    this.knobs.leaves.push(this);
    if (this.knobs.optIn) injectRenderOnRetry();
  }
}

/** An outlet the boundary cannot find by itself that opts in. */
@Component({
  selector: 'rr-opted-outlet',
  imports: [NgTemplateOutlet],
  template: `<ng-container [ngTemplateOutlet]="tpl()" />`,
})
class OptedOutlet {
  readonly tpl = input.required<TemplateRef<unknown>>();
  constructor() {
    const knobs = inject(Knobs);
    knobs.leaves.push(this);
    if (knobs.optIn) injectRenderOnRetry();
  }
}

const OPTED_LEAF_HOST_TEMPLATE = `<div class="content" *mmErrored="fb"><rr-swallow><rr-opted-leaf /></rr-swallow></div>${FALLBACK}`;

@Component({
  selector: 'rr-opted-leaf-host',
  imports: [MmErrored, Swallow, OptedLeaf],
  template: OPTED_LEAF_HOST_TEMPLATE,
})
class OptedLeafHost {
  readonly boundary = viewChild.required(MmErrored);
}

const OPTED_OUTLET_HOST_TEMPLATE = `<ng-template #t><span class="leaf">{{ knobs.value() }}</span></ng-template>
  <div class="content" *mmErrored="fb"><rr-swallow><rr-opted-outlet [tpl]="t" /></rr-swallow></div>${FALLBACK}`;

@Component({
  selector: 'rr-opted-outlet-host',
  imports: [MmErrored, Swallow, OptedOutlet],
  template: OPTED_OUTLET_HOST_TEMPLATE,
})
class OptedOutletHost {
  readonly knobs = inject(Knobs);
  readonly boundary = viewChild.required(MmErrored);
}

const flushWith = async (detect: () => void) => {
  for (let i = 0; i < 5; i++) {
    detect();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
  }
  detect();
};

async function setup<T>(
  host: Type<T>,
  providers: unknown[] = [],
  knobs = new Knobs(),
) {
  const { fixture, container } = await render(host, {
    providers: [
      { provide: Knobs, useValue: knobs },
      { provide: ErrorHandler, useClass: RecordingErrorHandler },
      ...(providers as never[]),
    ],
  });
  const handler = fixture.debugElement.injector.get(
    ErrorHandler,
  ) as RecordingErrorHandler;
  const settle = () => flushWith(() => fixture.detectChanges());
  await settle();
  return { fixture, container, handler, knobs, settle };
}

const isShown = (el: Element | null): boolean =>
  el !== null && (el as HTMLElement).style.display !== 'none';

type Host = { boundary: () => MmErrored };

const SHAPES: readonly [string, Type<Host>][] = [
  ['a component under a clean OnPush component', DeepHost],
  ['a block inside a nested component', BlockHost],
  ['a template declared in the content, rendered in a child', InsideTplHost],
  [
    'a template declared beside the content, rendered in a child',
    SiblingTplHost,
  ],
  ['a template declared above the host, rendered in a child', OuterTplHost],
];

describe('*mmErrored: a retry renders the faulted view again wherever it sits', () => {
  it.each(SHAPES)(
    '%s: a retry before the fix faults again and stays hidden; a retry after it shows the content',
    async (_name, host) => {
      const { fixture, container, handler, knobs, settle } = await setup(host);
      const boundary = () => fixture.componentInstance.boundary();
      expect(container.querySelector('.leaf')?.textContent).toBe('ok');

      knobs.bad.set(true);
      await settle();
      expect(handler.viewErrors.length).toBe(1);
      expect(container.querySelector('.fb')?.textContent).toBe('bad');

      boundary().retry();
      expect(handler.viewErrors.length).toBe(2);
      expect(boundary().error()?.message).toBe('bad');
      await settle();
      expect(container.querySelector('.fb')?.textContent).toBe('bad');
      expect(isShown(container.querySelector('.content'))).toBe(false);

      knobs.bad.set(false);
      boundary().retry();
      await settle();
      expect(boundary().error()).toBeUndefined();
      expect(container.querySelector('.fb')).toBeNull();
      expect(isShown(container.querySelector('.content'))).toBe(true);
      expect(container.querySelector('.leaf')?.textContent).toBe('ok');
    },
  );

  it.each(SHAPES)(
    '%s: both retries keep the instances',
    async (_name, host) => {
      const { fixture, knobs, settle } = await setup(host);
      const before = [...knobs.leaves];
      knobs.bad.set(true);
      await settle();
      fixture.componentInstance.boundary().retry();
      await settle();
      knobs.bad.set(false);
      fixture.componentInstance.boundary().retry();
      await settle();
      expect(knobs.leaves).toEqual(before);
    },
  );
});

describe('*mmErrored: a retry follows the templates, not the DOM', () => {
  const leafIn = (container: Element): Element | null =>
    container.querySelector('rr-shadow')?.shadowRoot?.querySelector('.leaf') ??
    null;

  it('a component inside a shadow root: a retry before the fix faults again, both retries keep the instances', async () => {
    const { fixture, container, handler, knobs, settle } =
      await setup(ShadowHost);
    const before = [...knobs.leaves];
    expect(leafIn(container)?.textContent).toBe('ok');
    knobs.bad.set(true);
    await settle();

    fixture.componentInstance.boundary().retry();
    await settle();
    expect(handler.viewErrors.length).toBe(2);
    expect(isShown(container.querySelector('.content'))).toBe(false);

    knobs.bad.set(false);
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(container.querySelector('.fb')).toBeNull();
    expect(leafIn(container)?.textContent).toBe('ok');
    expect(knobs.leaves).toEqual(before);
  });

  it.each([
    ['the faulted component', 'rr-leaf'],
    ['a component above it', 'rr-mid'],
    ['the content root', '.content'],
  ])(
    '%s moved elsewhere in the document: a retry before the fix faults again, both retries keep the instances',
    async (_name, selector) => {
      const { fixture, container, handler, knobs, settle } =
        await setup(DeepHost);
      const before = [...knobs.leaves];
      const content = container.querySelector('.content');
      const moved = container.querySelector(selector) as Element;
      const leaf = container.querySelector('.leaf');
      knobs.bad.set(true);
      await settle();
      document.body.appendChild(moved);

      fixture.componentInstance.boundary().retry();
      await settle();
      expect(handler.viewErrors.length).toBe(2);
      expect(container.querySelector('.fb')?.textContent).toBe('bad');
      expect(isShown(content)).toBe(false);

      knobs.bad.set(false);
      fixture.componentInstance.boundary().retry();
      await settle();
      expect(container.querySelector('.fb')).toBeNull();
      expect(isShown(content)).toBe(true);
      expect(leaf?.textContent).toBe('ok');
      expect(knobs.leaves).toEqual(before);
      moved.remove();
    },
  );
});

describe('*mmErrored: elements moved out of the content before the fault', () => {
  it.each([
    ['the faulted component', 'rr-leaf'],
    ['a component above it', 'rr-mid'],
  ])(
    '%s: hidden while faulted like the rest of the content, shown again after a clean retry',
    async (_name, selector) => {
      const { fixture, container, knobs, settle } = await setup(DeepHost);
      const moved = container.querySelector(selector) as HTMLElement;
      moved.style.display = 'inline-block';
      document.body.appendChild(moved);

      knobs.bad.set(true);
      await settle();
      expect(container.querySelector('.fb')?.textContent).toBe('bad');
      expect(moved.style.display).toBe('none');

      fixture.componentInstance.boundary().retry();
      await settle();
      expect(moved.style.display).toBe('none');

      knobs.bad.set(false);
      fixture.componentInstance.boundary().retry();
      await settle();
      expect(moved.style.display).toBe('inline-block');
      expect(
        moved.querySelector('.leaf')?.textContent ?? moved.textContent,
      ).toBe('ok');
      moved.remove();
    },
  );
});

describe('*mmErrored: a faulted view the retry cannot reach', () => {
  it('a child its parent does not project: the retry builds the content anew instead of showing the kept one', async () => {
    const { fixture, container, handler, knobs, settle } =
      await setup(SwallowHost);
    const kept = container.querySelector('.content');
    expect(knobs.leaves.length).toBe(1);
    knobs.bad.set(true);
    await settle();
    expect(handler.viewErrors.length).toBe(1);

    fixture.componentInstance.boundary().retry();
    await settle();
    // rebuilt, and the new instance faults on the same cached throw
    expect(knobs.leaves.length).toBe(2);
    expect(kept?.isConnected).toBe(false);
    expect(handler.viewErrors.length).toBe(2);
    expect(container.querySelector('.fb')?.textContent).toBe('bad');

    knobs.bad.set(false);
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(container.querySelector('.fb')).toBeNull();
    expect(isShown(container.querySelector('.content'))).toBe(true);
  });

  it.each([
    ['its own template threw', OptedLeafHost],
    [
      'a template it was handed from outside the content threw',
      OptedOutletHost,
    ],
  ] as [string, Type<Host>][])(
    'a child its parent does not project that opted in, %s: a retry before the fix faults again, both retries keep the instances',
    async (_name, host) => {
      const { fixture, container, handler, knobs, settle } = await setup(host);
      const before = [...knobs.leaves];
      knobs.bad.set(true);
      await settle();
      expect(handler.viewErrors.length).toBe(1);

      fixture.componentInstance.boundary().retry();
      await settle();
      expect(handler.viewErrors.length).toBe(2);
      expect(container.querySelector('.fb')?.textContent).toBe('bad');
      expect(isShown(container.querySelector('.content'))).toBe(false);

      knobs.bad.set(false);
      fixture.componentInstance.boundary().retry();
      await settle();
      expect(container.querySelector('.fb')).toBeNull();
      expect(isShown(container.querySelector('.content'))).toBe(true);
      expect(knobs.leaves).toEqual(before);
    },
  );

  it('the limit without opting in: a template handed to an unprojected child from outside the content is rendered a pass late, so the retry is accepted and then faults again', async () => {
    const knobs = new Knobs();
    knobs.optIn = false;
    const { fixture, container, handler, settle } = await setup(
      OptedOutletHost,
      [],
      knobs,
    );
    const boundary = fixture.componentInstance.boundary();
    knobs.bad.set(true);
    await settle();
    expect(handler.viewErrors.length).toBe(1);

    boundary.retry();
    expect(handler.viewErrors.length).toBe(1);
    expect(boundary.error()).toBeUndefined();
    // nothing of the unprojected child is in the document
    expect(container.querySelector('.leaf')).toBeNull();

    await settle();
    expect(handler.viewErrors.length).toBe(2);
    expect(boundary.error()?.message).toBe('bad');
  });

  it('a component detached from change detection that opted in: a retry before the fix faults again, both retries keep the instance', async () => {
    const { fixture, container, handler, knobs, settle } =
      await setup(DetachedHost);
    const leaf = knobs.leaves[0] as DetachedLeaf;
    leaf.render();
    expect(container.querySelector('.leaf')?.textContent).toBe('ok');

    knobs.bad.set(true);
    leaf.render();
    await settle();
    expect(handler.viewErrors.length).toBe(1);
    expect(container.querySelector('.fb')?.textContent).toBe('bad');

    fixture.componentInstance.boundary().retry();
    await settle();
    expect(handler.viewErrors.length).toBe(2);
    expect(isShown(container.querySelector('.content'))).toBe(false);

    knobs.bad.set(false);
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(container.querySelector('.fb')).toBeNull();
    expect(container.querySelector('.leaf')?.textContent).toBe('ok');
    expect(knobs.leaves).toEqual([leaf]);
  });

  it('the limit without opting in: a detached component is left as it was and the retry is accepted', async () => {
    const knobs = new Knobs();
    knobs.optIn = false;
    const { fixture, container, handler, settle } = await setup(
      DetachedHost,
      [],
      knobs,
    );
    const leaf = knobs.leaves[0] as DetachedLeaf;
    leaf.render();
    knobs.bad.set(true);
    leaf.render();
    await settle();
    expect(handler.viewErrors.length).toBe(1);

    fixture.componentInstance.boundary().retry();
    await settle();
    expect(handler.viewErrors.length).toBe(1);
    expect(container.querySelector('.fb')).toBeNull();
  });

  it('off the browser: the retry builds the content anew', async () => {
    const { fixture, container, handler, knobs, settle } = await setup(
      DeepHost,
      [{ provide: PLATFORM_ID, useValue: 'server' }],
    );
    knobs.bad.set(true);
    await settle();
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(knobs.leaves.length).toBe(2);
    expect(handler.viewErrors.length).toBe(2);
    expect(container.querySelector('.fb')?.textContent).toBe('bad');

    knobs.bad.set(false);
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(container.querySelector('.fb')).toBeNull();
    expect(container.querySelector('.leaf')?.textContent).toBe('ok');
  });
});

describe('*mmErrored: a retry that goes wrong', () => {
  it('a hook calling retry while a retry renders is ignored: one render, one report', async () => {
    const { fixture, container, handler, knobs, settle } =
      await setup(KickHost);
    knobs.bad.set(true);
    await settle();
    expect(handler.viewErrors.length).toBe(1);

    knobs.kick = true;
    fixture.componentInstance.boundary().retry();
    knobs.kick = false;
    expect(handler.viewErrors.length).toBe(2);
    await settle();
    expect(handler.viewErrors.length).toBe(2);
    expect(container.querySelector('.fb')?.textContent).toBe('bad');
    expect(isShown(container.querySelector('.content'))).toBe(false);
  });

  it('the render throws past the boundary: the content is hidden again', async () => {
    const { fixture, container, handler, knobs, settle } = await setup(
      DeepHost,
      [{ provide: ErrorHandler, useClass: ThrowingErrorHandler }],
    );
    knobs.bad.set(true);
    await settle();
    expect(container.querySelector('.fb')?.textContent).toBe('bad');

    (handler as ThrowingErrorHandler).armed = true;
    expect(() => fixture.componentInstance.boundary().retry()).toThrow(
      'handler-failed',
    );
    expect(isShown(container.querySelector('.content'))).toBe(false);
    expect(container.querySelector('.fb')?.textContent).toBe('bad');

    (handler as ThrowingErrorHandler).armed = false;
    knobs.bad.set(false);
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(container.querySelector('.fb')).toBeNull();
    expect(isShown(container.querySelector('.content'))).toBe(true);
  });
});

@Component({
  selector: 'rr-leaf2',
  template: `<span class="leaf2">{{ knobs.value2() }}</span>`,
})
class Leaf2 {
  readonly knobs = inject(Knobs);
  constructor() {
    this.knobs.leaves.push(this);
  }
}

/** Detached and opted in, reading `value2`. */
@Component({
  selector: 'rr-detached-leaf2',
  template: `<span class="dleaf">{{ knobs.value2() }}</span>`,
})
class DetachedLeaf2 {
  readonly knobs = inject(Knobs);
  private readonly cdr = inject(ChangeDetectorRef);
  constructor() {
    this.knobs.leaves.push(this);
    this.cdr.detach();
    injectRenderOnRetry();
  }
  render(): void {
    this.cdr.detectChanges();
  }
}

@Component({
  selector: 'rr-removed-host',
  imports: [MmErrored, Leaf, Leaf2],
  template: `<div class="content" *mmErrored="fb">
      @if (knobs.on()) {
        <rr-leaf />
      }
      <rr-leaf2 />
    </div>
    ${FALLBACK}`,
})
class RemovedFaulterHost {
  readonly knobs = inject(Knobs);
  readonly boundary = viewChild.required(MmErrored);
}

@Component({
  selector: 'rr-foreign-host',
  imports: [MmErrored, Leaf],
  template: `<div class="content" *mmErrored="fb">
      <div class="foreign" [innerHTML]="html"></div>
      <rr-leaf />
    </div>
    ${FALLBACK}`,
})
class ForeignDomHost {
  readonly html = '<section><b>third party</b></section>';
  readonly boundary = viewChild.required(MmErrored);
}

@Component({
  selector: 'rr-two-detached-host',
  imports: [MmErrored, DetachedLeaf2],
  template: `<div class="content" *mmErrored="fb">
      <rr-detached-leaf2 /><rr-detached-leaf2 />
    </div>
    ${FALLBACK}`,
})
class TwoDetachedHost {
  readonly boundary = viewChild.required(MmErrored);
}

@Component({
  selector: 'rr-lone',
  template: `<span class="lone">lone</span>`,
})
class Lone {
  constructor() {
    injectRenderOnRetry();
  }
}

describe('*mmErrored: what a retry tracks between faults', () => {
  it('a component that faulted, recovered and was removed does not force a rebuild for a later fault', async () => {
    const { fixture, container, knobs, settle } =
      await setup(RemovedFaulterHost);
    const boundary = fixture.componentInstance.boundary();
    knobs.bad.set(true);
    await settle();
    knobs.bad.set(false);
    boundary.retry();
    await settle();
    expect(container.querySelector('.fb')).toBeNull();

    knobs.on.set(false);
    await settle();
    const kept = [...knobs.leaves];
    knobs.bad2.set(true);
    await settle();
    expect(container.querySelector('.fb')?.textContent).toBe('bad2');
    knobs.bad2.set(false);
    boundary.retry();
    await settle();
    expect(container.querySelector('.fb')).toBeNull();
    expect(knobs.leaves).toEqual(kept);
  });

  it('content with DOM Angular did not render still retries in place', async () => {
    const { fixture, container, knobs, settle } = await setup(ForeignDomHost);
    const kept = [...knobs.leaves];
    knobs.bad.set(true);
    await settle();
    knobs.bad.set(false);
    expect(() => fixture.componentInstance.boundary().retry()).not.toThrow();
    await settle();
    expect(container.querySelector('.fb')).toBeNull();
    expect(container.querySelector('.foreign b')?.textContent).toBe(
      'third party',
    );
    expect(knobs.leaves).toEqual(kept);
  });

  it('every opted-in component under one boundary is rendered by a retry', async () => {
    const { fixture, container, knobs, settle } = await setup(TwoDetachedHost);
    const [a, b] = knobs.leaves as DetachedLeaf2[];
    a.render();
    b.render();
    knobs.bad2.set(true);
    a.render();
    await settle();
    expect(container.querySelector('.fb')?.textContent).toBe('bad2');
    knobs.label.set('two');
    knobs.bad2.set(false);
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(container.querySelector('.fb')).toBeNull();
    expect(
      [...container.querySelectorAll('.dleaf')].map((e) => e.textContent),
    ).toEqual(['two', 'two']);
  });

  it('injectRenderOnRetry with no boundary above does nothing', async () => {
    const { container } = await render(Lone);
    expect(container.querySelector('.lone')?.textContent).toBe('lone');
  });
});

@Component({
  selector: 'rr-mixed-host',
  imports: [MmErrored, Swallow, Leaf],
  template: `<div class="content" *mmErrored="fb">
      <rr-leaf /><rr-swallow><rr-leaf /></rr-swallow>
    </div>
    ${FALLBACK}`,
})
class MixedReachHost {
  readonly boundary = viewChild.required(MmErrored);
}

describe('*mmErrored: one pass, a reachable and an unreachable fault', () => {
  it('the retry rebuilds when any faulted view is out of its reach', async () => {
    const { fixture, container, knobs, settle } = await setup(MixedReachHost);
    expect(knobs.leaves.length).toBe(2);
    knobs.bad.set(true);
    await settle();
    knobs.bad.set(false);
    fixture.componentInstance.boundary().retry();
    await settle();
    expect(knobs.leaves.length).toBe(4);
    expect(container.querySelector('.fb')).toBeNull();
    expect(isShown(container.querySelector('.content'))).toBe(true);
  });
});
