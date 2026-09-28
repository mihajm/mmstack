export {
  agentSeat,
  describeOp,
  setAtPath,
  type AgentSeat,
  type AgentSeatOptions,
  type SeatChange,
  type SeatEvent,
  type SeatResync,
  type StableSnapshot,
} from './lib/agent-seat';
export {
  meshSync,
  type MeshPeer,
  type MeshStatus,
  type MeshSyncOptions,
  type MeshSyncRef,
  type SeatSync,
  type SyncHealth,
  type SyncHealthStatus,
} from './lib/mesh-sync';
export {
  directTransport,
  webSocketTransport,
  type MeshTransport,
  type MeshTransportFactory,
} from './lib/transport';
export {
  rtcPeerConnector,
  webRtcMesh,
  type DataChannelLike,
  type PeerConnector,
  type WebRtcMeshOptions,
  type WebRtcMeshRef,
} from './lib/webrtc-mesh';
export {
  defaultPeerChannels,
  peerLinks,
  type PeerChannelSpec,
  type PeerLinks,
  type PeerLinksOptions,
  type SignalingPort,
} from './lib/peer-links';
export {
  presenceChannel,
  rtcPresence,
  type PresenceFrame,
  type RtcPresenceOptions,
  type RtcPresenceRef,
} from './lib/rtc-presence';
