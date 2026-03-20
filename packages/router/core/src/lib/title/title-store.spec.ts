import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { provideTitleConfig } from './title-config';
import { createTitle, TitleStore } from './title-store';

@Component({ template: '' })
class DummyComponent {}

const reactiveTitle = signal('Reactive Initial');

describe('title-store and createTitle (integration)', () => {
  let titleMock: Partial<Title>;

  beforeEach(() => {
    titleMock = {
      setTitle: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: Title, useValue: titleMock },
        provideTitleConfig({ prefix: 'App - ' }),
        provideRouter([
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
            path: 'empty',
            component: DummyComponent,
          },
        ]),
      ],
    });

    TestBed.inject(TitleStore);
  });

  it('should set configured title on navigation by using createTitle', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/home');

    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenCalledWith('App - Home');
  });

  it('should set configured title on child navigation', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/home/child');

    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenCalledWith('App - Child');
  });

  it('should format signal title on navigation', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/about');

    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenCalledWith('App - About Us');
  });

  it('should reactively update title when signal changes', async () => {
    reactiveTitle.set('Initial Reactive');
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/reactive');
    
    TestBed.tick();
    expect(titleMock.setTitle).toHaveBeenCalledWith('App - Initial Reactive');

    reactiveTitle.set('Updated Reactive');
    TestBed.tick();
    expect(titleMock.setTitle).toHaveBeenCalledWith('App - Updated Reactive');
  });

  it('should fallback to route title if createTitle is not used', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/fallback');

    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenCalledWith('Native Fallback');
  });

  it('should default to empty string if no title is provided', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/empty');

    TestBed.tick();

    expect(titleMock.setTitle).toHaveBeenCalledWith('');
  });
});
