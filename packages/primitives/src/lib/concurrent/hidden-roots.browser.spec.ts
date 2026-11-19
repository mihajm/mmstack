import {
  Component,
  computed,
  inject,
  InjectionToken,
  input,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { registerResource } from '@mmstack/primitives/core';
import { MmActivity } from './activity';
import { MmTransition } from './transition';

type FakeRef = ResourceRef<unknown> & {
  status: WritableSignal<ResourceStatus>;
};

function loadingRef(): FakeRef {
  const status = signal<ResourceStatus>('loading');
  return {
    status,
    value: signal(undefined),
    isLoading: computed(() => status() === 'loading'),
    hasValue: () => status() === 'resolved',
    error: signal(undefined),
    reload: () => true,
    destroy: () => undefined,
  } as unknown as FakeRef;
}

const LOAD = new InjectionToken<FakeRef>('load');

@Component({ selector: 'hr-load', template: `` })
class Load {
  constructor() {
    registerResource(inject(LOAD), { suspends: false });
  }
}

@Component({ selector: 'hr-label', template: `cmp-{{ v() }}` })
class Label {
  readonly v = input.required<string>();
}

@Component({
  selector: 'hr-transition-host',
  imports: [MmTransition, Load, Label],
  template: `
    <section>
      <div *mmTransition="tab(); let t">root-{{ t }}<hr-load /></div>
      <ng-container *mmTransition="tab(); let t">
        <span>child-{{ t }}</span>
        text-{{ t }}
        @if (t) {
          <span>if-{{ t }}</span>
          if-text-{{ t }}
        }
        <ng-container
          ><span>nested-{{ t }}</span></ng-container
        >
        <hr-label [v]="t" />
        <hr-load />
      </ng-container>
    </section>
  `,
})
class TransitionHost {
  readonly tab = signal('a');
}

@Component({
  selector: 'hr-activity-host',
  imports: [MmActivity, Label],
  template: `
    <section>
      <div *mmActivity="show()">root-x</div>
      <ng-container *mmActivity="show()">
        <span>child-x</span>
        text-x
        @if (show() || !show()) {
          <span>if-x</span>
          if-text-x
        }
        <ng-container><span>nested-x</span></ng-container>
        <hr-label v="x" />
      </ng-container>
    </section>
  `,
})
class ActivityHost {
  readonly show = signal(true);
}

@Component({
  selector: 'hr-element-host',
  imports: [MmTransition, MmActivity, Load],
  template: `
    <div *mmTransition="tab(); let t">root-{{ t }}<hr-load /></div>
    <div *mmActivity="tab() === 'a'">kept</div>
  `,
})
class ElementRootHost {
  readonly tab = signal('a');
}

function visibleTexts(root: Element): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim();
    if (!text) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    if (range.getClientRects().length > 0) out.push(text);
  }
  return out.sort();
}

async function settle(fixture: { detectChanges(): void }) {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  }
}

describe('hidden roots in a real browser', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());
  const warnings = (prefix: string) =>
    warn.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith(prefix))
      .length;

  it('*mmTransition hides element roots and the elements an ng-container root holds, but not its text roots or the content of a block placed at the root', async () => {
    const ref = loadingRef();
    TestBed.configureTestingModule({
      providers: [{ provide: LOAD, useValue: ref }],
    });
    const fixture = TestBed.createComponent(TransitionHost);
    document.body.appendChild(fixture.nativeElement);
    await settle(fixture);
    const before = visibleTexts(fixture.nativeElement);

    fixture.componentInstance.tab.set('b');
    await settle(fixture);

    const during = visibleTexts(fixture.nativeElement);
    expect(during.filter((t) => t.endsWith('-a'))).toEqual(
      before.filter((t) => t.endsWith('-a')),
    );
    expect(during.filter((t) => t.endsWith('-b'))).toEqual([
      'if-b',
      'if-text-b',
      'text-b',
    ]);
    expect(warnings('*mmTransition')).toBe(1);

    ref.status.set('resolved');
    await settle(fixture);
    expect(visibleTexts(fixture.nativeElement)).toEqual([
      'child-b',
      'cmp-b',
      'if-b',
      'if-text-b',
      'nested-b',
      'root-b',
      'text-b',
    ]);
    fixture.destroy();
  });

  it('*mmActivity hides the same roots *mmTransition does and leaves text roots showing', async () => {
    const fixture = TestBed.createComponent(ActivityHost);
    document.body.appendChild(fixture.nativeElement);
    await settle(fixture);
    expect(visibleTexts(fixture.nativeElement)).toEqual([
      'child-x',
      'cmp-x',
      'if-text-x',
      'if-x',
      'nested-x',
      'root-x',
      'text-x',
    ]);

    fixture.componentInstance.show.set(false);
    await settle(fixture);
    expect(visibleTexts(fixture.nativeElement)).toEqual([
      'if-text-x',
      'text-x',
    ]);
    expect(warnings('*mmActivity')).toBe(1);

    fixture.componentInstance.show.set(true);
    await settle(fixture);
    fixture.componentInstance.show.set(false);
    await settle(fixture);
    expect(warnings('*mmActivity')).toBe(1);
    fixture.destroy();
  });

  it('element roots hide fully and raise no warning', async () => {
    const ref = loadingRef();
    TestBed.configureTestingModule({
      providers: [{ provide: LOAD, useValue: ref }],
    });
    const fixture = TestBed.createComponent(ElementRootHost);
    document.body.appendChild(fixture.nativeElement);
    await settle(fixture);
    fixture.componentInstance.tab.set('b');
    await settle(fixture);
    expect(visibleTexts(fixture.nativeElement)).toEqual(['root-a']);
    expect(warn).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
