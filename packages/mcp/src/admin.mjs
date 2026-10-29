// 控制台只读 API 的数据组装（D1）
//
// 只使用 @mebular/core 的公共 API：eventLog / storage / node / sync / 门面
// 只读入口（getSubscriptions / getBlockedDevices / 域公告）与 MemoryService.status()。
// 这里不做任何写入，也不替其他设备做决定——只回答「本机给谁看什么」「与谁连接」。
//
// 契约（见 docs/console/interaction-draft.md）：
//   GET /admin/api/overview   { device, status, onlinePeers[], revokedCount }
//   GET /admin/api/devices    [{ deviceId, online, peerId?, addrs?, lastSyncAt?,
//                                pendingEventCount?, grantedByMe[], grantedToMe[], revoked }]
//   GET /admin/api/policy     [{ eventId, type, issuer, subject, namespaces?, grantId?, at, valid }]
//   GET /admin/api/namespaces [{ namespace, count, lastUpdatedAt, stateHash }]

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { POLICY_NAMESPACE, normalizeNamespace } from '@mebular/core';
import { configPath } from './config.mjs';
import { cloudError, displayPath, readRegistry, resolveCloudRoot } from './profiles.mjs';
import { TOOL_NAMES } from './tools.mjs';
import { hotPaths, readApplyPending, readApplyResult } from './config-apply.mjs';
import {
  CONFIG_SCHEMA_BY_PATH,
  EDITABLE_PATHS,
  WRITABLE_INTERNAL_PATHS,
  PENDING_RESTART_PATHS,
  STATUS_ONLY_PATHS,
  consoleSchema,
  consoleStatusSchema,
} from './config-schema.mjs';

export const POLICY_NS = POLICY_NAMESPACE;

// Runtime 内部对象判定（与 src/runtime/internal.ts 同义）。
// 这里不 import 新导出的 helper：管理 API 也会被旧版 @mebular/core 的宿主进程加载。
const RUNTIME_INTERNAL_TYPES = new Set([
  'compact', 'context_checkpoint', 'self_record', 'raw_chunk', 'recall_trace',
]);

export function isRuntimeInternalObject(node) {
  if (!node) return false;
  if (RUNTIME_INTERNAL_TYPES.has(node.type)) return true;
  if (node.metadata?.runtime?.internal === true) return true;
  return typeof node.namespace === 'string'
    && node.namespace.startsWith('__')
    && node.namespace !== '__policy__';
}

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
 * 仅做保守的 `valid` 标注，用于展示而非权威判定。
 */
