// P2P 模块入口

export { P2PNode, type P2PConfig, type P2PNetwork, type Connection, type ConnectionState, type PeerId, type PeerInfo, type P2PNodeOptions } from './P2PNetwork.js';
export { DeviceDiscovery, type DiscoveryOptions } from './DeviceDiscovery.js';
export { ConnectionManager, type ConnectionManagerOptions } from './connection/ConnectionManager.js';
export { AuthenticationHandshake, type AuthHandshakeOptions, type AuthRequest, type AuthResponse, type AuthSession } from './handshake/AuthenticationHandshake.js';
export { NATTraversal, type NATTraversalOptions, type NATType, type RelayServer } from './nat/NATTraversal.js';
export { SecureChannelImpl, type SecureChannelOptions, type SecureChannel } from './secure/SecureChannelImpl.js';
