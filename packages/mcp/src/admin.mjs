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

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { POLICY_NAMESPACE, normalizeNamespace } from '@mebular/core';
import { configPath } from './config.mjs';

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
  const policyIssuerDeclares = [];
  const memberships = [];
  const handoffs = [];
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
    } else if (event.type === 'policy_issuer_declare') {
      const policyIssuer = event.data?.policyIssuer;
      if (policyIssuer && typeof policyIssuer.subject === 'string') {
        policyIssuerDeclares.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          subject: policyIssuer.subject,
          note: policyIssuer.note,
        });
      }
    } else if (event.type === 'namespace_membership') {
      const membership = event.data?.membership;
      if (membership && typeof membership.member === 'string' && typeof membership.namespace === 'string') {
        memberships.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          member: membership.member,
          namespace: nsOf(membership.namespace),
          active: membership.active !== false,
          note: membership.note,
        });
      }
    } else if (event.type === 'namespace_handoff') {
      const handoff = event.data?.handoff;
      if (handoff && typeof handoff.namespace === 'string') {
        handoffs.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          handoffId: handoff.handoffId,
          namespace: nsOf(handoff.namespace),
          successor: handoff.successor,
          forced: handoff.forced === true,
          pendingCount: typeof handoff.pendingCount === 'number' ? handoff.pendingCount : 0,
          missingAuthors: Array.isArray(handoff.missingAuthors) ? handoff.missingAuthors : [],
          note: handoff.note,
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
    ...policyIssuerDeclares.map((d) => ({
      eventId: d.eventId,
      type: 'policy_issuer_declare',
      issuer: d.issuer,
      subject: d.subject,
      at: d.at,
      note: d.note,
      valid: !revokedSet.has(d.issuer) && !revokedSet.has(d.subject),
    })),
    ...memberships.map((m) => ({
      eventId: m.eventId,
      type: 'namespace_membership',
      issuer: m.issuer,
      subject: m.member,
      namespace: m.namespace,
      active: m.active,
      at: m.at,
      note: m.note,
      valid: !revokedSet.has(m.issuer) && !revokedSet.has(m.member),
    })),
    ...handoffs.map((h) => ({
      eventId: h.eventId,
      type: 'namespace_handoff',
      issuer: h.issuer,
      subject: h.successor,
      namespace: h.namespace,
      handoffId: h.handoffId,
      forced: h.forced,
      pendingCount: h.pendingCount,
      missingAuthors: h.missingAuthors,
      at: h.at,
      note: h.note,
      valid: true,
    })),
  ].sort((a, b) => b.at - a.at);

  return {
    events,
    grants,
    revokes,
    deviceRevokes,
    policyIssuerDeclares,
    memberships,
    handoffs,
    revokedGrantIds,
    revokedSet,
    timeline,
    authors: unique(authors),
  };
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
  for (const declare of policy.policyIssuerDeclares ?? []) {
    known.add(declare.subject);
  }
  for (const membership of policy.memberships ?? []) {
    known.add(membership.member);
  }
  for (const handoff of policy.handoffs ?? []) {
    if (handoff.successor) known.add(handoff.successor);
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

  // 成员制分区（一次计算，避免逐设备重复查询）：{ ns -> {enabled, members, effective} }
  const nsCandidates = new Set([
    ...policy.memberships.map((m) => m.namespace),
    ...policy.grants.flatMap((g) => g.namespaces ?? []),
  ]);
  const membershipByNs = new Map();
  for (const ns of nsCandidates) {
    try {
      const info = await app.getNamespaceMembership(ns);
      const effective = info.active ? await app.getNamespaceMembers(ns) : [];
      membershipByNs.set(ns, { enabled: info.active, members: new Set(info.members), effective: new Set(effective) });
    } catch {
      // 门面未就绪等：跳过该分区
    }
  }
  let policyIssuers = [];
  try {
    policyIssuers = await app.getPolicyIssuers();
  } catch {
    policyIssuers = [];
  }
  const issuerSet = new Set(policyIssuers);

  const devices = [];
  for (const deviceId of known) {
    const connection = online.byDeviceId.get(deviceId) ?? null;
    // 「我授权它」= 本机（含配置引导）签发的有效 grant 覆盖的域。
    // 不能直接用 getEffectiveNamespaces(peer)：那是「该对端被任何人授权」的并集，
    // 多签发者场景会把别人给它的授权误显示成我授权；对「本机」行更是无意义。
    const grantedByMe = unique([
      ...policy.grants
        .filter(
          (g) =>
            g.issuer === self
            && g.subject === deviceId
            && !policy.revokedGrantIds.has(g.grantId)
            && !policy.revokedSet.has(self),
        )
        .flatMap((g) => g.namespaces),
      ...((Array.isArray(config?.sync?.peerNamespacePolicy?.[deviceId])
        ? config.sync.peerNamespacePolicy[deviceId]
        : []
      ).map(nsOf)),
    ]);
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
    // 成员资格（仅启用成员制的分区；effective = 在册 ∩ 生效授权）
    const memberships = [];
    for (const [ns, info] of membershipByNs) {
      if (!info.enabled || !info.members.has(deviceId)) continue;
      memberships.push({ namespace: ns, active: true, effective: info.effective.has(deviceId) });
    }
    memberships.sort((a, b) => (a.namespace < b.namespace ? -1 : 1));
    devices.push({
      deviceId,
      online: Boolean(connection),
      ...(connection ? { peerId: connection.peerId, addrs: [connection.remoteAddress] } : {}),
      ...(lastSyncPeer === deviceId && syncStatus?.lastSyncAt ? { lastSyncAt: syncStatus.lastSyncAt } : {}),
      ...(pendingEventCount !== null ? { pendingEventCount } : {}),
      grantedByMe: unique(grantedByMe),
      grantedToMe,
      memberships,
      declaredIssuer: issuerSet.has(deviceId),
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
export async function buildNamespaces({ app, service, config }) {
  const [nodes, status, policy] = await Promise.all([
    app.storage.listNodes(),
    service.status(),
    collectPolicy(app),
  ]);
  const self = app.deviceId;
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
  const subscription = Array.isArray(config?.sync?.namespaces) ? config.sync.namespaces : [];
  const subscribedToAll = subscription.length === 0;
  // 本机对该分区的生效授权（用于重入按钮可用性与提示）
  let selfAuthorizedNs = new Set();
  try {
    selfAuthorizedNs = new Set(await app.getEffectiveNamespaces(self));
  } catch {
    selfAuthorizedNs = new Set();
  }

  // 我授权给谁：issuer=self 的有效 grant，按分区归组
  const grantedToByNs = new Map();
  for (const g of policy.grants) {
    if (g.issuer !== self || policy.revokedGrantIds.has(g.grantId) || policy.revokedSet.has(self)) continue;
    for (const ns of g.namespaces ?? []) {
      const list = grantedToByNs.get(ns) ?? [];
      list.push({ deviceId: g.subject, grantId: g.grantId, at: g.at });
      grantedToByNs.set(ns, list);
    }
  }

  const result = [];
  for (const entry of byNamespace.values()) {
    const ns = entry.namespace;
    let membershipEnabled = false;
    let members = [];
    let effectiveMembers = [];
    try {
      const info = await app.getNamespaceMembership(ns);
      membershipEnabled = info.active;
      members = info.members;
      if (membershipEnabled) effectiveMembers = await app.getNamespaceMembers(ns);
    } catch {
      // 门面未就绪：按未启用处理
    }
    let rejoinReset = false;
    try {
      rejoinReset = await app.hasRejoinReset(ns);
    } catch {
      rejoinReset = false;
    }
    result.push({
      ...entry,
      lastUpdatedAt: entry.lastUpdatedAt || null,
      stateHash: hashes[ns] ?? null,
      membershipEnabled,
      members,
      effectiveMembers,
      subscribed: subscribedToAll || subscription.includes(ns),
      grantedTo: grantedToByNs.get(ns) ?? [],
      rejoinReset,
      selfAuthorized: selfAuthorizedNs.has(ns),
      selfMember: membershipEnabled ? members.includes(self) : null,
    });
  }
  return result.sort((a, b) => (a.namespace < b.namespace ? -1 : 1));
}

/** GET /admin/api/settings（只读、脱敏；不含任何密钥/token） */
export async function buildSettings({ app, service, config, runtime }) {
  const status = await service.status();
  let policyIssuers = [];
  let revokedCount = 0;
  try {
    policyIssuers = await app.getPolicyIssuers();
    revokedCount = (await app.getRevokedDevices()).length;
  } catch {
    // 忽略：门面未就绪
  }
  const sync = config?.sync ?? {};
  const antiEntropy = sync.antiEntropy ?? { enabled: true, intervalMs: 600000, jitterRatio: 0.2 };
  return {
    identity: {
      deviceId: app.deviceId,
      name: runtime?.deviceName ?? config?.deviceName ?? null,
      peerId: status.peerId,
      multiaddrs: status.listenAddrs,
      relays: status.relays,
    },
    storage: {
      path: runtime?.storagePath ?? config?.storagePath ?? null,
      adapter: runtime?.storageAdapter ?? config?.storageAdapter ?? 'json',
    },
    encryption: {
      level: runtime?.encryptionLevel ?? config?.encryption?.level ?? 'none',
      atRest: app.atRestEncryption,
    },
    network: {
      enabled: Boolean(status.running),
      // listen = 实际监听（含 /p2p/、0.0.0.0 展开）；listenConfigured = config 原始值（供编辑/复制）
      listen: status.listenAddrs,
      listenConfigured: Array.isArray(config?.network?.libp2p?.listen) ? config.network.libp2p.listen : [],
      relays: status.relays,
      relayUnlimited: config?.network?.libp2p?.relayUnlimited === true,
    },
    sync: {
      autoSync: runtime?.autoSync ?? sync.autoSync ?? true,
      pushOnWrite: runtime?.pushOnWrite ?? sync.pushOnWrite ?? true, // serve/MCP 常驻默认开；环境变量可覆盖
      pushOnWriteThrottleMs: runtime?.pushOnWriteThrottleMs ?? sync.pushOnWriteThrottleMs ?? 50,
      antiEntropy,
      snapshotThreshold: sync.snapshotThreshold ?? null,
      subscriptions: Array.isArray(sync.namespaces) ? sync.namespaces : [],
      // L5 对端白名单（设备级；未设置 = 按授权/成员制判定）
      peerWhitelist: runtime?.peerWhitelist ?? (Array.isArray(sync.peerWhitelist) ? sync.peerWhitelist : []),
      legacyPeerAllowList: Object.keys(sync.peerNamespacePolicy ?? {}),
      configPolicyIssuers: Array.isArray(sync.policyIssuers) ? sync.policyIssuers : [],
    },
    policyIssuers,
    revokedCount,
    semantic: {
      enabled: app.semanticVectorIndex !== null,
      minScore: runtime?.semanticMinScore ?? config?.semantic?.minScore ?? 0.2,
    },
    mcp: {
      host: runtime?.mcp?.host ?? config?.mcp?.http?.host ?? '127.0.0.1',
      port: runtime?.mcp?.port ?? config?.mcp?.http?.port ?? 7331,
      auth: runtime?.mcp?.auth ?? config?.mcp?.http?.auth ?? 'none',
      tls: runtime?.mcp?.tls ?? config?.mcp?.http?.tls === true,
    },
  };
}

/** GET /admin/api/namespaces/:ns/handoff-plan?successor=…（只读预检） */
export async function buildHandoffPlan({ app }, namespace, successor) {
  if (typeof successor !== 'string' || successor.length === 0) {
    return { status: 400, body: { error: 'bad_request', message: '需要 ?successor=<deviceId>' } };
  }
  try {
    const plan = await app.planNamespaceHandoff({ namespace, successor });
    return { status: 200, body: plan };
  } catch (error) {
    return { status: 400, body: { error: 'bad_request', message: String(error?.message ?? error) } };
  }
}

/** GET /admin/api/config：磁盘上的原始配置（只读；供查看与复制） */
export async function buildConfigView({ config, home }) {
  const path = configPath(home);
  let raw = null;
  let parseError = null;
  try {
    raw = JSON.parse(await readFile(path, 'utf-8'));
  } catch (error) {
    parseError = String(error?.message ?? error);
  }
  return {
    path,
    exists: existsSync(path),
    parseError,
    config: raw ?? config ?? {},
  };
}

/** 只读 API 路由表：路径 → 构造器 */
export const READ_ROUTES = {
  '/admin/api/overview': buildOverview,
  '/admin/api/devices': buildDevices,
  '/admin/api/policy': buildPolicy,
  '/admin/api/namespaces': buildNamespaces,
  '/admin/api/settings': buildSettings,
  '/admin/api/config': buildConfigView,
};
