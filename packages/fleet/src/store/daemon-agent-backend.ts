// CR-002：daemon 模式能力卡/目录后端。
//
// 生产 fleet 是 daemon 客户端：没有本地 Mebular 句柄，也不能在守护的存储上开第二个写者。
// 本后端只走既有本机 app 接口：
// - 能力卡：`POST /app/capability-cards`（守护身份签名 + internal 节点写入）；
// - 读取：`GET /app/nodes?namespace=agents&type=...`（[raw-graph-debug] 只读面）；
// - Agent 目录：`POST/GET /app/nodes`（普通消息节点）。
// 签名/canonical JSON 的唯一实现仍在 fleet `cards.ts`；此处不复制。

import {
  AGENT_NAMESPACE,
  validateAgentDirectory,
  type AgentDirectoryBackend,
  type AgentDirectoryEntry,
} from '../agentdir.js';
import {
  validateAgentCapabilityCard,
  verifyAgentCapabilityCardSignature,
  type AgentCapabilityCard,
  type CapabilityCardBackend,
  type CapabilityCardDraft,
} from '../cards.js';
import { requestDaemonJson, readDaemonToken } from '../store/daemon-store.js';

interface DaemonNode {
  id: string;
  type: string;
  namespace: string;
  content: unknown;
  createdBy?: string;
  metadata?: Record<string, unknown>;
}

interface NodesReply {
  ok: boolean;
  error?: string;
  message?: string;
  count?: number;
  nodes?: DaemonNode[];
}

interface NodeReply {
  ok: boolean;
  error?: string;
  message?: string;
  node?: { id: string; type: string; namespace: string };
}

interface CardReply {
  ok: boolean;
  error?: string;
  message?: string;
  card?: unknown;
  nodeId?: string | null;
  replayed?: boolean;
}

interface SubscriptionsReply {
  ok: boolean;
  error?: string;
  message?: string;
  device?: string;
  namespaces?: unknown;
}

interface PeersReply {
  ok: boolean;
  error?: string;
  message?: string;
  peers?: Array<{ device?: unknown; publicKeyHex?: unknown }>;
}

export interface DaemonAgentBackendOptions {
  endpoint: string;
  token?: string;
  tokenFile?: string;
  namespace?: string;
  timeoutMs?: number;
  /** 卡读取信任：远端公钥由调用方注入；本机公钥可用 identity 文件/守护密钥。 */
  publicKeyFor?: (device: string) => Uint8Array | string | undefined;
}

function daemonError(message: string, code?: string): Error {
  const error = new Error(message) as Error & { code?: string };
  if (code !== undefined) error.code = code;
  return error;
}

/** 本机守护 app 接口上的 Agent 域后端（能力卡 + 目录）。 */
export class DaemonAgentBackend implements CapabilityCardBackend, AgentDirectoryBackend {
  private readonly endpoint: string;
  private readonly namespace: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly publicKeyFor: ((device: string) => Uint8Array | string | undefined) | undefined;

  constructor(options: DaemonAgentBackendOptions) {
    if (typeof options.endpoint !== 'string' || options.endpoint.length === 0) {
      throw new Error('DaemonAgentBackend 需要 endpoint');
    }
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.namespace = options.namespace ?? AGENT_NAMESPACE;
    this.token = readDaemonToken(options);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.publicKeyFor = options.publicKeyFor;
  }

  private async listNodes(type: string): Promise<DaemonNode[]> {
    const url = `${this.endpoint}/app/nodes?namespace=${encodeURIComponent(this.namespace)}&type=${encodeURIComponent(type)}`;
    const { status, json } = await requestDaemonJson<NodesReply>(url, 'GET', this.token, undefined, this.timeoutMs);
    if (status !== 200 || json.ok !== true) {
      throw daemonError(`守护 listNodes 失败（HTTP ${status}）：${json.error ?? '未知'}`);
    }
    return (json.nodes ?? []).filter((node) => node.namespace === this.namespace && node.type === type);
  }

