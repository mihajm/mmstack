import { KeyValuePipe } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  Injector,
  signal,
} from '@angular/core';
import {
  peerLinks,
  presenceChannel,
  rtcPeerConnector,
  rtcPresence,
  webSocketTransport,
  type PeerLinks,
  type RtcPresenceRef,
} from '@mmstack/mesh';

type Point = { x: number; y: number };

/**
 * E2E surface for `rtcPresence` over a REAL RTCPeerConnection. One peer per page (writer from
 * the query string); each page publishes its pointer position over a lossy data channel and
 * draws every other page's pointer as a dot. The relay carries only signaling and the roster
 * (see playground-e2e/src/rtc-presence.spec.ts).
 */
@Component({
  selector: 'mm-rtc-presence-example',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>RTC presence</h2>
    @if (ready()) {
      <p data-testid="ready">ready</p>
    }
    @if (links(); as l) {
      <p data-testid="status">{{ l.status() }}</p>
      <p data-testid="peers">{{ l.peers().length }}</p>
    }
    <div
      data-testid="pad"
      style="position: relative; width: 400px; height: 300px; border: 1px solid #888; overflow: hidden"
      (pointermove)="move($event)"
    >
      @if (presence(); as p) {
        @for (peer of p.peers() | keyvalue; track peer.key) {
          <div
            [attr.data-testid]="'dot-' + peer.key"
            style="position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: tomato; pointer-events: none"
            [style.left.px]="peer.value.x"
            [style.top.px]="peer.value.y"
          ></div>
        }
      }
    </div>
  `,
  imports: [KeyValuePipe],
})
export class RtcPresenceExample {
  private readonly injector = inject(Injector);
  protected readonly ready = signal(false);
  protected readonly links = signal<PeerLinks | null>(null);
  protected readonly presence = signal<RtcPresenceRef<Point> | null>(null);

  constructor() {
    // client-only: RTCPeerConnection, WebSocket and location are all browser APIs
    afterNextRender(() => {
      const writer =
        new URLSearchParams(location.search).get('writer') ?? 'anon';
      const links = peerLinks({
        room: 'rtc-presence-e2e',
        origin: writer,
        signaling: webSocketTransport(
          `ws://${location.hostname}:4301/?writer=${writer}&kind=human`,
        ),
        connector: rtcPeerConnector(),
        channels: [presenceChannel],
        injector: this.injector,
      });
      this.links.set(links);
      // the relay's membership, not the link, decides who is present
      this.presence.set(
        rtcPresence<Point>(links, {
          roster: links.onMembers,
          injector: this.injector,
        }),
      );
      this.ready.set(true);
    });
  }

  protected move(e: PointerEvent): void {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.presence()?.set({
      x: Math.round(e.clientX - rect.left),
      y: Math.round(e.clientY - rect.top),
    });
  }
}
