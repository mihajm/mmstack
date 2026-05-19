import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, Router, type Routes } from '@angular/router';
import { provideTitleConfig, type TitleConfig } from './title-config';
import { createTitle, TitleStore } from './title-store';

@Component({ template: '' })
class DummyComponent {}

const reactiveTitle = signal('Reactive Initial');

const routes: Routes = [
  {
    path: 'home',
    component: DummyComponent,
    title: createTitle(() => 'Home'),
    children: [
      {
        path: 'child',
        component: DummyComponent,
        title: createTitle(() => 'Child'),
      },
    ],
  },
  {
    path: 'about',
    component: DummyComponent,
    title: createTitle(() => signal('About Us')),
  },
  {
    path: 'reactive',
    component: DummyComponent,
    title: createTitle(() => reactiveTitle),
  },
  {
    path: 'fallback',
    component: DummyComponent,
    title: 'Native Fallback',
  },
  {
    path: 'static',
    component: DummyComponent,
    title: createTitle('Static String'),
  },
  {
    path: 'empty',
    component: DummyComponent,
  },
];

function setup(
  options: {
    config?: TitleConfig;
    initialDocumentTitle?: string;
  } = {},
) {
  const titleMock = {
    setTitle: vi.fn(),
    getTitle: vi.fn(() => options.initialDocumentTitle ?? ''),
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: Title, useValue: titleMock },
      provideTitleConfig(options.config ?? { prefix: 'App - ' }),
      provideRouter(routes),
    ],
  });

  TestBed.inject(TitleStore);

  return {
    titleMock,
    router: TestBed.inject(Router),
  };
}

describe('title-store and createTitle (integration)', () => {
  it('should set configured title on navigation by using createTitle', async () => {
    const { titleMock, router } = setup();
    await router.navigateByUrl('/home');

    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenCalledWith('App - Home');
  });

  it('should set configured title on child navigation', async () => {
    const { titleMock, router } = setup();
    await router.navigateByUrl('/home/child');

    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenCalledWith('App - Child');
  });

  it('should format signal title on navigation', async () => {
    const { titleMock, router } = setup();
    await router.navigateByUrl('/about');

    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenCalledWith('App - About Us');
  });

  it('should reactively update title when signal changes', async () => {
    const { titleMock, router } = setup();
    reactiveTitle.set('Initial Reactive');
    await router.navigateByUrl('/reactive');

    TestBed.tick();
    expect(titleMock.setTitle).toHaveBeenCalledWith('App - Initial Reactive');

    reactiveTitle.set('Updated Reactive');
    TestBed.tick();
    expect(titleMock.setTitle).toHaveBeenCalledWith('App - Updated Reactive');
  });

  it('should accept a plain string passed directly to createTitle', async () => {
    const { titleMock, router } = setup();
    await router.navigateByUrl('/static');

    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenCalledWith('App - Static String');
  });

  it('should fallback to route title if createTitle is not used', async () => {
    const { titleMock, router } = setup();
    await router.navigateByUrl('/fallback');

    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenCalledWith('Native Fallback');
  });

  it('should fall back to captured getTitle() when no title is provided', async () => {
    const { titleMock, router } = setup({ initialDocumentTitle: '' });
    await router.navigateByUrl('/empty');

    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenCalledWith('');
  });
});

describe('TitleStore — initial title fallback', () => {
  it('falls back to captured Title.getTitle() when no title is set and no initialTitle is configured', async () => {
    const { titleMock, router } = setup({
      config: {},
      initialDocumentTitle: 'Index HTML Title',
    });

    await router.navigateByUrl('/empty');
    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenLastCalledWith('Index HTML Title');
  });

  it('prefers initialTitle from config over Title.getTitle()', async () => {
    const { titleMock, router } = setup({
      config: { initialTitle: 'Config Override' },
      initialDocumentTitle: 'Index HTML Title',
    });

    await router.navigateByUrl('/empty');
    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenLastCalledWith('Config Override');
  });

  it('captures Title.getTitle() once at construction and does not re-read on navigation', async () => {
    const { titleMock, router } = setup({
      config: {},
      initialDocumentTitle: 'Index HTML Title',
    });

    await router.navigateByUrl('/empty');
    TestBed.tick();
    await router.navigateByUrl('/home');
    TestBed.tick();
    await router.navigateByUrl('/empty');
    TestBed.tick();

    expect(titleMock.getTitle).toHaveBeenCalledTimes(1);
  });

  it('keepLastKnownTitle=true holds the last route-driven title when navigating to an untitled route', async () => {
    const { titleMock, router } = setup({
      config: { prefix: 'App - ', keepLastKnownTitle: true },
      initialDocumentTitle: 'Index HTML Title',
    });

    await router.navigateByUrl('/home');
    TestBed.tick();
    expect(titleMock.setTitle).toHaveBeenLastCalledWith('App - Home');

    await router.navigateByUrl('/empty');
    TestBed.tick();
    expect(titleMock.setTitle).toHaveBeenLastCalledWith('App - Home');
  });

  it('keepLastKnownTitle=false falls back to the captured initial title when navigating to an untitled route', async () => {
    const { titleMock, router } = setup({
      config: { prefix: 'App - ', keepLastKnownTitle: false },
      initialDocumentTitle: 'Index HTML Title',
    });

    await router.navigateByUrl('/home');
    TestBed.tick();
    expect(titleMock.setTitle).toHaveBeenLastCalledWith('App - Home');

    await router.navigateByUrl('/empty');
    TestBed.tick();
    expect(titleMock.setTitle).toHaveBeenLastCalledWith('Index HTML Title');
  });
});
