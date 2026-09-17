// 控制台只读 API 的数据组装（D1）
//
// 只使用 @mebular/core 的公共 API：eventLog / storage / node / sync / 门面
// 只读入口（getEffectiveNamespaces / getRevokedDevices）与 MemoryService.status()。
// 这里不做任何写入，也不替其他设备做决定——只回答「本机给谁看什么」「与谁连接」。
//
// 契约（见 docs/console/interaction-draft.md）：
//   GET /admin/api/overview   { device, status, onlinePeers[], revokedCount }
//   GET /admin/api/devices    [{ deviceId, online, peerId?, addrs?, lastSyncAt?,
//                                pendingEventCount?, grantedByMe[], grantedToMe[], revoked }]
//   GET /admin/api/policy     [{ eventId, type, issuer, subject, namespaces?, grantId?, at, valid }]
//   GET /admin/api/namespaces [{ namespace, count, lastUpdatedAt, stateHash }]

import { POLICY_NAMESPACE, normalizeNamespace } from '@mebular/core';

export const POLICY_NS = POLICY_NAMESPACE;

/** hex → Uint8Array（证书 devicePublicKey 为 hex 编码） */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function nsOf(value) {
  try {
    return normalizeNamespace(value);
  } catch {
    return value === undefined || value === null || value === '' ? 'default' : String(value);
  }
}

function unique(list) {
  return [...new Set(list.filter((v) => typeof v === 'string' && v.length > 0))];
}

/**
 * 从 `__policy__` 事件流推导只读审计视图。
 * 注意：这里不逐条做用户主密钥信任链校验（GraphNamespacePolicy 已在校验），
 * 仅按「撤销优先」的保守口径标注 `valid`，用于展示而非权威判定。
 */
export async function collectPolicy(app) {
  const events = await app.eventLog.listEvents({ namespace: POLICY_NS });
  const grants = [];
  const revokes = [];
  const deviceRevokes = [];
  const authors = [];

  for (const event of events) {
    authors.push(event.author);
    if (event.type === 'namespace_grant') {
      const grant = event.data?.grant;
      if (grant && typeof grant.grantId === 'string' && typeof grant.subject === 'string') {
        grants.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          grantId: grant.grantId,
          subject: grant.subject,
          namespaces: unique(grant.namespaces ?? []).map(nsOf),
          note: grant.note,
        });
      }
    } else if (event.type === 'namespace_revoke') {
      const revoke = event.data?.revoke;
      if (revoke && typeof revoke.grantId === 'string') {
        revokes.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          grantId: revoke.grantId,
          subject: revoke.subject,
          note: revoke.note,
        });
      }
    } else if (event.type === 'device_revoke') {
      const deviceRevoke = event.data?.deviceRevoke;
      if (deviceRevoke && typeof deviceRevoke.subject === 'string') {
        deviceRevokes.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          subject: deviceRevoke.subject,
          note: deviceRevoke.note,
        });
      }
    }
  }

  let revokedDevices = [];
  try {
    revokedDevices = await app.getRevokedDevices();
  } catch {
    revokedDevices = [];
  }
  const revokedSet = new Set(revokedDevices.filter((d) => typeof d === 'string'));

  // grantId 撤销集合：只采纳「签发者未被吊销」的 revoke（R-b 的保守近似）
  const revokedGrantIds = new Set(
    revokes.filter((r) => !revokedSet.has(r.issuer)).map((r) => r.grantId),
  );

  const timeline = [
    ...grants.map((g) => ({
      eventId: g.eventId,
      type: 'namespace_grant',
      issuer: g.issuer,
      subject: g.subject,
      namespaces: g.namespaces,
      grantId: g.grantId,
      at: g.at,
      note: g.note,
      valid:
        !revokedGrantIds.has(g.grantId)
        && !revokedSet.has(g.subject)
        && !revokedSet.has(g.issuer),
    })),
    ...revokes.map((r) => ({
      eventId: r.eventId,
      type: 'namespace_revoke',
      issuer: r.issuer,
      subject: r.subject,
      grantId: r.grantId,
      at: r.at,
      note: r.note,
      valid: !revokedSet.has(r.issuer),
    })),
    ...deviceRevokes.map((d) => ({
      eventId: d.eventId,
      type: 'device_revoke',
      issuer: d.issuer,
      subject: d.subject,
      at: d.at,
      note: d.note,
      valid: !revokedSet.has(d.issuer) && revokedSet.has(d.subject),
    })),
  ].sort((a, b) => b.at - a.at);

  return { events, grants, revokes, deviceRevokes, revokedGrantIds, revokedSet, timeline, authors: unique(authors) };
}

/** 在线对端（已认证）与 deviceId 映射 */
export function collectOnlinePeers(app) {
  const node = app.node;
  if (!node || !node.isRunning()) return { peers: [], byDeviceId: new Map() };
  const connectionManager = node.getConnectionManager();
  const handshake = node.getHandshake();
  const peers = [];
  const byDeviceId = new Map();
  for (const connection of connectionManager.getConnections()) {
    const session = handshake.getSession(connection.peerId);
    const authenticated = session?.state === 'authenticated';
    const deviceId = session?.certificate?.deviceId ?? null;
    const entry = {
      peerId: connection.peerId.id,
      deviceId,
      remoteAddress: connection.remoteAddress,
      state: connection.state,
      authenticated: Boolean(authenticated),
    };
    peers.push(entry);
    if (deviceId && authenticated) byDeviceId.set(deviceId, entry);
  }
  return { peers, byDeviceId };
}

