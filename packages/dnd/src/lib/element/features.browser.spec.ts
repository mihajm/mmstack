import { mount, nativeDrag, until } from '../testing/browser';
import { FeaturesExample } from '../testing/fixtures/features';

const sectionZone = (root: HTMLElement, heading: string) =>
  Array.from(root.querySelectorAll('section'))
    .find((s) => s.textContent?.includes(heading))
    ?.querySelector('.zone') as HTMLElement;

describe('features: drag handle, conditional drop', () => {
  it('drag handle: the grip drags, the body does not', async () => {
    const root = (await mount(FeaturesExample)).nativeElement as HTMLElement;
    const grip = root.querySelector('.grip') as HTMLElement;
    const body = root.querySelector('.box .body') as HTMLElement;
    const target = sectionZone(root, 'Drag handle');

    await nativeDrag(body, target);
    await until(() => expect(target.textContent).toMatch(/handle target/));

    await nativeDrag(grip, target);
    await until(() => expect(target.textContent).toMatch(/dropped/));
  });

  it('canDrop: accepts the allowed chip, rejects the blocked one', async () => {
    const root = (await mount(FeaturesExample)).nativeElement as HTMLElement;
    const zone = sectionZone(root, 'Conditional drop');

    await nativeDrag(root.querySelector('.chip.ok') as HTMLElement, zone);
    await until(() => expect(zone.textContent).toMatch(/accepted: allowed/));

    await nativeDrag(root.querySelector('.chip.no') as HTMLElement, zone);
    await until(() => expect(zone.textContent).toMatch(/accepted: allowed/));
  });
});