export async function collectPolicy(app) {
  const events = await app.eventLog.listEvents({ namespace: POLICY_NS });
  const subscriptions = [];
  const declarations = [];
  const deviceRevokes = [];
  const deviceRestores = [];
  const handoffs = [];
  const securityTiers = [];
  const securityApprovals = [];
  const securityRecoveries = [];
  const securityTotps = [];
  const authors = [];
  let previousTier = 'low';

  for (const event of events) {
    authors.push(event.author);
    if (event.type === 'namespace_subscription') {
      const subscription = event.data?.subscription;
      if (subscription && typeof subscription.member === 'string' && typeof subscription.namespace === 'string') {
        subscriptions.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          member: subscription.member,
          namespace: nsOf(subscription.namespace),
          active: subscription.active !== false,
          note: subscription.note,
          cosignApprover: subscription.cosign?.approver,
          breakGlassKeyId: subscription.breakGlass?.keyId,
          selfDeclared: subscription.member === event.author,
        });
      }
    } else if (event.type === 'namespace_declare') {
      const declaration = event.data?.declaration;
      if (declaration && typeof declaration.namespace === 'string') {
        declarations.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          namespace: nsOf(declaration.namespace),
          note: declaration.note,
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
          cosignApprover: deviceRevoke.cosign?.approver,
          breakGlassKeyId: deviceRevoke.breakGlass?.keyId,
        });
      }
    } else if (event.type === 'device_restore') {
      const deviceRestore = event.data?.deviceRestore;
      if (deviceRestore && typeof deviceRestore.subject === 'string') {
        deviceRestores.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          subject: deviceRestore.subject,
          note: deviceRestore.note,
          cosignApprover: deviceRestore.cosign?.approver,
          breakGlassKeyId: deviceRestore.breakGlass?.keyId,
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
    } else if (event.type === 'security_tier') {
      const tier = event.data?.securityTier;
      if (tier && ['low', 'medium', 'high'].includes(tier.level)) {
        securityTiers.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          level: tier.level,
          fromLevel: previousTier,
          note: tier.note,
          cosignApprover: tier.cosign?.approver,
          breakGlassKeyId: tier.breakGlass?.keyId,
          nonce: tier.nonce,
        });
        previousTier = tier.level;
      }
    } else if (event.type === 'security_approval') {
      const approval = event.data?.securityApproval;
      if (approval && typeof approval.approvalId === 'string') {
        securityApprovals.push({
          eventId: event.id,
          issuer: event.author,
          subject: approval.target ?? approval.initiator,
          at: event.timestamp,
          approvalId: approval.approvalId,
          op: approval.op,
          decision: approval.decision,
          initiator: approval.initiator,
          target: approval.target,
          namespace: approval.namespace !== undefined ? nsOf(approval.namespace) : undefined,
          level: approval.level,
          pairingCode: approval.pairingCode,
          expiresAt: approval.expiresAt,
          cosignApprover: approval.cosign?.approver,
          note: approval.note,
        });
      }
    } else if (event.type === 'security_recovery') {
      const recovery = event.data?.securityRecovery;
      if (recovery && typeof recovery.keyId === 'string') {
        securityRecoveries.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          keyId: recovery.keyId,
          mode: recovery.mode === 'rotate' ? 'rotate' : 'set',
          note: recovery.note,
          cosignApprover: recovery.cosign?.approver,
          breakGlassKeyId: recovery.breakGlass?.keyId,
        });
      }
    } else if (event.type === 'security_totp') {
      const totp = event.data?.securityTotp;
      if (totp && typeof totp.fingerprint === 'string') {
        securityTotps.push({
          eventId: event.id,
          issuer: event.author,
          at: event.timestamp,
          device: totp.device,
          subject: totp.device,
          fingerprint: totp.fingerprint,
          epoch: totp.epoch,
          note: totp.note,
        });
      }
    }
  }

  let blockedDevices = [];
  try {
    blockedDevices = await app.getBlockedDevices();
  } catch {
    blockedDevices = [];
  }
  const blockedSet = new Set(blockedDevices.filter((d) => typeof d === 'string'));

  const timeline = [
    ...subscriptions.map((s) => ({
      eventId: s.eventId,
      type: 'namespace_subscription',
      issuer: s.issuer,
      subject: s.member,
      namespace: s.namespace,
      namespaces: [s.namespace],
      active: s.active,
      at: s.at,
      note: s.note,
      cosignApprover: s.cosignApprover,
      breakGlassKeyId: s.breakGlassKeyId,
      valid: s.selfDeclared && !blockedSet.has(s.issuer) && !blockedSet.has(s.member),
      ...(s.selfDeclared ? {} : { rejectReason: 'foreign-subscription' }),
    })),
    ...declarations.map((d) => ({
      eventId: d.eventId,
      type: 'namespace_declare',
      issuer: d.issuer,
      subject: d.issuer,
      namespace: d.namespace,
      namespaces: [d.namespace],
      at: d.at,
      note: d.note,
      valid: !blockedSet.has(d.issuer),
    })),
    ...deviceRevokes.map((d) => ({
      eventId: d.eventId,
      type: 'device_revoke',
      issuer: d.issuer,
      subject: d.subject,
      at: d.at,
      note: d.note,
      cosignApprover: d.cosignApprover,
      breakGlassKeyId: d.breakGlassKeyId,
      valid: !blockedSet.has(d.issuer) && blockedSet.has(d.subject),
    })),
    ...deviceRestores.map((d) => ({
      eventId: d.eventId,
      type: 'device_restore',
      issuer: d.issuer,
      subject: d.subject,
      at: d.at,
      note: d.note,
      cosignApprover: d.cosignApprover,
      breakGlassKeyId: d.breakGlassKeyId,
      valid: !blockedSet.has(d.issuer),
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
    ...securityTiers.map((t) => ({
      eventId: t.eventId,
      type: 'security_tier',
      issuer: t.issuer,
      subject: t.issuer,
      level: t.level,
      fromLevel: t.fromLevel,
      at: t.at,
      note: t.note,
      cosignApprover: t.cosignApprover,
      breakGlassKeyId: t.breakGlassKeyId,
      valid: !blockedSet.has(t.issuer),
    })),
    ...securityApprovals.map((a) => ({
      eventId: a.eventId,
      type: 'security_approval',
      issuer: a.issuer,
      subject: a.subject,
      approvalId: a.approvalId,
      op: a.op,
      decision: a.decision,
      initiator: a.initiator,
      target: a.target,
      level: a.level,
      pairingCode: a.pairingCode,
      expiresAt: a.expiresAt,
      cosignApprover: a.cosignApprover,
      ...(a.namespace !== undefined ? { namespace: a.namespace, namespaces: [a.namespace] } : {}),
      at: a.at,
      note: a.note,
      valid: true,
    })),
    ...securityRecoveries.map((r) => ({
      eventId: r.eventId,
      type: 'security_recovery',
      issuer: r.issuer,
      subject: r.issuer,
      keyId: r.keyId,
      mode: r.mode,
      at: r.at,
      note: r.note,
      cosignApprover: r.cosignApprover,
      breakGlassKeyId: r.breakGlassKeyId,
      valid: !blockedSet.has(r.issuer),
    })),
    ...securityTotps.map((t) => ({
      eventId: t.eventId,
      type: 'security_totp',
      issuer: t.issuer,
      subject: t.device,
      device: t.device,
      fingerprint: t.fingerprint,
      epoch: t.epoch,
      at: t.at,
      note: t.note,
      valid: true,
    })),
  ].sort((a, b) => b.at - a.at);

  // 拒绝不静默——用 core 的权威诊断给时间线行加 rejectReason（valid=false）。
  let securityState = null;
  if (typeof app.getSecurityTier === 'function') {
    try {
      const raw = await app.getSecurityTier();
      if (raw !== null && typeof raw === 'object') securityState = raw;
    } catch {
      securityState = null;
    }
  }
  const rejectionByEvent = new Map(
    (Array.isArray(securityState?.rejections) ? securityState.rejections : [])
      .filter((row) => row && typeof row.eventId === 'string' && typeof row.reason === 'string')
      .map((row) => [row.eventId, row.reason]),
  );
  if (rejectionByEvent.size > 0) {
    for (const item of timeline) {
      const reason = rejectionByEvent.get(item.eventId);
      if (reason !== undefined) {
        item.valid = false;
        item.rejectReason = reason;
      }
    }
  }

  return {
    events,
    subscriptions,
    declarations,
    deviceRevokes,
    deviceRestores,
    handoffs,
    securityTiers,
    securityApprovals,
    securityRecoveries,
    securityTotps,
    securityState,
    blockedSet,
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
export async function buildOverview({ app, service, cloud, runtime }) {
  const status = await service.status();
  const { peers } = collectOnlinePeers(app);
  let blockedCount = 0;
  try {
    blockedCount = (await app.getBlockedDevices()).length;
  } catch {
    blockedCount = 0;
  }
  // P3：收敛健康度汇总（未启用 = 无字段；「关于本机」只读展示）
  let convergence = null;
  try {
    const conv = app.getConvergenceStatus?.();
    if (conv) convergence = { at: conv.at, summary: conv.summary };
  } catch {
    convergence = null;
  }
  // 设备展示名：网络派生优先；无共享事件 → 本机 config/runtime 回退。
  let deviceNames = {};
  try {
    deviceNames = (await app.getDeviceNames?.()) ?? {};
  } catch {
    deviceNames = {};
  }
  const selfDeviceName = deviceNames[app.deviceId]?.name
    ?? runtime?.deviceName
    ?? null;
  // 忆云身份：旧守护无此字段 → 前端自行隐藏；注册表不可读时同样省略（不阻塞总览）。
  let cloudView = null;
  if (cloud?.available) {
    try {
      const state = await readRegistry(cloud.root);
      const current = state.registry.profiles.find((profile) => profile.id === state.registry.current) ?? null;
      if (current) {
        // 网络级名字优先（任意设备改名后同步到这里）；registry 只做 fallback。
        let derived = null;
        try {
          derived = (await app.getCloudName?.()) ?? null;
        } catch {
          derived = null;
        }
        cloudView = {
          id: current.id,
          name: derived?.name ?? current.name,
          masterFingerprint: current.masterFingerprint ?? null,
          current: true,
          nameSource: derived ? 'network' : 'registry',
          nameUpdatedAt: derived
            ? (derived.at ? new Date(derived.at).toISOString() : (current.nameUpdatedAt ?? null))
            : (current.nameUpdatedAt ?? current.createdAt ?? null),
        };
      }
    } catch {
      cloudView = null;
    }
  }
  return {
    device: {
      deviceId: app.deviceId,
      name: selfDeviceName ?? app.deviceId,
      peerId: status.peerId,
      multiaddrs: status.listenAddrs,
      relays: status.relays,
    },
    status,
    onlinePeers: peers.filter((p) => p.authenticated),
    blockedCount,
    ...(convergence ? { convergence } : {}),
    ...(cloudView ? { cloud: cloudView } : {}),
  };
}

const sameDisplayName = (a, b) => String(a ?? '').trim().toLocaleLowerCase()
  === String(b ?? '').trim().toLocaleLowerCase();

const parsedTime = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

/**
 * 本机多忆云重名标记（app 层计算；跨网络允许同名，但本机列表内重名要提示）：
 * - 同名项都标 `duplicateName`；
 * - 其中名字更新时间最近的一项标 `suggestedRename`；
 * - 当前忆云被标记时，UI 在顶栏徽章加警告点。
 */
function markNameConflicts(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.name ?? '').trim().toLocaleLowerCase();
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const duplicateNames = [];
  const suggestedIds = [];
  for (const [key, list] of groups) {
    if (list.length < 2 || key.length === 0) continue;
    duplicateNames.push(list[0].name);
    let suggested = list[0];
    for (const row of list.slice(1)) {
      if (row._updatedAt > suggested._updatedAt) {
        suggested = row;
      } else if (row._updatedAt === suggested._updatedAt && row.id < suggested.id) {
        suggested = row;
      }
    }
    suggestedIds.push(suggested.id);
  }
  for (const row of rows) {
    row.duplicateName = duplicateNames.some((name) => sameDisplayName(name, row.name));
    row.suggestedRename = row.duplicateName && suggestedIds.includes(row.id);
    delete row._updatedAt;
  }
  return { duplicateNames, suggestedIds };
}

/** GET /admin/api/clouds：注册表 v1 的只读视图（不含秘密）。 */
export async function buildClouds({ app, cloud }) {
  if (!cloud?.available) {
    throw cloudError(
      'CLOUD_UNAVAILABLE',
      '当前为自定义 home / 受限 env：忆云档案功能不可用（默认 ~/.mebular 不受影响）',
      { reason: cloud?.reason ?? 'unavailable' },
    );
  }
  const state = await readRegistry(cloud.root);
  const current = state.registry.current;
  // 当前忆云的名字优先读网络派生（remote rename 后本机 registry 可能尚未刷新）。
  let derived = null;
  try {
    derived = (await app?.getCloudName?.()) ?? null;
  } catch {
    derived = null;
  }
  const rows = state.registry.profiles.map((profile) => {
    const isCurrent = profile.id === current;
    const name = isCurrent && derived ? derived.name : profile.name;
    const updatedAt = isCurrent && derived
      ? parsedTime(derived.at || derived.issuedAt)
      : parsedTime(profile.nameUpdatedAt) || parsedTime(profile.createdAt);
    return {
      id: profile.id,
      name,
      home: profile.home,
      kind: profile.kind,
      createdAt: profile.createdAt ?? null,
      lastUsedAt: profile.lastUsedAt ?? null,
      nameUpdatedAt: isCurrent && derived
        ? (derived.at ? new Date(derived.at).toISOString() : profile.nameUpdatedAt ?? null)
        : (profile.nameUpdatedAt ?? null),
      masterFingerprint: profile.masterFingerprint ?? null,
      deviceId: profile.deviceId ?? null,
      current: isCurrent,
      nameSource: isCurrent && derived ? 'network' : 'registry',
      _updatedAt: updatedAt,
    };
  });
  const conflicts = markNameConflicts(rows);
  const currentRow = rows.find((row) => row.current) ?? null;
  return {
    ok: true,
    root: displayPath(cloud.root),
    current,
    profiles: rows,
    nameConflicts: {
      names: conflicts.duplicateNames,
      suggestedIds: conflicts.suggestedIds,
      currentDuplicate: Boolean(currentRow?.duplicateName),
    },
    ...(state.warning ? { warning: state.warning } : {}),
  };
}

/** 已知设备全集（节点 = 设备） */
export async function collectKnownDevices(app, policy, online) {
  const self = app.deviceId;
  const known = new Set([self]);
  for (const author of policy.authors) known.add(author);
  for (const subscription of policy.subscriptions) {
    known.add(subscription.issuer);
    known.add(subscription.member);
  }
  for (const declaration of policy.declarations) known.add(declaration.issuer);
  for (const deviceRevoke of policy.deviceRevokes) known.add(deviceRevoke.subject);
  for (const deviceRestore of policy.deviceRestores) known.add(deviceRestore.subject);
  for (const handoff of policy.handoffs ?? []) {
    if (handoff.successor) known.add(handoff.successor);
  }
  for (const deviceId of online.byDeviceId.keys()) known.add(deviceId);
  known.delete('');
  return [...known];
}

/** GET /admin/api/devices */
export async function buildDevices({ app, runtime }) {
  const self = app.deviceId;
  const online = collectOnlinePeers(app);
  const policy = await collectPolicy(app);
  const known = await collectKnownDevices(app, policy, online);
  // 设备名来自网络派生（本人可改）；无事件时本机用 runtime（身份文件派生）回退，其他设备只显示 deviceId。
  let deviceNames = {};
  try {
    deviceNames = (await app.getDeviceNames?.()) ?? {};
  } catch {
    deviceNames = {};
  }
  const selfNameFallback = runtime?.deviceName ?? null;

  let syncStatus = null;
  try {
    syncStatus = await app.sync.getSyncStatus();
  } catch {
    syncStatus = null;
  }
  const lastSyncPeer = syncStatus?.lastResult?.peerDeviceId ?? null;

  // P3：收敛健康度（每对端只读状态；未启用 = 无）
  let convergenceByPeer = new Map();
  try {
    const convergence = app.getConvergenceStatus?.();
    for (const peer of convergence?.peers ?? []) convergenceByPeer.set(peer.peerDeviceId, peer);
  } catch {
    convergenceByPeer = new Map();
  }

  let selfSubscriptions = [];
  try {
    selfSubscriptions = await app.getSubscriptions(self);
  } catch {
    selfSubscriptions = [];
  }
  const runtimeSubscriptions = app.sync?.getSubscriptionNamespaces?.() ?? [];
  for (const ns of runtimeSubscriptions) {
    if (!selfSubscriptions.includes(ns)) selfSubscriptions.push(ns);
  }
  if (runtimeSubscriptions.length === 0) {
    try {
      for (const ns of await app.getNamespaceDirectory()) {
        if (!selfSubscriptions.includes(ns)) selfSubscriptions.push(ns);
      }
    } catch {
      // 门面未就绪：按空订阅集处理
    }
  }
  const selfSubscribedSet = new Set(selfSubscriptions);

  const devices = [];
  for (const deviceId of known) {
    const connection = online.byDeviceId.get(deviceId) ?? null;
    let subscriptions = [];
    try {
      subscriptions = await app.getSubscriptions(deviceId);
    } catch {
      subscriptions = [];
    }
    const sharesWithMe = subscriptions.filter((ns) => selfSubscribedSet.has(ns)).sort();
    let pendingEventCount = null;
    try {
      pendingEventCount = (await app.sync.getPendingEvents(deviceId)).length;
    } catch {
      pendingEventCount = null;
    }
    const name = deviceNames[deviceId]?.name
      ?? (deviceId === self ? selfNameFallback : null);
    devices.push({
      deviceId,
      ...(name ? { name } : {}),
      // 本机是本地节点：不依赖入站连接，始终 online（否则前端可达性会把 self 算成离线）。
      // 对端仍按真实已认证连接判定。
      online: deviceId === self ? true : Boolean(connection),
      ...(connection ? { peerId: connection.peerId, addrs: [connection.remoteAddress] } : {}),
      ...(lastSyncPeer === deviceId && syncStatus?.lastSyncAt ? { lastSyncAt: syncStatus.lastSyncAt } : {}),
      ...(pendingEventCount !== null ? { pendingEventCount } : {}),
      ...(convergenceByPeer.has(deviceId) ? { convergence: convergenceByPeer.get(deviceId) } : {}),
      subscriptions: [...subscriptions].sort(),
      sharesWithMe,
      blocked: policy.blockedSet.has(deviceId),
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

/** GET /admin/api/namespaces：目录 = 域公告 ∪ 本地节点（未订阅也显示）。 */
export async function buildNamespaces({ app, service, config }) {
  const [nodes, status, policy] = await Promise.all([
    app.storage.listNodes(),
    service.status(),
    collectPolicy(app),
  ]);
  const byNamespace = new Map();
  for (const declaration of policy.declarations) {
    byNamespace.set(declaration.namespace, {
      namespace: declaration.namespace,
      count: 0,
      lastUpdatedAt: 0,
      declared: true,
      declaredAt: declaration.at,
      declaredBy: declaration.issuer,
    });
  }
  for (const node of nodes) {
    const namespace = nsOf(node.namespace);
    const entry = byNamespace.get(namespace) ?? {
      namespace,
      count: 0,
      lastUpdatedAt: 0,
      declared: false,
      declaredAt: null,
      declaredBy: null,
    };
    entry.count += 1;
    const at = Math.max(node.updatedAt ?? 0, node.createdAt ?? 0);
    if (at > entry.lastUpdatedAt) entry.lastUpdatedAt = at;
    byNamespace.set(namespace, entry);
  }
  const hashes = status.stateHashByNamespace ?? {};
  const subscription = app.sync?.getSubscriptionNamespaces?.()
    ?? (Array.isArray(config?.sync?.namespaces) ? config.sync.namespaces : []);
  const subscribedToAll = subscription.length === 0;

  const result = [];
  for (const entry of byNamespace.values()) {
    const ns = entry.namespace;
    let subscriptionDeclared = false;
    let subscribers = [];
    try {
      const info = await app.getNamespaceSubscriptions(ns);
      subscriptionDeclared = info.active;
      subscribers = info.subscribers;
    } catch {
      // 门面未就绪：按未声明处理
    }
    let rejoinReset = false;
    try {
      rejoinReset = await app.hasRejoinReset(ns);
    } catch {
      rejoinReset = false;
    }
    const subscribed = subscribedToAll || subscription.includes(ns);
    result.push({
      ...entry,
      lastUpdatedAt: entry.lastUpdatedAt || null,
      stateHash: hashes[ns] ?? null,
      subscriptionDeclared,
      subscribers,
      subscribed,
      selfSubscribed: subscribed,
      rejoinReset,
    });
  }
  return result.sort((a, b) => (a.namespace < b.namespace ? -1 : 1));
}

// ---------- 待重启（pendingRestart）：磁盘 config.json 与「启动快照」不一致 ----------
//
// 守护只在启动时读取一次 config.json（createMebular），运行期没有热加载。设置页保存后
// 磁盘已变，但当前实例仍按上次启动的快照工作——这里把它显式暴露给控制台。
// **路径/归一函数均来自 config-schema.mjs 单一真源**（`read` 把「未设置」归一为生效默认值，
// 避免默认值被误报为不一致）；`envVar` 命中的路径磁盘值不会被重启采纳，故不计入待重启。
const HOT_PATHS = new Set(hotPaths());
const RESTART_CONFIG_PATHS = PENDING_RESTART_PATHS.filter((entry) => !HOT_PATHS.has(entry.path)).map((entry) => ({
  path: entry.path,
  label: entry.ui?.label ?? entry.path,
  ...(entry.envVar ? { envVar: entry.envVar } : {}),
  read: entry.read,
}));

/**
 * 比较「当前磁盘 config.json」与「本次启动快照」的 curated 重启类配置。
 * 返回 `{ pending, envOverridden }`：pending 元素形如 `{ path, file, running }`；
 * 受环境变量优先控制的路径跳过（重启也不会采纳磁盘值），并在 envOverridden 中列出。
 */
function computePendingRestart(diskConfig, startupConfig) {
  const pending = [];
  const envOverridden = [];
  for (const spec of RESTART_CONFIG_PATHS) {
    if (spec.envVar && process.env[spec.envVar] !== undefined) {
      envOverridden.push(spec.path);
      continue;
    }
    const file = spec.read(diskConfig) ?? null;
    const running = spec.read(startupConfig) ?? null;
    if (JSON.stringify(file) !== JSON.stringify(running)) {
      // D：三元组第三列「未生效原因」——服务端计算，前端只渲染
      pending.push({
        path: spec.path,
        label: spec.label,
        file,
        running,
        reason: '待重启：已保存的值将在重启后生效（当前实例按上次启动的配置工作）',
      });
    }
  }
  return { pending, envOverridden };
}

/** join 启动失败根因（server.mjs 在 joinService 起不来时落盘；成功启动即清除）。 */
async function readJoinError(home) {
  if (!home) return null;
  try {
    const record = JSON.parse(await readFile(join(home, 'join.error.json'), 'utf-8'));
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/**
 * D：三元组（已配置 X / 实际 Y / **未生效原因**）——覆盖 editable 20 项 + status-only 只读行。
 * 原因优先级：环境变量优先 > 待重启 > 条目自定义原因（缺依赖 / 端口被占 / 回环不可达 / 缺证书…）> 已生效。
 */
function buildEffectiveRows({ settings, config, diskConfig, pending, envOverridden }) {
  const pendingPaths = new Set(pending.map((item) => item.path));
  const envSet = new Set(envOverridden);
  const rows = [];
  for (const path of [...EDITABLE_PATHS, ...STATUS_ONLY_PATHS, ...WRITABLE_INTERNAL_PATHS]) { // writable-internal 也进诊断三元组（API 可写）
    const entry = CONFIG_SCHEMA_BY_PATH.get(path);
    let reason = '已生效';
    if (HOT_PATHS.has(path)) reason = '已声明为热生效（本部署 MEBULAR_CONFIG_HOT_PATHS）';
    else if (envSet.has(path)) reason = '环境变量优先：磁盘值不会被重启采纳（以 env 为准）';
    else if (pendingPaths.has(path)) reason = '待重启：已保存的值将在重启后生效';
    else if (typeof entry.reason === 'function') reason = entry.reason({ settings, config, diskConfig }) ?? '已生效';
    rows.push({
      path,
      label: entry.ui?.label ?? path,
      exposure: entry.exposure,
      requiresRestart: entry.requiresRestart === true,
      configured: entry.read ? (entry.read(diskConfig) ?? null) : null,
      actual: typeof entry.effective === 'function' ? (entry.effective(settings) ?? null) : null,
      reason,
      pending: pendingPaths.has(path),
    });
  }
  return rows;
}

/** 读取服务心跳（serve 常驻写 <home>/service.heartbeat）；供 UI 选择重启命令文案。 */
async function readServiceHeartbeat(home) {
  if (!home) return false;
  try {
    const record = JSON.parse(await readFile(join(home, 'service.heartbeat'), 'utf-8'));
    return typeof record?.ts === 'number'
      && Date.now() - record.ts <= 30_000
      && record?.role === 'mebular-serve';
  } catch {
    return false;
  }
}

/** GET /admin/api/settings（只读、脱敏；不含任何密钥/token） */
export async function buildSettings({ app, service, config, runtime, home }) {
  const status = await service.status();
  const joinError = await readJoinError(home);
  // G：最近一次「保存即生效」的应用结果（pending = 正在重启中）
  const [applyResult, applyPending] = await Promise.all([readApplyResult(home), readApplyPending(home)]);
  let declaredNamespaces = [];
  let blockedCount = 0;
  try {
    declaredNamespaces = await app.getNamespaceDeclarations();
    blockedCount = (await app.getBlockedDevices()).length;
  } catch {
    // 忽略：门面未就绪
  }
  // 设备名：网络派生优先；无共享事件时回退 runtime（身份文件派生）。
  let selfDeviceName = null;
  try {
    const names = (await app.getDeviceNames?.()) ?? {};
    selfDeviceName = names[app.deviceId]?.name ?? null;
  } catch {
    selfDeviceName = null;
  }
  const sync = config?.sync ?? {};
  const antiEntropy = sync.antiEntropy ?? { enabled: true, intervalMs: 600000, jitterRatio: 0.2 };
  const payload = {
    identity: {
      deviceId: app.deviceId,
      name: selfDeviceName ?? runtime?.deviceName ?? null,
      nameSource: selfDeviceName ? 'network' : (runtime?.deviceName ? 'local' : null),
      // W2：root（持主私钥）/ delegated（仅委派链）
      mode: runtime?.identityMode ?? config?.identity?.mode ?? null,
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
      subscriptions: app.sync?.getSubscriptionNamespaces?.() ?? (Array.isArray(sync.namespaces) ? sync.namespaces : []),
      // 对端白名单（设备级连接准入；不是域授权）
      peerWhitelist: runtime?.peerWhitelist ?? (Array.isArray(sync.peerWhitelist) ? sync.peerWhitelist : []),
    },
    declaredNamespaces,
    blockedCount,
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
    join: {
      // 新设备上车（令牌 → 委派证书）；由 config.joinService 控制
      enabled: runtime?.join?.enabled ?? config?.joinService?.enabled === true,
      bind: runtime?.join?.bind ?? config?.joinService?.bind ?? '0.0.0.0',
      port: runtime?.join?.port ?? config?.joinService?.port ?? 4002,
      // F-C6：令牌里写死的端点（实际值）+ 是否为回环（回环则新设备不可达）
      endpoint: runtime?.join?.endpoint ?? null,
      endpointLoopback: runtime?.join?.endpointLoopback ?? null,
      // E/D：上次 join 启动失败的根因（端口被占等）；成功启动后文件已清除
      ...(joinError ? { lastError: joinError } : {}),
    },
    ...(await buildFleetView(home)),
    // C2：对端连接路径（只读；来自 core 地址簿的 path 状态）+ 地址簿元信息
    peers: buildPeerPaths(app),
    // C6：内建 relay 角色（只读；mode/serving/reason/allowedClients + 当前经哪个桥）
    relay: buildRelayView(app),
    // C5：地址自动广播（只读；档位/已发布/已采用/忽略原因）
    net: buildNetView(app),
    // C4：NAT 穿透（只读；AutoNAT/DCUtR 是否启用、直连升级与 relay 连接计数）
    nat: buildNatView(app),
    // 实际可调用面（MCP 工具 = `mebular <name>` CLI，逐字同名同 handler）
    tools: TOOL_NAMES,
  };

  // 待重启：读取**当前磁盘** config.json，与「本次启动快照 config」对比 curated 重启类路径。
  // 注意：mcp.* 以启动快照为基准（`--port 0` 的实际端口由系统分配，不代表磁盘值未生效）。
  let diskConfig = config ?? {};
  if (home) {
    try {
      diskConfig = JSON.parse(await readFile(configPath(home), 'utf-8'));
    } catch {
      diskConfig = config ?? {};
    }
  }
  const { pending, envOverridden } = computePendingRestart(diskConfig, config);
  const effectiveRows = buildEffectiveRows({ settings: payload, config, diskConfig, pending, envOverridden });
  return {
    ...payload,
    pendingRestart: pending,
    ...(envOverridden.length > 0 ? { pendingRestartEnvOverrides: envOverridden } : {}),
    // A/D：三元组 + 暴露面（单一真源驱动；GUI 编辑器改由 configSchema 渲染）
    effective: effectiveRows,
    // G：应用结果（green=已生效 / red=未按预期生效或已回滚 / in-progress=重启中）
    lastApply: applyPending
      ? { status: 'in-progress', at: applyPending.at ?? null, fields: applyPending.fields ?? [], attempt: applyPending.attempt ?? null }
      : (applyResult ?? null),
    configSchema: consoleSchema(),
    statusSchema: consoleStatusSchema(),
    restart: {
      // 服务心跳（serve 常驻写）：用于选择重启命令文案
      serviceHeartbeat: await readServiceHeartbeat(home),
      // 由 launchd/systemd/计划任务拉起时注入（见 @mebular/service buildSpec）；普通 nohup 启动无此标记
      serviceManaged: Boolean(process.env.MEBULAR_SERVICE_KIND || process.env.MEBULAR_SERVICE_SHA),
    },
  };
}

/**
 * C2：对端路径视图（只读）。
 * `paths` = 地址簿里每个键的当前生效路径（kind/address/since/lastError）；
 * 授权状态不在此处暴露（由 policy API 负责），这里只回答「连得上吗、走的哪条路」。
 */
function buildPeerPaths(app) {
  try {
    const book = app?.endpointBook;
    if (!book) return { enabled: false, paths: [] };
    const keys = typeof book.keys === 'function' ? book.keys() : [];
    const paths = keys
      .map((key) => {
        const path = book.getPath(key);
        const candidates = typeof book.list === 'function' ? book.list(key) : [];
        return {
          key,
          connected: Boolean(path),
          kind: path?.kind ?? null,
          address: path?.address ?? null,
          since: path?.since ?? null,
          lastError: path?.lastError ?? candidates.find((c) => c.lastError)?.lastError ?? null,
          candidates: candidates.length,
        };
      })
      .sort((a, b) => Number(b.connected) - Number(a.connected) || a.key.localeCompare(b.key));
    return { enabled: true, paths };
  } catch {
    return { enabled: false, paths: [] };
  }
}

/**
 * C6：内建 relay 角色视图（只读）。`reason` 说明为何开/关；`bridge` 是当前路径为 relay 时的桥地址。
 * 注意：relay 角色不落任何记忆/授权状态，这里只回答「本机当不当桥、我现在经谁中转」。
 */
function buildRelayView(app) {
  try {
    const status = app?.node?.getRelayStatus?.() ?? null;
    if (!status) return { mode: 'off', serving: false, reason: '网络未启用', publicAddrs: [], allowedClients: 0, bridge: null };
    const book = app?.endpointBook;
    let bridge = null;
    if (book && typeof book.keys === 'function') {
      for (const key of book.keys()) {
        const path = book.getPath(key);
        if (path?.kind === 'relay') { bridge = { peer: key, address: path.address, since: path.since }; break; }
      }
    }
    return { ...status, bridge };
  } catch {
    return { mode: 'off', serving: false, reason: 'relay 状态不可读', publicAddrs: [], allowedClients: 0, bridge: null };
  }
}

/**
 * C5：地址自动广播视图（只读）。
 * 记录只作 hints（永不参与授权）；此处只回答「我广播了什么、我采用了谁的、忽略了什么」。
 */
function buildNetView(app) {
  try {
    const status = app?.getNetEndpointsStatus?.() ?? null;
    if (!status) return { enabled: false, mode: 'off', ttlMs: 0, published: 0, applied: 0, ignored: {}, lastPublishedAt: null, lastAcceptedSubjects: [] };
    return status;
  } catch {
    return { enabled: false, mode: 'off', ttlMs: 0, published: 0, applied: 0, ignored: {}, lastPublishedAt: null, lastAcceptedSubjects: [] };
  }
}

/**
 * C4：NAT 穿透视图（只读）。网络未启用/未装配 libp2p 时返回**固定形状**（而非缺字段），
 * 便于控制台与门禁稳定断言。
 */
function buildNatView(app) {
  const base = {
    enabled: false,
    autonatEnabled: false,
    dcutrEnabled: false,
    loadError: null,
    directUpgrades: 0,
    relayConnections: 0,
    lastUpgradeAt: null,
    lastError: null,
  };
  try {
    const status = app?.getNatStatus?.();
    return status ? { ...base, ...status } : base;
  } catch {
    return base;
  }
}

/** GET /admin/api/namespaces/:ns/handoff-plan?successor=…（只读预检） */
export async function buildHandoffPlan({ app }, namespace, successor) {
  if (typeof successor !== 'string' || successor.length === 0) {
    return { status: 400, body: { error: 'bad_request', errorKey: 'handoff_successor_required', message: '需要 ?successor=<deviceId>' } };
  }
  try {
    const plan = await app.planNamespaceHandoff({ namespace, successor });
    return { status: 200, body: plan };
  } catch (error) {
    return { status: 400, body: { error: 'bad_request', message: String(error?.message ?? error) } };
  }
}

/** 任务/舰队面摘要（fleet.config.json；只读，不暴露路径细节以外的内容） */
async function buildFleetView(home) {
  const path = join(home, 'fleet.config.json');
  if (!existsSync(path)) {
    return { fleet: { configured: false, path } };
  }
  try {
    const cfg = JSON.parse(await readFile(path, 'utf-8'));
    return {
      fleet: {
        configured: true,
        path,
        namespace: typeof cfg.namespace === 'string' ? cfg.namespace : null,
        peers: Array.isArray(cfg.peers) ? cfg.peers.length : 0,
        agents: Array.isArray(cfg.agents) ? cfg.agents.length : 0,
      },
    };
  } catch (error) {
    return { fleet: { configured: true, path, parseError: String(error?.message ?? error) } };
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

/**
 * G-ML-1：记忆列表（动作式 GUI 的读面）。
 * 默认**过滤已删除（墓碑）与已归档**；`includeDeleted=1` / `includeArchived=1` 可切换查看。
 * 只读、脱敏（只给预览，不回显完整 metadata）。
 */
export async function buildMemories({ app, url }) {
  const params = url?.searchParams ?? new URLSearchParams();
  const flag = (name) => params.get(name) === '1' || params.get(name) === 'true';
  const includeArchived = flag('includeArchived');
  const includeDeleted = flag('includeDeleted');
  // 0.3：Runtime 内部对象默认隐藏；includeInternal=1 仅管理面调试使用。
  const includeInternal = flag('includeInternal');
  const namespace = params.get('namespace') ?? undefined;
  const limitRaw = Number(params.get('limit') ?? '50');
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;

  const archivedOf = (node) => typeof node?.metadata?.archivedAt === 'number';
  let nodes = [];
  try {
    nodes = await app.storage.listNodes();
  } catch {
    nodes = [];
  }
  const filtered = nodes.filter((node) => {
    if (!includeDeleted && node.deletedAt) return false;
    if (!includeArchived && archivedOf(node)) return false;
    if (!includeInternal && isRuntimeInternalObject(node)) return false;
    if (namespace !== undefined && (node.namespace ?? 'default') !== namespace) return false;
    return true;
  });
  const previewOf = (node) => {
    const content = node?.content ?? {};
    if (typeof content === 'string') return content.slice(0, 160);
    if (node?.type === 'fact') {
      const f = content;
      const triple = `${f.subject ?? ''} ${f.predicate ?? ''} ${f.object ?? ''}`.trim();
      const text = typeof f.object === 'string' && f.object.length > 0 ? f.object : triple;
      return text.slice(0, 160);
    }
    const text = content.content ?? content.name ?? content.description ?? content.value ?? '';
    return String(text).slice(0, 160);
  };
  const memories = filtered
    .slice()
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, limit)
    .map((node) => ({
      id: node.id,
      type: node.type,
      namespace: node.namespace ?? 'default',
      preview: previewOf(node),
      createdAt: node.createdAt ?? null,
      updatedAt: node.updatedAt ?? null,
      archived: archivedOf(node),
      archivedAt: node.metadata?.archivedAt ?? null,
      deleted: Boolean(node.deletedAt),
      deletedAt: node.deletedAt ?? null,
      tags: Array.isArray(node.tags) ? node.tags : [],
    }));
  return {
    total: filtered.length,
    limit,
    includeArchived,
    includeDeleted,
    includeInternal,
    ...(namespace !== undefined ? { namespace } : {}),
    memories,
  };
}

/** 只读 API 路由表：路径 → 构造器 */
/** F-CLI-2 · GET /admin/api/net：守护本机网络真状态（只读；`doctor --net` 守护感知复用）。 */
export async function buildNetStatusView({ app }) {
  let paths = [];
  try {
    const book = app?.endpointBook;
    paths = book ? book.keys().map((key) => ({ key, path: book.getPath(key) })) : [];
  } catch {
    paths = [];
  }
  return {
    enabled: Boolean(app?.node?.isRunning?.()),
    listen: app?.node?.getLocalMultiaddrs?.() ?? [],
    paths,
    lan: app?.node?.getLanStatus?.() ?? null,
    net: app?.getNetEndpointsStatus?.() ?? null,
    nat: app?.getNatStatus?.() ?? null,
    relay: app?.node?.getRelayStatus?.() ?? null,
  };
}

/** H-1 · GET /admin/api/service：常驻运行状态（registered/running/autostart/heartbeat）。 */
export async function buildServiceView({ home: instanceHome }) {
  const { runtimeServiceStatus, runtimeProviderFromEnv, RUNTIME_SERVICE_KIND } = await import('./runtime-service.mjs');
  const { registeredForHome, resolveServiceHome, SERVICE_KIND } = await import('./service-control.mjs');
  const platform = process.platform;
  // 两套 home：home 是实例身份（descriptor 的 MEBULAR_HOME/心跳），serviceHome 是 unit/manifest 落盘位置。
  // 旧实现把两者混用 → 控制台去实例 home 下找 unit，对 CLI 装在 OS home 的服务误报「未常驻」。
  const serviceHome = resolveServiceHome();
  const cloud = resolveCloudRoot({ home: instanceHome, env: process.env });
  const fallbackProvider = runtimeProviderFromEnv({ cliPath: process.argv[1] });
  let status = null;
  let error = null;
  try {
    if (cloud.available) {
      status = await runtimeServiceStatus({
        root: cloud.root,
        home: instanceHome,
        serviceHome,
        platform,
        fallbackProvider,
      });
      if (status.ok !== true) error = status.message ?? status.reason ?? 'service_unknown';
    } else {
      const { serviceStatusForHome } = await import('./service-control.mjs');
      status = serviceStatusForHome({ home: instanceHome, serviceHome, platform });
    }
  } catch (cause) {
    error = String(cause?.message ?? cause);
  }
  let registeredKinds = [];
  try {
    registeredKinds = registeredForHome({ home: instanceHome, serviceHome, platform });
  } catch {
    registeredKinds = [];
  }
  return {
    platform,
    kind: RUNTIME_SERVICE_KIND ?? SERVICE_KIND,
    home: instanceHome,
    serviceHome,
    serviceManaged: Boolean(process.env.MEBULAR_SERVICE_KIND || process.env.MEBULAR_SERVICE_SHA),
    registered: status?.registered ?? registeredKinds.includes(SERVICE_KIND),
    running: status?.running ?? false,
    autostart: status?.autostart ?? null,
    unitPath: status?.unitPath ?? null,
    version: status?.version ?? null,
    runtimePath: status?.runtimePath ?? null,
    provider: status?.provider ?? null,
    owner: status?.owner ?? null,
    current: status?.current ?? null,
    currentUsable: status?.currentUsable === true,
    ...(error ? { error } : {}),
    sha: status?.sha ?? null,
    heartbeat: status?.heartbeat ?? null,
    ...(error ? { error } : {}),
  };
}

/** UX-2 · GET /admin/api/clients：助手注册表（内置 ∪ 自定义）三态视图（每助手一张卡的状态）。 */
export async function buildClientsView({ home, url }) {
  const { listAssistantsAsync, assistantUserHome, daemonMcpUrl } = await import('./clients.mjs');
  // F-FIX-A：assistant 路径以**用户主目录**为基；`home` 只用于 Mebular 自有文件（assistants.custom.json）
  const userHome = assistantUserHome();
  let clients = [];
  let customError = null;
  let customPath = null;
  let cached = false;
  let error = null;
  try {
    // F-PERF-2：请求路径走**异步探针 + 短 TTL 缓存**（`?refresh=1` 绕过；并发单飞）
    const refresh = typeof url?.searchParams?.get === 'function' && url.searchParams.get('refresh') === '1';
    // F-FIX-B：条目/片段指向**本 serve 实例的守护 HTTP /mcp**（由请求 Host/scheme 推导）
    const mcpUrl = daemonMcpUrl({ host: url?.host, encrypted: url?.protocol === 'https:' });
    const out = await listAssistantsAsync({ home, userHome, cwd: process.cwd(), refresh, mcpUrl });
    clients = out.assistants;
    customError = out.customError;
    customPath = out.customPath;
    cached = out.cached === true;
  } catch (cause) {
    error = String(cause?.message ?? cause);
  }
  return {
    clients,
    cached,
    ...(customError ? { customError } : {}),
    ...(customPath ? { customPath } : {}),
    ...(error ? { error } : {}),
  };
}

export const READ_ROUTES = {
  '/admin/api/overview': buildOverview,
  '/admin/api/clouds': buildClouds,
  '/admin/api/devices': buildDevices,
  '/admin/api/policy': buildPolicy,
  '/admin/api/namespaces': buildNamespaces,
  '/admin/api/settings': buildSettings,
  '/admin/api/config': buildConfigView,
  '/admin/api/memories': buildMemories,
  '/admin/api/net': buildNetStatusView,
  '/admin/api/service': buildServiceView,
  '/admin/api/clients': buildClientsView,
};
