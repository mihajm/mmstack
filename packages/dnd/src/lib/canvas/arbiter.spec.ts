import { arbitrate } from './arbiter';

function surfaceWith(html: string): HTMLElement {
  const surface = document.createElement('div');
  surface.innerHTML = html;
  document.body.appendChild(surface);
  return surface;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('canvas arbiter', () => {
  it('classifies a press on empty surface as marquee', () => {
    const surface = surfaceWith('<div class="bg"></div>');
    expect(arbitrate(surface.querySelector('.bg'), surface)).toEqual({
      mode: 'marquee',
    });
    expect(arbitrate(surface, surface)).toEqual({ mode: 'marquee' });
  });

  it('classifies a press on an item (or anything inside it) as move', () => {
    const surface = surfaceWith(
      '<div data-mm-canvas-item="a"><span class="label">A</span></div>',
    );
    const itemEl = surface.querySelector('[data-mm-canvas-item]');
    const label = surface.querySelector('.label');
    expect(arbitrate(itemEl, surface)).toEqual({ mode: 'move', itemEl });
    expect(arbitrate(label, surface)).toEqual({ mode: 'move', itemEl });
  });

  it('classifies a move handle as move on its item', () => {
    const surface = surfaceWith(
      '<div data-mm-canvas-item="a"><div data-mm-canvas-handle><i class="grip"></i></div></div>',
    );
    const itemEl = surface.querySelector('[data-mm-canvas-item]');
    expect(arbitrate(surface.querySelector('.grip'), surface)).toEqual({
      mode: 'move',
      itemEl,
    });
  });

  it('resize and rotate handles win over the item they sit inside', () => {
    const surface = surfaceWith(
      `<div data-mm-canvas-item="a">
         <div data-mm-canvas-resize="nw"></div>
         <div data-mm-canvas-rotate></div>
       </div>`,
    );
    expect(
      arbitrate(surface.querySelector('[data-mm-canvas-resize]'), surface),
    ).toEqual({ mode: 'resize', direction: 'nw' });
    expect(
      arbitrate(surface.querySelector('[data-mm-canvas-rotate]'), surface),
    ).toEqual({ mode: 'rotate' });
  });

  it('selection chrome outside any item still resizes/rotates', () => {
    const surface = surfaceWith(
      `<div class="chrome"><div data-mm-canvas-resize="e"></div></div>
       <div data-mm-canvas-item="a"></div>`,
    );
    expect(
      arbitrate(surface.querySelector('[data-mm-canvas-resize]'), surface),
    ).toEqual({ mode: 'resize', direction: 'e' });
  });

  it('falls back to se for an unknown resize direction', () => {
    const surface = surfaceWith('<div data-mm-canvas-resize="diag"></div>');
    expect(
      arbitrate(surface.querySelector('[data-mm-canvas-resize]'), surface),
    ).toEqual({ mode: 'resize', direction: 'se' });
  });

  it('a move handle outside any item is a dead press → marquee', () => {
    const surface = surfaceWith('<div data-mm-canvas-handle></div>');
    expect(
      arbitrate(surface.querySelector('[data-mm-canvas-handle]'), surface),
    ).toEqual({ mode: 'marquee' });
  });

  it('an origin outside the surface is marquee (no cross-surface capture)', () => {
    const surface = surfaceWith('<div></div>');
    const foreign = document.createElement('div');
    foreign.setAttribute('data-mm-canvas-item', 'x');
    document.body.appendChild(foreign);
    expect(arbitrate(foreign, surface)).toEqual({ mode: 'marquee' });
    expect(arbitrate(null, surface)).toEqual({ mode: 'marquee' });
  });
});
