// P2P 模块入口

export {
  P2PNode,
  type P2PConfig,
  type P2PNetwork,
  type Connection,
  type ConnectionState,
  type PeerId,
  type PeerInfo,
  type P2PNodeOptions,
  type P2PNodeIdentity,
} from './P2PNetwork.js';
export {
  DeviceDiscovery,
  type DiscoveryOptions,
  type DeviceDiscoveryOptions,
  type BonjourService,
  type BonjourServiceInstance,
  type BonjourServiceFactory,
} from './DeviceDiscovery.js';
export { ConnectionManager, type ConnectionManagerOptions } from './connection/ConnectionManager.js';
export {
  AuthenticationHandshake,
  canonicalCertificateData,
  bytesToBase64,
  base64ToBytes,
  bytesToHex,
  hexToBytes,
  type AuthHandshakeOptions,
  type AuthRequest,
  type AuthResponse,
  type AuthSession,
  type DeviceCertificate,
  type LocalIdentity,
} from './handshake/AuthenticationHandshake.js';
export {
  NATTraversal,
  isPublicIPv4,
  type NATTraversalOptions,
  type NATType,
  type RelayServer,
  type NatProber,
  type HolePunchChannel,
} from './nat/NATTraversal.js';
export {
  SecureChannelImpl,
  type SecureChannelOptions,
  type SecureChannel,
} from './secure/SecureChannelImpl.js';
export {
  InMemoryHub,
  InMemoryConnection,
  MessageQueue,
  type ConnectionProvider,
  type MutableAuthenticationConnection,
  type ActivityTrackingConnection,
  type PingCapableConnection,
} from './transport/InMemoryTransport.js';
