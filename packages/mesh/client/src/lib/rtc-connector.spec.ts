import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPeerChannels, rtcPeerConnector } from './peer-links';

/** A stand-in for `RTCPeerConnection`: settable states, spied methods, handlers fired by hand. */
class FakePc {
  static made: FakePc[] = [];
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription = { type: 'offer', sdp: 'local' };
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((e: unknown) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ondatachannel: ((e: unknown) => void) | null = null;
  restartIce = vi.fn();
  setRemoteDescription = vi.fn(
    async (description: unknown) => void description,
  );
  setLocalDescription = vi.fn(async () => undefined);
  addIceCandidate = vi.fn(async (candidate: unknown) => void candidate);
  close = vi.fn(() => {
    this.signalingState = 'closed';
  });
  createDataChannel = vi.fn((label: string) => ({
    label,
    readyState: 'connecting',
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onclose: null,
    onmessage: null,
  }));
  constructor(readonly config?: RTCConfiguration) {
    FakePc.made.push(this);
  }
  ice(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
  conn(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

function build(
  opt: {
    config?: RTCConfiguration;
    iceServers?: Parameters<
      ReturnType<typeof rtcPeerConnector>
    >[0]['iceServers'];
  } = {},
) {
  const link = rtcPeerConnector(opt.config)({
    remote: 'b',
    polite: false,
    sendSignal: () => undefined,
    channels: defaultPeerChannels,
    ...(opt.iceServers ? { iceServers: opt.iceServers } : {}),
  });
  const pc = FakePc.made[FakePc.made.length - 1];
  const gone = vi.fn();
  link.onClose?.(gone);
  return { link, pc, gone };
}

describe('rtcPeerConnector failure handling', () => {
  beforeEach(() => {
    FakePc.made = [];
    vi.stubGlobal('RTCPeerConnection', FakePc);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('restarts ICE on the first failure and reports the link gone on the second', () => {
    const { pc, gone } = build();
    pc.ice('failed');
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
    pc.ice('failed');
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledTimes(1);
    pc.ice('failed');
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('a connected period between failures earns a fresh restart', () => {
    const { pc, gone } = build();
    pc.ice('failed');
    pc.ice('connected');
    pc.ice('failed');
    expect(pc.restartIce).toHaveBeenCalledTimes(2);
    expect(gone).not.toHaveBeenCalled();
  });

  it('a disconnect that recovers within the grace does nothing', () => {
    const { pc, gone } = build();
    pc.ice('disconnected');
    vi.advanceTimersByTime(4999);
    pc.ice('connected');
    vi.advanceTimersByTime(60_000);
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
  });

  it('a disconnect that lasts the grace restarts ICE', () => {
    const { pc, gone } = build();
    pc.ice('disconnected');
    vi.advanceTimersByTime(4999);
    expect(pc.restartIce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
  });

  it('a closed connection reports the link gone', () => {
    const { pc, gone } = build();
    pc.conn('closed');
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('close() clears the grace timer', () => {
    const { link, pc, gone } = build();
    pc.ice('disconnected');
    link.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
  });

  it('a signal after close() touches nothing and does not reject', async () => {
    const { link, pc } = build();
    link.close();
    await expect(
      link.signal({
        description: { type: 'offer', sdp: 'remote' },
      }) as unknown as Promise<void>,
    ).resolves.toBeUndefined();
    await link.signal({ ice: { candidate: 'x' } });
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(pc.setLocalDescription).not.toHaveBeenCalled();
    expect(pc.addIceCandidate).not.toHaveBeenCalled();
  });

  it('a rejected remote description reports the link gone once, without an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { link, pc, gone } = build();
    pc.setRemoteDescription.mockRejectedValue(new Error('bad sdp'));
    await expect(
      link.signal({
        description: { type: 'answer', sdp: 'remote' },
      }) as unknown as Promise<void>,
    ).resolves.toBeUndefined();
    await link.signal({ description: { type: 'answer', sdp: 'again' } });
    expect(gone).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a rejected local offer reports the link gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { pc, gone } = build();
    pc.setLocalDescription.mockRejectedValue(new Error('no offer'));
    await (pc.onnegotiationneeded as unknown as () => Promise<void>)();
    expect(gone).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('relay-issued ICE servers replace the static list; without them the static config stands', () => {
    const config: RTCConfiguration = {
      iceServers: [{ urls: 'stun:static.example' }],
      iceTransportPolicy: 'relay',
    };
    const issued = [
      { urls: ['turn:relay.example'], username: 'u', credential: 'c' },
    ] as const;
    const { pc } = build({ config, iceServers: issued });
    expect(pc.config).toEqual({
      iceServers: [
        { urls: ['turn:relay.example'], username: 'u', credential: 'c' },
      ],
      iceTransportPolicy: 'relay',
    });
    const { pc: plain } = build({ config });
    expect(plain.config).toBe(config);
  });
});