/** GET /admin/api/overview */
export async function buildOverview({ app, service }) {
  const status = await service.status();
  const { peers } = collectOnlinePeers(app);
  let revokedCount = 0;
  try {
    revokedCount = (await app.getRevokedDevices()).length;
  } catch {
    revokedCount = 0;
  }
  return {
    device: {
      deviceId: app.deviceId,
      name: app.deviceId,
      peerId: status.peerId,
      multiaddrs: status.listenAddrs,
      relays: status.relays,
    },
    status,
    onlinePeers: peers.filter((p) => p.authenticated),
    revokedCount,
  };
}

/** 已知设备全集（节点 = 设备） */
export async function collectKnownDevices(app, policy, online) {
  const self = app.deviceId;
  const known = new Set([self]);
  for (const author of policy.authors) known.add(author);
  for (const grant of policy.grants) {
    known.add(grant.issuer);
    known.add(grant.subject);
  }
  for (const revoke of policy.revokes) {
    if (revoke.subject) known.add(revoke.subject);
  }
  for (const deviceRevoke of policy.deviceRevokes) {
    known.add(deviceRevoke.subject);
  }
  for (const deviceId of online.byDeviceId.keys()) known.add(deviceId);
  // sync.policyIssuers / sync.peerNamespacePolicy 键
  for (const issuer of policy.bootstrapIssuers ?? []) known.add(issuer);
  for (const peer of policy.configuredPeers ?? []) known.add(peer);
  known.delete('');
  return [...known];
}

/** GET /admin/api/devices */
export async function buildDevices({ app, config }) {
  const self = app.deviceId;
  const online = collectOnlinePeers(app);
  const policy = await collectPolicy(app);
  policy.bootstrapIssuers = Array.isArray(config?.sync?.policyIssuers) ? config.sync.policyIssuers : [];
  policy.configuredPeers = Object.keys(config?.sync?.peerNamespacePolicy ?? {});

  const known = await collectKnownDevices(app, policy, online);

  let syncStatus = null;
  try {
    syncStatus = await app.sync.getSyncStatus();
  } catch {
    syncStatus = null;
  }
  const lastSyncPeer = syncStatus?.lastResult?.peerDeviceId ?? null;

  const devices = [];
  for (const deviceId of known) {
    const connection = online.byDeviceId.get(deviceId) ?? null;
    let grantedByMe = [];
    try {
      grantedByMe = await app.getEffectiveNamespaces(deviceId);
    } catch {
      grantedByMe = [];
    }
    const grantedToMe = unique(
      policy.grants
        .filter(
          (g) =>
            g.subject === self
            && g.issuer !== self
            && !policy.revokedGrantIds.has(g.grantId)
            && !policy.revokedSet.has(g.issuer),
        )
        .flatMap((g) => g.namespaces),
    );
    let pendingEventCount = null;
    try {
      pendingEventCount = (await app.sync.getPendingEvents(deviceId)).length;
    } catch {
      pendingEventCount = null;
    }
    devices.push({
      deviceId,
      online: Boolean(connection),
      ...(connection ? { peerId: connection.peerId, addrs: [connection.remoteAddress] } : {}),
      ...(lastSyncPeer === deviceId && syncStatus?.lastSyncAt ? { lastSyncAt: syncStatus.lastSyncAt } : {}),
      ...(pendingEventCount !== null ? { pendingEventCount } : {}),
      grantedByMe: unique(grantedByMe),
      grantedToMe,
      revoked: policy.revokedSet.has(deviceId),
    });
  }

  // 本机置顶，其余在线优先、再按 deviceId
  devices.sort((a, b) => {
    if (a.deviceId === self) return -1;
    if (b.deviceId === self) return 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.deviceId < b.deviceId ? -1 : 1;
  });
  return devices;
}

/** GET /admin/api/policy */
export async function buildPolicy({ app }) {
  const policy = await collectPolicy(app);
  return policy.timeline;
}

/** GET /admin/api/namespaces */
export async function buildNamespaces({ app, service }) {
  const [nodes, status] = await Promise.all([app.storage.listNodes(), service.status()]);
  const byNamespace = new Map();
  for (const node of nodes) {
    const namespace = nsOf(node.namespace);
    const entry = byNamespace.get(namespace) ?? { namespace, count: 0, lastUpdatedAt: 0 };
    entry.count += 1;
    const at = Math.max(node.updatedAt ?? 0, node.createdAt ?? 0);
    if (at > entry.lastUpdatedAt) entry.lastUpdatedAt = at;
    byNamespace.set(namespace, entry);
  }
  const hashes = status.stateHashByNamespace ?? {};
  return [...byNamespace.values()]
    .map((entry) => ({
      ...entry,
      lastUpdatedAt: entry.lastUpdatedAt || null,
      stateHash: hashes[entry.namespace] ?? null,
    }))
    .sort((a, b) => (a.namespace < b.namespace ? -1 : 1));
}

/** 只读 API 路由表：路径 → 构造器 */
export const READ_ROUTES = {
  '/admin/api/overview': buildOverview,
  '/admin/api/devices': buildDevices,
  '/admin/api/policy': buildPolicy,
  '/admin/api/namespaces': buildNamespaces,
};
