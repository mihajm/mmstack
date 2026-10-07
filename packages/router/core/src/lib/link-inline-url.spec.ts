import { provideLocationMocks } from '@angular/common/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Params } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { injectTriggerPreload, Link } from './link';
import { PreloadRequester } from './preloading';

@Component({ selector: 'mm-blank', template: `` })
class Blank {}

@Component({
  selector: 'mm-link-host',
  imports: [Link],
  template: `<a
    class="l"
    [mmLink]="link()"
    [fragment]="fragment()"
    [queryParams]="queryParams()"
    [queryParamsHandling]="handling()"
    >go</a
  >`,
})
class Host {
  readonly link = signal<string | any[]>('/docs/page');
  readonly fragment = signal<string | undefined>(undefined);
  readonly queryParams = signal<Params | undefined>(undefined);
  readonly handling = signal<'merge' | 'preserve' | '' | undefined>(undefined);
}

@Component({
  selector: 'mm-self-link-page',
  imports: [Link],
  template: `<a class="self" mmLink="#install">self</a
    ><a class="self-q" mmLink="?tab=api">q</a>`,
})
class SelfLinkPage {}

describe('mmLink inline ?query and #fragment', () => {
  let startPreload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    startPreload = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'docs/page', component: SelfLinkPage },
          { path: '**', component: Blank },
        ]),
        provideLocationMocks(),
        { provide: PreloadRequester, useValue: { startPreload } },
      ],
    });
  });

  function setup(init?: (h: Host) => void) {
    const fixture = TestBed.createComponent(Host);
    init?.(fixture.componentInstance);
    fixture.detectChanges();
    const a = fixture.nativeElement.querySelector('.l') as HTMLAnchorElement;
    return { fixture, host: fixture.componentInstance, a };
  }

  async function click(a: HTMLElement) {
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    await TestBed.inject(Router).navigated;
    await new Promise((r) => setTimeout(r));
  }

  function current() {
    const router = TestBed.inject(Router);
    const tree = router.parseUrl(router.url);
    return {
      url: router.url,
      path: tree.root.children['primary']?.segments.map((s) => s.path),
      queryParams: tree.queryParams,
      fragment: tree.fragment,
    };
  }

  it('turns an inline #fragment into a real fragment (href and navigation)', async () => {
    const { a } = setup((h) => h.link.set('/docs/page#install'));

    expect(a.getAttribute('href')).toBe('/docs/page#install');
    expect(a.getAttribute('href')).not.toContain('%23');

    await click(a);
    expect(current()).toEqual({
      url: '/docs/page#install',
      path: ['docs', 'page'],
      queryParams: {},
      fragment: 'install',
    });
  });

  it('turns an inline ?query into real query params, repeated keys become arrays', async () => {
    const { a } = setup((h) => h.link.set('/docs/page?tab=api&t=a&t=b'));

    expect(a.getAttribute('href')).toBe('/docs/page?tab=api&t=a&t=b');
    expect(a.getAttribute('href')).not.toContain('%3F');

    await click(a);
    expect(current()).toEqual({
      url: '/docs/page?tab=api&t=a&t=b',
      path: ['docs', 'page'],
      queryParams: { tab: 'api', t: ['a', 'b'] },
      fragment: null,
    });
  });

  it('handles query and fragment together', async () => {
    const { a } = setup((h) => h.link.set('/docs/page?tab=api#install'));

    expect(a.getAttribute('href')).toBe('/docs/page?tab=api#install');
    await click(a);
    expect(current().queryParams).toEqual({ tab: 'api' });
    expect(current().fragment).toBe('install');
    expect(current().path).toEqual(['docs', 'page']);
  });

  it('treats a ? after the # as part of the fragment', () => {
    const { a } = setup((h) => h.link.set('/docs/page#a?b'));
    const tree = TestBed.inject(Router).parseUrl(a.getAttribute('href') ?? '');
    expect(tree.fragment).toBe('a?b');
    expect(tree.queryParams).toEqual({});
  });

  it('decodes a percent-encoded inline fragment once', async () => {
    const { a } = setup((h) => h.link.set('/docs/page#has%20space'));
    await click(a);
    expect(current().fragment).toBe('has space');
  });

  it('lets an explicit fragment input win over the inline one', async () => {
    const { a } = setup((h) => {
      h.link.set('/docs/page?tab=api#inline');
      h.fragment.set('explicit');
    });

    expect(a.getAttribute('href')).toBe('/docs/page?tab=api#explicit');
    await click(a);
    expect(current().fragment).toBe('explicit');
    expect(current().queryParams).toEqual({ tab: 'api' });
  });

  it('merges explicit queryParams over inline ones (explicit keys win)', async () => {
    const { a } = setup((h) => {
      h.link.set('/docs/page?x=1&y=2');
      h.queryParams.set({ y: '9', z: '3' });
    });

    await click(a);
    expect(current().queryParams).toEqual({ x: '1', y: '9', z: '3' });
  });

  it('applies queryParamsHandling to the combined params', async () => {
    await TestBed.inject(Router).navigateByUrl('/start?keep=1&y=old');
    const { a } = setup((h) => {
      h.link.set('/docs/page?y=new');
      h.handling.set('merge');
    });

    await click(a);
    expect(current().queryParams).toEqual({ keep: '1', y: 'new' });
  });

  it('leaves strings without ? or # and their explicit inputs alone', async () => {
    const { a } = setup((h) => {
      h.link.set('/docs/page');
      h.fragment.set('f');
      h.queryParams.set({ q: '1' });
    });

    expect(a.getAttribute('href')).toBe('/docs/page?q=1#f');
    await click(a);
    expect(current()).toEqual({
      url: '/docs/page?q=1#f',
      path: ['docs', 'page'],
      queryParams: { q: '1' },
      fragment: 'f',
    });
  });

  it('does not parse commands arrays (a segment may contain a literal #)', () => {
    const { a } = setup((h) => h.link.set(['/docs', 'a#b']));
    expect(a.getAttribute('href')).toBe('/docs/a%23b');
  });

  it('stays reactive: link, fragment and an emptied fragment all update the href', () => {
    const { fixture, host, a } = setup((h) => h.link.set('/a#x'));
    expect(a.getAttribute('href')).toBe('/a#x');

    host.link.set('/b?q=1');
    fixture.detectChanges();
    expect(a.getAttribute('href')).toBe('/b?q=1');

    host.fragment.set('late');
    fixture.detectChanges();
    expect(a.getAttribute('href')).toBe('/b?q=1#late');

    host.fragment.set(undefined);
    host.link.set('/c');
    fixture.detectChanges();
    expect(a.getAttribute('href')).toBe('/c');
  });

  it('resolves a bare #fragment or ?query against the route hosting the link', async () => {
    const harness = await RouterTestingHarness.create('/docs/page');
    const a = harness.routeNativeElement?.querySelector(
      '.self',
    ) as HTMLAnchorElement;

    const q = harness.routeNativeElement?.querySelector(
      '.self-q',
    ) as HTMLAnchorElement;

    expect(a.getAttribute('href')).toBe('/docs/page#install');
    expect(q.getAttribute('href')).toBe('/docs/page?tab=api');
    await click(a);
    expect(current().url).toBe('/docs/page#install');
  });

  it('preloads the parsed URL on hover', () => {
    const { a } = setup((h) => h.link.set('/docs/page?tab=api#install'));
    a.dispatchEvent(new MouseEvent('mouseenter'));
    expect(startPreload).toHaveBeenCalledExactlyOnceWith(
      '/docs/page?tab=api#install',
      'all',
    );
  });

  it('injectTriggerPreload parses inline query and fragment the same way', () => {
    TestBed.runInInjectionContext(() => {
      const trigger = injectTriggerPreload();
      trigger('/docs/page?x=1#f');
      trigger('/docs/page?x=1#inline', undefined, { y: '2' }, 'explicit');
    });
    expect(startPreload.mock.calls).toEqual([
      ['/docs/page?x=1#f', 'all'],
      ['/docs/page?x=1&y=2#explicit', 'all'],
    ]);
  });
});
