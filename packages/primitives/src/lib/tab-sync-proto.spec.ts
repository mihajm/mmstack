import {
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  runInInjectionContext,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { store } from './store';
import { OP_PROTO_VERSION } from './store/op-sync';
import { MessageBus, tabSync } from './tab-sync';

// The join-lane protocol fence: hydration ingests register STATE, so a version mismatch on the
// join messages must refuse to PAIR — not hydrate-then-drop-traffic, which would leave a joiner
// showing a foreign version's state and never updating. A mismatched peer's hello gets no answer,
// a mismatched state reply is ignored, and the joiner's hello timeout takes over so each version
// cohort runs independently. A pre-versioning peer's messages lack the field entirely and must
// fail the same check.

type State = { routes: string[] };
const initial = (): State => ({ routes: [] });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RawMsg = Record<string, unknown> & { t: string };

describe('tabSync (store mode) — join-lane protocol fence', () => {
  const injectors: EnvironmentInjector[] = [];

  const child = () => {
    const env = createEnvironmentInjector(
      [MessageBus],
      TestBed.inject(EnvironmentInjector),
    );
    injectors.push(env);
    return env;
  };

  function tab() {
    const env = child();
    return runInInjectionContext(env, () =>
      tabSync(store<State>(initial()), {
        id: 'proto',
        injector: env.get(Injector),
        helloTimeoutMs: 40,
        jitterMs: 1,
      }),
    );
  }

  function rawPeer(onMessage: (msg: RawMsg) => void) {
    const env = child();
    const bus = env.get(MessageBus);
    const handle = bus.subscribe<RawMsg>('proto', (msg) => onMessage(msg));
    return handle;
  }

  afterEach(() => {
    for (const env of injectors.splice(0)) env.destroy();
  });

  const settle = async (ms: number) => {
    TestBed.tick();
    await wait(ms);
    TestBed.tick();
  };

  it('a live peer ignores a hello from another protocol version, and answers the current one', async () => {
    const a = tab();
    await settle(60);
    a.routes.set(['real']);
    await settle(10);

    const seen: RawMsg[] = [];
    const peer = rawPeer((msg) => seen.push(msg));

    peer.post({ t: 'hello', proto: OP_PROTO_VERSION - 1, from: 'old-tab', wm: {} });
    peer.post({ t: 'hello', from: 'ancient-tab', wm: {} });
    await settle(30);
    expect(seen.filter((m) => m.t === 'state' || m.t === 'uptodate')).toEqual([]);

    peer.post({ t: 'hello', proto: OP_PROTO_VERSION, from: 'current-tab', wm: {} });
    await settle(30);
    expect(seen.some((m) => m.t === 'state' || m.t === 'uptodate')).toBe(true);
  });

  it('a joiner ignores a state reply from another protocol version and goes live on its own base', async () => {
    const hijack = { root: { routes: ['HIJACKED'] }, registers: [], wm: {} };
    const peer = rawPeer((msg) => {
      if (msg.t === 'hello')
        peer.post({
          t: 'state',
          proto: OP_PROTO_VERSION - 1,
          to: msg['from'],
          state: hijack,
        });
    });

    const a = tab();
    await settle(80);

    expect(a().routes).toEqual([]);
    a.routes.set(['mine']);
    await settle(10);
    expect(a().routes).toEqual(['mine']);
  });
});
