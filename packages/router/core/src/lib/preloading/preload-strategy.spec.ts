import { TestBed } from '@angular/core/testing';
import { type Route, Router } from '@angular/router';
import { firstValueFrom, of } from 'rxjs';
import { findPath } from '../util';
import { PreloadRequester } from './preload-requester';
import { PreloadStrategy } from './preload-strategy';

describe('PreloadStrategy', () => {
  let strategy: PreloadStrategy;
  let requester: PreloadRequester;
  let routerMock: Partial<Router>;
  let originalWindow: any;

  beforeEach(() => {
    routerMock = {
      config: [
        { path: 'home' },
        { path: 'user', children: [{ path: ':id' }] },
      ] as any[] as Route[],
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: routerMock },
        PreloadRequester,
        PreloadStrategy,
      ],
    });

    strategy = TestBed.inject(PreloadStrategy);
    requester = TestBed.inject(PreloadRequester);

    originalWindow = globalThis.window;
    (globalThis as any).window = {
      navigator: {
        connection: { effectiveType: '4g', saveData: false },
      },
    };
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  it('should not preload if route data disables it', async () => {
    const loadSpy = vi.fn().mockReturnValue(of(true));
    const obs$ = strategy.preload(
      { path: 'home', data: { preload: false } } as any as Route,
      loadSpy,
    );

    await firstValueFrom(obs$, { defaultValue: 'completed' });

    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('should not preload if connection is slow (2g)', async () => {
    (globalThis as any).window.navigator.connection.effectiveType = '2g';
    const loadSpy = vi.fn().mockReturnValue(of(true));
    const obs$ = strategy.preload({ path: 'home' } as any as Route, loadSpy);

    await firstValueFrom(obs$, { defaultValue: 'completed' });

    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('should not preload if connection has saveData true', async () => {
    (globalThis as any).window.navigator.connection.saveData = true;
    const loadSpy = vi.fn().mockReturnValue(of(true));
    const obs$ = strategy.preload({ path: 'home' } as any as Route, loadSpy);

    await firstValueFrom(obs$, { defaultValue: 'completed' });

    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('should preload when requester emits matching path', async () => {
    const loadSpy = vi.fn().mockReturnValue(of(true));
    const route = (routerMock.config as Route[])[0] as any as Route; // path: 'home'

    const obs$ = strategy.preload(route, loadSpy);

    const req = firstValueFrom(obs$, { defaultValue: 'completed' });

    expect(loadSpy).not.toHaveBeenCalled();

    requester.startPreload('home');

    await req;

    expect(loadSpy).toHaveBeenCalled();
  });

  it('should preload when requester emits predicate matching path', async () => {
    const loadSpy = vi.fn().mockReturnValue(of(true));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const route = (routerMock.config as Route[])[1]
      .children![0] as any as Route; // path: ':id'

    const obs$ = strategy.preload(route, loadSpy);

    const req = firstValueFrom(obs$, { defaultValue: 'completed' });

    expect(loadSpy).not.toHaveBeenCalled();

    // Matches dynamic parameter pattern via predicate
    requester.startPreload('user/123');

    await req;

    expect(loadSpy).toHaveBeenCalled();
  });

  it('should safely fallback if window/navigator not present', async () => {
    (globalThis as any).window = undefined;

    const loadSpy = vi.fn().mockReturnValue(of(true));
    const route = (routerMock.config as Route[])[0] as any as Route;

    const obs$ = strategy.preload(route, loadSpy);
    const req = firstValueFrom(obs$, { defaultValue: 'completed' });

    requester.startPreload('home');

    await req;

    expect(loadSpy).toHaveBeenCalled();
  });

  it('should not throw if loading.has is called', async () => {
    const route = (routerMock.config as Route[])[0] as any as Route;
    const fp = findPath(routerMock.config as Route[], route);

    (strategy as any).loading.add(fp);

    const loadSpy = vi.fn().mockReturnValue(of(true));

    const obs$ = strategy.preload(route, loadSpy);
    await firstValueFrom(obs$, { defaultValue: 'completed' });

    expect(loadSpy).not.toHaveBeenCalled(); // Returns EMPTY because of loading.has('home')
  });
});
