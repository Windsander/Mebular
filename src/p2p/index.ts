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
export { createDefaultBonjourFactory, type DefaultBonjourFactoryOptions } from './discovery/bonjourDefault.js';
export { buildRelayPolicy, type RelayPolicy, type RelayPolicyOptions } from './connection/RelayPolicy.js';
export {
  decideRelayRole,
  isPubliclyReachable,
  isLoopbackEndpoint,
  type RelayRoleDecision,
  type RelayRoleInput,
  type RelayServiceMode,
} from './relay/RelayRole.js';
export {
  EndpointBook,
  InMemoryEndpointStore,
  FileEndpointStore,
  classifyEndpoint,
  derivePeerIdHex,
  extractEndpointHost,
  KIND_PRIORITY,
  RELAY_SEEDS_KEY,
  type EndpointCandidate,
  type EndpointKind,
  type EndpointSource,
  type EndpointStore,
  type EndpointBookOptions,
  type PathState,
} from './connection/EndpointBook.js';
export {
  AuthenticationHandshake,
  canonicalCertificateData,
  bytesToBase64,
  base64ToBytes,
  bytesToHex,
  hexToBytes,
  verifyCertificateChain,
  signDelegatedCertificate,
  MAX_CERT_CHAIN_HOPS,
  type AuthHandshakeOptions,
  type AuthRequest,
  type AuthResponse,
  type AuthSession,
  type DeviceCertificate,
  type DelegationIssuer,
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
export {
  Libp2pProvider,
  Libp2pConnection,
  createLibp2pProvider,
  loadLibp2pModules,
  loadRelayModules,
  encodeFrame,
  FrameDecoder,
  peerIdFromDevicePublicKey,
  MEBULAR_PROTOCOL,
  MAX_FRAME_BYTES,
  type Libp2pProviderOptions,
  type ModuleImporter,
} from './transport/Libp2pProvider.js';
