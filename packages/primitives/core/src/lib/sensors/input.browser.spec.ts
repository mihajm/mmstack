import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { userEvent } from 'vitest/browser';
import { focusWithin } from './focus-within';
import { idle } from './idle';
import { mousePosition } from './mouse-position';

const injector = () => TestBed.inject(Injector);

async function settle(ms = 20) {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, ms));
  TestBed.tick();
}

async function until(check: () => boolean, tries = 100) {
  for (let i = 0; i < tries && !check(); i++) await settle(10);
}

function html(markup: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = markup;
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
  window.scrollTo(0, 0);
});

describe('focusWithin with real focus', () => {
  it('follows real Tab presses into, between and out of the target', async () => {
    const root = html(
      `<button id="before">before</button>
       <div id="target"><button>one</button><button>two</button></div>
       <button id="after">after</button>`,
    );
    const target = root.querySelector('#target') as HTMLElement;
    const inside = focusWithin(target, { injector: injector() });
    (root.querySelector('#before') as HTMLElement).focus();
    await settle();
    expect(inside()).toBe(false);

    const seen: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      await userEvent.tab();
      await settle();
      seen.push(inside());
    }
    expect(seen).toEqual([true, true, false]);
    expect(document.activeElement?.id).toBe('after');
  });

  it('stays true while script moves focus between elements inside a shadow root', async () => {
    const host = html('').appendChild(document.createElement('div'));
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<div id="target"><button id="a">a</button><button id="b">b</button></div>';
    const target = shadow.querySelector('#target') as HTMLElement;
    const inside = focusWithin(target, { injector: injector() });

    (shadow.querySelector('#a') as HTMLElement).focus();
    await settle();
    expect(inside()).toBe(true);

    (shadow.querySelector('#b') as HTMLElement).focus();
    await settle();
    expect(inside()).toBe(true);

    (shadow.querySelector('#b') as HTMLElement).blur();
    await settle();
    expect(inside()).toBe(false);
  });
});

describe('idle with real activity', () => {
  const goIdle = async (sig: () => boolean) => {
    await until(() => sig());
    expect(sig()).toBe(true);
  };

  it('wakes on a real key press and a real mouse move', async () => {
    const sig = idle({ ms: 100, injector: injector() });
    await goIdle(sig);
    await userEvent.keyboard('a');
    await settle(0);
    expect(sig()).toBe(false);

    await goIdle(sig);
    await userEvent.pointer({ coords: { x: 40, y: 40 } });
    await userEvent.pointer({ coords: { x: 60, y: 70 } });
    await settle(0);
    expect(sig()).toBe(false);
  });

  it('wakes when an inner panel scrolls with no mouse move', async () => {
    const root = html(
      '<div id="panel" style="height: 100px; overflow: auto"><div style="height: 1000px"></div></div>',
    );
    const panel = root.querySelector('#panel') as HTMLElement;
    const sig = idle({ ms: 100, injector: injector() });
    await goIdle(sig);

    const scrolled = new Promise((r) =>
      panel.addEventListener('scroll', r, { once: true }),
    );
    panel.scrollTop = 300;
    await scrolled;
    await settle(0);
    expect(sig()).toBe(false);
  });
});

describe('mousePosition with a real pointer', () => {
  it('reports client and page coordinates under a real window scroll', async () => {
    html('<div style="height: 3000px; width: 10px"></div>');
    window.scrollTo(0, 500);
    await settle();
    expect(window.scrollY).toBe(500);

    const client = mousePosition({ throttle: 0, injector: injector() });
    const page = mousePosition({
      throttle: 0,
      coordinateSpace: 'page',
      injector: injector(),
    });
    await userEvent.pointer({ coords: { x: 30, y: 40 } });
    await userEvent.pointer({ coords: { x: 50, y: 60 } });
    await until(() => client.unthrottled().x === 50);
    expect([client.unthrottled(), page.unthrottled()]).toEqual([
      { x: 50, y: 60 },
      { x: 50, y: 560 },
    ]);
  });

  it('tracks moves inside a same-origin iframe given as the target', async () => {
    const frame = document.createElement('iframe');
    frame.setAttribute(
      'style',
      'position: absolute; left: 100px; top: 100px; width: 200px; height: 200px; border: 0',
    );
    const loaded = new Promise((r) => frame.addEventListener('load', r));
    frame.srcdoc = '<body style="margin:0;height:100%"></body>';
    document.body.appendChild(frame);
    await loaded;
    const doc = frame.contentDocument as Document;

    const pos = mousePosition({
      target: doc,
      throttle: 0,
      injector: injector(),
    });
    await userEvent.pointer({ target: frame, coords: { x: 5, y: 5 } });
    await userEvent.pointer({ target: frame, coords: { x: 20, y: 30 } });
    await until(() => pos.unthrottled().x !== 0);
    expect(pos.unthrottled()).toEqual({ x: 20, y: 30 });
  });
});
