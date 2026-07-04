import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  Injector,
  signal,
} from '@angular/core';
import {
  rtcPeerConnector,
  webRtcMesh,
  webSocketTransport,
  type WebRtcMeshRef,
} from '@mmstack/mesh';
import { store, type WritableSignalStore } from '@mmstack/primitives';

type Doc = { text: string };

/**
 * E2E surface for `webRtcMesh` over a REAL RTCPeerConnection. One peer per page (writer from
 * the query string); two Playwright pages join the same room and converge over a WebRTC data
 * channel, with the Node relay carrying only the signaling. The unit suite runs this over a
 * fake channel hub; this exercises actual SDP/ICE/DTLS (see playground-e2e/src/webrtc.spec.ts).
 */
@Component({
  selector: 'mm-webrtc-example',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>WebRTC mesh</h2>
    @if (ready()) {
      <p data-testid="ready">ready</p>
    }
    @if (mesh(); as m) {
      <p data-testid="status">{{ m.status() }}</p>
      <p data-testid="peers">{{ m.peers().length }}</p>
    }
    <input data-testid="text-input" value="" #input />
    <button data-testid="save" (click)="store.text.set(input.value)">save</button>
    <p data-testid="text">{{ store.text() }}</p>
  `,
})
export class WebRtcExample {
  private readonly injector = inject(Injector);
  protected readonly ready = signal(false);
  protected readonly store: WritableSignalStore<Doc> = store<Doc>(
    { text: '' },
    { injector: this.injector },
  );
  protected readonly mesh = signal<WebRtcMeshRef | null>(null);

  constructor() {
    // client-only: RTCPeerConnection, WebSocket and location are all browser APIs
    afterNextRender(() => {
      const writer =
        new URLSearchParams(location.search).get('writer') ?? 'anon';
      // signaling only — the relay routes offer/answer/ICE; state flows peer-to-peer
      const signaling = webSocketTransport(
        `ws://${location.hostname}:4301/?writer=${writer}&kind=human`,
      );
      this.mesh.set(
        webRtcMesh(this.store, {
          room: 'webrtc-e2e',
          writer,
          signaling,
          connector: rtcPeerConnector(),
          injector: this.injector,
        }),
      );
      this.ready.set(true);
    });
  }
}
