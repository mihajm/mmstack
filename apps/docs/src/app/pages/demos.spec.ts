import { ErrorHandler, type Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import {
  AsyncTransactionDemo,
  ComposedSaveDemo,
  ErroredDemo,
  FailedLoadDemo,
  FailedSaveDemo,
  OptimisticLikeDemo,
  OutcomeDemo,
  RevealDemo,
} from '@mmstack/demos';

/**
 * The page smoke test leaves deferred demos on their placeholders. These mount the concurrency
 * demos directly and drive each one through the behaviour its page describes.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const caught: unknown[] = [];

async function mount<T>(cmp: Type<T>): Promise<ComponentFixture<T>> {
  const fixture = TestBed.createComponent(cmp);
  fixture.detectChanges();
  await sleep(0);
  fixture.detectChanges();
  return fixture;
}

// whenStable() would wait out every load (resources hold pending tasks), so step by time instead
async function flush(fixture: ComponentFixture<unknown>, ms = 0) {
  await sleep(ms);
  fixture.detectChanges();
  await sleep(0);
  fixture.detectChanges();
}

const text = (f: ComponentFixture<unknown>) =>
  (f.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';

const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('missing element');
  (el as HTMLElement).click();
};

const buttonByText = (f: ComponentFixture<unknown>, label: string) =>
  [...(f.nativeElement as HTMLElement).querySelectorAll('button')].filter((b) =>
    b.textContent?.trim().startsWith(label),
  );

describe('concurrency demos', () => {
  beforeEach(() => {
    caught.length = 0;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ErrorHandler,
          useValue: { handleError: (e: unknown) => caught.push(e) },
        },
      ],
    });
  });

  it('errored: the in-place boundary keeps the typed note, @boundary loses it', async () => {
    const f = await mount(ErroredDemo);
    const areas = () => [
      ...(f.nativeElement as HTMLElement).querySelectorAll('textarea'),
    ];
    const [left, right] = areas();
    for (const a of [left, right]) {
      a.value = 'leave at the door';
      a.dispatchEvent(new Event('input'));
    }
    await flush(f);

    click(buttonByText(f, 'Break the price')[0]);
    await flush(f);
    expect(text(f)).toContain('The price came back as NaN');
    expect(caught.length).toBeGreaterThan(0);

    for (const b of buttonByText(f, 'Fix')) click(b);
    await flush(f);

    const after = areas();
    expect(after.length).toBe(2);
    expect(after).toContain(right); // same element, same instance
    expect(right.value).toBe('leave at the door');
    expect(after.find((a) => a !== right)?.value).toBe('');
    expect(text(f)).toContain('42.00 EUR');
  });

  it('reveal: forwards holds a ready slot behind an earlier one', async () => {
    const f = await mount(RevealDemo);
    await flush(f, 650); // Feed (500ms) is ready, Profile (1400ms) is not
    const t = text(f);
    expect(t).toContain('Loading Profile');
    expect(t).toContain('Loading Feed');
    expect(t).not.toContain('arrived');

    await flush(f, 900);
    expect(text(f).match(/arrived/g)?.length).toBe(3);
  });

  it('async transaction: the screen holds until the body settles, heldEffect runs once', async () => {
    const f = await mount(AsyncTransactionDemo);
    expect(text(f)).toContain('effect() ran 1x');
    expect(text(f)).toContain('heldEffect() ran 1x');

    click(buttonByText(f, 'Rename')[0]);
    await flush(f, 50);
    const cards = () =>
      [...(f.nativeElement as HTMLElement).querySelectorAll('.card')].map(
        (c) => c.textContent?.replace(/\s+/g, ' ') ?? '',
      );
    expect(cards()[0]).toContain('Borealis');
    expect(cards()[1]).toContain('Atlas');
    expect(text(f)).toContain('heldEffect() ran 1x');

    await flush(f, 1400);
    await flush(f, 50);
    expect(cards()[1]).toContain('Borealis');
    expect(cards()[1]).toContain('revision 2');
    expect(text(f)).toContain('completed');
    expect(text(f)).toContain('effect() ran 3x');
    expect(text(f)).toContain('heldEffect() ran 2x');

    click(buttonByText(f, 'Rename')[0]);
    await flush(f, 50);
    click(buttonByText(f, 'Abort')[0]);
    await flush(f, 50);
    expect(cards()[0]).toContain('Borealis');
    expect(text(f)).toContain('aborted (abort)');
  });

  it('*mmOutcome: a resource read inside the boundary holds it', async () => {
    const f = await mount(OutcomeDemo);
    const cards = () =>
      [...(f.nativeElement as HTMLElement).querySelectorAll('mm-suspense')].map(
        (c) => c.textContent?.replace(/\s+/g, ' ') ?? '',
      );
    expect(cards()[0]).not.toContain('Loading');
    expect(cards()[1]).toContain('Loading');

    await flush(f, 900);
    expect(cards()[1]).toContain('Ana Ruiz');
    expect(cards()[1]).not.toContain('Loading');
  });

  it('failed save: the failure stays until the next save starts', async () => {
    const f = await mount(FailedSaveDemo);
    const reject = (f.nativeElement as HTMLElement).querySelector(
      'input[type=checkbox]',
    ) as HTMLInputElement;
    reject.checked = true;
    reject.dispatchEvent(new Event('change'));
    click(buttonByText(f, 'Save')[0]);
    await flush(f, 50);
    expect(text(f)).toContain('Saving…');

    await flush(f, 800);
    await flush(f, 50);
    expect(text(f)).toContain('Saving the note');
    expect(f.nativeElement.querySelector('.banner')).not.toBeNull();

    await flush(f, 200);
    expect(f.nativeElement.querySelector('.banner')).not.toBeNull();

    reject.checked = false;
    reject.dispatchEvent(new Event('change'));
    click(buttonByText(f, 'Save')[0]);
    await flush(f, 50);
    expect(f.nativeElement.querySelector('.banner')).toBeNull();

    await flush(f, 800);
    expect(text(f)).toContain('Last saved: Call the supplier');
  });

  it('failed load: no content gets the error slot, held content keeps its rows', async () => {
    const f = await mount(FailedLoadDemo);
    const cards = () => [
      ...(f.nativeElement as HTMLElement).querySelectorAll('mm-suspense'),
    ];
    await flush(f, 700);
    await flush(f, 50);
    const [left, right] = cards();
    expect(left.textContent).toContain('Could not load the orders');
    expect(left.textContent).not.toContain('loaded on attempt');
    expect(right.textContent).toContain('loaded on attempt 1');
    expect(right.hasAttribute('data-failed')).toBe(false);

    click(right.querySelector('demo-orders-panel button'));
    await flush(f, 700);
    await flush(f, 50);
    expect(right.textContent).toContain('loaded on attempt 1');
    expect(right.textContent).toContain('orders failed to refresh');
    expect(right.hasAttribute('data-failed')).toBe(true);

    click(left.querySelector('[mmRetryFailed]'));
    click(right.querySelector('.banner button'));
    await flush(f, 700);
    await flush(f, 50);
    expect(left.textContent).toContain('loaded on attempt 2');
    expect(right.textContent).toContain('loaded on attempt 3');
    expect(right.querySelector('.banner')).toBeNull();
  });

  it('optimistic like: the guess shows at once, a failed save reverts it and latches lastFailure', async () => {
    const f = await mount(OptimisticLikeDemo);
    const btn = () =>
      (f.nativeElement as HTMLElement).querySelector('.like') as HTMLElement;
    click(btn());
    await flush(f, 50);
    expect(btn().textContent).toContain('Liked');
    expect(text(f)).toContain('on screen: true, truth: false');

    await flush(f, 1000);
    await flush(f, 50);
    expect(text(f)).toContain('on screen: true, truth: true');

    click(btn()); // the second request fails
    await flush(f, 50);
    expect(text(f)).toContain('on screen: false, truth: true');
    expect(f.nativeElement.querySelector('.banner')).toBeNull();

    await flush(f, 1000);
    await flush(f, 50);
    expect(text(f)).toContain('on screen: true, truth: true');
    expect(btn().textContent).toContain('Liked');
    expect(text(f)).toContain('That save failed');
  });

  it('composed save: guess, failed second write beside held content, then a clean retry', async () => {
    const f = await mount(ComposedSaveDemo);
    await flush(f, 500);
    await flush(f, 50);
    expect(text(f)).toContain('Ana Ruiz');
    expect(text(f)).toContain('#101 to Main St 1');

    click(buttonByText(f, 'Save')[0]);
    await flush(f, 50);
    expect(text(f)).toContain('Ana R. Cole'); // the guess, at once

    await flush(f, 900); // rename lands, the address save fails
    await flush(f, 50);
    expect(text(f)).toContain('default address failed');
    expect(text(f)).toContain('Ana R. Cole');
    expect(text(f)).toContain('Ships to Main St 1');
    expect(text(f)).toContain('#101 to Main St 1'); // still held

    click(buttonByText(f, 'Save')[0]);
    await flush(f, 50);
    // the latched failure clears when the address write starts again, not before
    expect(text(f)).toContain('default address failed');
    await flush(f, 500);
    expect(text(f)).not.toContain('default address failed');
    expect(text(f)).toContain('Ships to Main St 1'); // held while the save runs

    await flush(f, 450); // address saved, the debounced orders refresh not landed yet
    expect(text(f)).toContain('Ships to Main St 1');
    expect(text(f)).toContain('#101 to Main St 1');

    await flush(f, 1500);
    await flush(f, 50);
    expect(text(f)).toContain('Ships to Harbour Rd 7');
    expect(text(f)).toContain('#101 to Harbour Rd 7');
    expect(text(f)).not.toContain('Main St 1');
  });
});