  async listCards(): Promise<AgentCapabilityCard[]> {
    const cards: AgentCapabilityCard[] = [];
    const peerKeys = await this.listPeerPublicKeys().catch(() => new Map<string, string>());
    for (const node of await this.listNodes('agent_capability_card')) {
      if (node.metadata?.internal !== true) continue;
      const internalObject = node.metadata.internalObject;
      if (typeof internalObject !== 'object' || internalObject === null || Array.isArray(internalObject)) continue;
      if ((internalObject as { kind?: unknown }).kind !== 'agent_capability_card') continue;
      if (!validateAgentCapabilityCard(node.content).ok) continue;
      const card = node.content as AgentCapabilityCard;
      if (node.createdBy !== card.device) continue;
      const publicKey = this.publicKeyFor?.(card.device) ?? peerKeys.get(card.device);
      if (publicKey === undefined) continue;
      if (!(await verifyAgentCapabilityCardSignature(card, publicKey))) continue;
      cards.push(card);
    }
    return cards;
  }

  /**
   * P6：守护内部 `/app/peers` 只返回 sync 已认证在线的 peer（deviceId + Ed25519 公钥）。
   * 旧守护无此端点时返回空集合，保持“只信任本机公钥”的 fail-closed 行为。
   */
  private async listPeerKeys(): Promise<Array<{ device: string; publicKeyHex: string }>> {
    const url = `${this.endpoint}/app/peers`;
    const { status, json } = await requestDaemonJson<PeersReply>(url, 'GET', this.token, undefined, this.timeoutMs);
    if (status !== 200 || json.ok !== true) return [];
    const out: Array<{ device: string; publicKeyHex: string }> = [];
    for (const peer of json.peers ?? []) {
      if (typeof peer?.device !== 'string' || peer.device.length === 0) continue;
      if (typeof peer.publicKeyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(peer.publicKeyHex)) continue;
      out.push({ device: peer.device, publicKeyHex: peer.publicKeyHex });
    }
    return out;
  }

  private async listPeerPublicKeys(): Promise<Map<string, string>> {
    return new Map((await this.listPeerKeys()).map((peer) => [peer.device, peer.publicKeyHex]));
  }

  /** P6：已认证在线设备（不含本机；由路由 provider 合并 local device）。 */
  async listOnlineDevices(): Promise<string[]> {
    return [...new Set((await this.listPeerKeys()).map((peer) => peer.device))].sort();
  }

  /** 只读订阅查询：`GET /app/policy/subscriptions?device=`；失败抛错，由路由层 fail-closed。 */
  async getSubscriptions(device: string): Promise<string[]> {
    const url = `${this.endpoint}/app/policy/subscriptions?device=${encodeURIComponent(device)}`;
    const { status, json } = await requestDaemonJson<SubscriptionsReply>(url, 'GET', this.token, undefined, this.timeoutMs);
    if (status !== 200 || json.ok !== true) {
      throw daemonError(`守护 getSubscriptions 失败（HTTP ${status}）：${json.error ?? '未知'}`);
    }
    if (!Array.isArray(json.namespaces)) return [];
    return json.namespaces.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }

  async listDirectories(): Promise<AgentDirectoryEntry[]> {
    const entries: AgentDirectoryEntry[] = [];
    for (const node of await this.listNodes('agent_directory')) {
      if (validateAgentDirectory(node.content).ok) entries.push(node.content as AgentDirectoryEntry);
    }
    return entries;
  }

  async appendDirectory(entry: AgentDirectoryEntry): Promise<boolean> {
    const { status, json } = await requestDaemonJson<NodeReply>(
      `${this.endpoint}/app/nodes`,
      'POST',
      this.token,
      { type: 'agent_directory', namespace: this.namespace, content: entry },
      this.timeoutMs,
    );
    if (status !== 200 || json.ok !== true) {
      throw daemonError(`守护 createNode 失败（HTTP ${status}）：${json.error ?? '未知'}`);
    }
    return true;
  }

  async signAndAppendCard(draft: CapabilityCardDraft): Promise<AgentCapabilityCard> {
    const { status, json } = await requestDaemonJson<CardReply>(
      `${this.endpoint}/app/capability-cards`,
      'POST',
      this.token,
      { card: draft, namespace: this.namespace },
      this.timeoutMs,
    );
    if (json.ok !== true) {
      throw daemonError(
        `守护能力卡发布失败（HTTP ${status}）：${json.message ?? json.error ?? '未知'}`,
        json.error,
      );
    }
    const validation = validateAgentCapabilityCard(json.card);
    if (!validation.ok) {
      throw daemonError(`守护返回的能力卡非法：${validation.errors.join('; ')}`, 'invalid_card');
    }
    const card = json.card as AgentCapabilityCard;
    if (card.device !== draft.device || card.agent !== draft.agent || card.version !== draft.version) {
      throw daemonError('守护返回的能力卡与 draft 不一致', 'card_mismatch');
    }
    return card;
  }
}
