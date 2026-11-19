import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, Router, type Routes } from '@angular/router';
import { provideTitleConfig } from './title-config';
import { createTitle, TitleStore } from './title-store';

@Component({ template: '' })
class Dummy {}

const pending = signal('');

const routes: Routes = [
  { path: 'home', component: Dummy, title: createTitle('Home') },
  { path: 'empty', component: Dummy },
  { path: 'blank', component: Dummy, title: createTitle(() => signal('')) },
  { path: 'wait', component: Dummy, title: createTitle(() => pending, true) },
];

function setup(providers: unknown[], documentTitle = '') {
  const setTitle = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      { provide: Title, useValue: { setTitle, getTitle: () => documentTitle } },
      provideRouter(routes),
      ...(providers as never[]),
    ],
  });
  TestBed.inject(TitleStore);
  const router = TestBed.inject(Router);
  const go = async (url: string) => {
    await router.navigateByUrl(url);
    TestBed.tick();
  };
  return { setTitle, router, go };
}

describe('title contract: config defaults', () => {
  it('provideTitleConfig() with no argument applies no prefix', async () => {
    const s = setup([provideTitleConfig()]);
    await s.go('/home');
    expect(s.setTitle).toHaveBeenLastCalledWith('Home');
  });

  it('an empty config applies no prefix', async () => {
    const s = setup([provideTitleConfig({})]);
    await s.go('/home');
    expect(s.setTitle).toHaveBeenLastCalledWith('Home');
  });

  it('a function prefix formats the title', async () => {
    const s = setup([provideTitleConfig({ prefix: (t) => `${t} | App` })]);
    await s.go('/home');
    expect(s.setTitle).toHaveBeenLastCalledWith('Home | App');
  });

  it('keeps the last known title by default', async () => {
    const s = setup([provideTitleConfig({ prefix: 'App - ' })]);
    await s.go('/home');
    await s.go('/empty');
    expect(s.setTitle).toHaveBeenLastCalledWith('App - Home');
  });

  it('without provideTitleConfig the fallback is the document title', async () => {
    const s = setup([], 'Index');
    await s.go('/empty');
    expect(s.setTitle).toHaveBeenLastCalledWith('Index');
  });
});

describe('title contract: awaitValue', () => {
  it('an empty title does not block navigation by default', async () => {
    const s = setup([provideTitleConfig()]);
    expect(await s.router.navigateByUrl('/blank')).toBe(true);
  });

  it('awaitValue holds navigation until the title has a value', async () => {
    pending.set('');
    const s = setup([provideTitleConfig()]);
    let done = false;
    const nav = s.router.navigateByUrl('/wait').then((ok) => {
      done = ok;
      return ok;
    });
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r));
    TestBed.tick();
    expect(done).toBe(false);

    pending.set('T');
    TestBed.tick();
    expect(await nav).toBe(true);
    TestBed.tick();
    expect(s.setTitle).toHaveBeenLastCalledWith('T');
  });
});
