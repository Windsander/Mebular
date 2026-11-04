// P5 daemon 角色卡存储：只走本机内部 app 接口 `/app/role-cards`（loopback + memory.read/write）。
//
// 边界：
// - 不新增公共 MCP 方法/人类 UI；端点只服务 fleet 内部 runtime job/route。
// - daemon 返回的卡仍按 schema + author 绑定（createdBy=device）过滤，不伪造远端卡。
// - 版本/幂等语义由守护端与 fleet 共用 `role-cards.ts`，此处不复制规则。

import { AGENT_NAMESPACE } from '../agentdir.js';
import {
  RoleCardValidationError,
  validateAgentRoleCard,
  type AgentRoleCard,
  type RoleCardAppendResult,
  type RoleCardStore,
  type StoredAgentRoleCard,
} from '../role-cards.js';
import { readDaemonToken, requestDaemonJson, type DaemonStoreOptions } from './daemon-store.js';

interface DaemonRoleCardNode {
  id: string;
  type?: string;
  namespace?: string;
  createdBy?: string;
  deletedAt?: number;
  content?: unknown;
  metadata?: Record<string, unknown>;
}

interface RoleCardsReply {
  ok: boolean;
  error?: string;
  message?: string;
  count?: number;
  cards?: AgentRoleCard[];
  nodes?: DaemonRoleCardNode[];
  card?: AgentRoleCard;
  nodeId?: string | null;
  createdBy?: string;
  replayed?: boolean;
}

interface RoleCardReply {
  ok: boolean;
  error?: string;
  message?: string;
  errors?: string[];
  card?: AgentRoleCard;
  nodeId?: string | null;
  createdBy?: string;
  replayed?: boolean;
}

const ROLE_CARD_ERROR_CODES = new Set([
  'ROLE_CARD_SCHEMA',
  'ROLE_CARD_CONFLICT',
  'ROLE_CARD_STALE',
  'ROLE_CARD_VERSION_GAP',
  'ROLE_CARD_AUTHOR',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** daemon（`/app/role-cards`）角色卡 store；无本地 Mebular/libp2p。 */
export class DaemonRoleCardStore implements RoleCardStore {
  private readonly endpoint: string;
  private readonly namespace: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: DaemonStoreOptions) {
    if (typeof options.endpoint !== 'string' || options.endpoint.length === 0) {
      throw new Error('DaemonRoleCardStore 需要 endpoint');
    }
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.namespace = options.namespace ?? AGENT_NAMESPACE;
    this.token = readDaemonToken(options);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async listStored(): Promise<StoredAgentRoleCard[]> {
    const url = `${this.endpoint}/app/role-cards?namespace=${encodeURIComponent(this.namespace)}`;
    const { status, json } = await requestDaemonJson<RoleCardsReply>(url, 'GET', this.token, undefined, this.timeoutMs);
    if (status !== 200 || json.ok !== true) {
      throw new Error(`守护 listRoleCards 失败（HTTP ${status}）：${json.error ?? '未知'}`);
    }
    const out: StoredAgentRoleCard[] = [];
    for (const node of json.nodes ?? []) {
      if (node.deletedAt !== undefined) continue;
      if (node.namespace !== undefined && node.namespace !== this.namespace) continue;
      if (node.metadata?.internal !== true) continue;
      const internalObject = node.metadata.internalObject;
      if (!isRecord(internalObject) || internalObject.kind !== 'agent_role_card') continue;
      const validation = validateAgentRoleCard(node.content);
      if (!validation.ok) continue;
      const card = node.content as AgentRoleCard;
      // 作者绑定：daemon 返回 createdBy，必须等于卡片 device；否则不信任。
      if (node.createdBy !== card.device) continue;
      out.push({ card, nodeId: node.id, createdBy: node.createdBy });
    }
    return out.sort((a, b) => {
      if (a.card.device !== b.card.device) return a.card.device < b.card.device ? -1 : 1;
      if (a.card.agent !== b.card.agent) return a.card.agent < b.card.agent ? -1 : 1;
      if (a.card.version !== b.card.version) return a.card.version - b.card.version;
      return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
    });
  }

  async list(): Promise<AgentRoleCard[]> {
    return (await this.listStored()).map((entry) => entry.card);
  }

  async append(input: unknown): Promise<RoleCardAppendResult> {
    const { status, json } = await requestDaemonJson<RoleCardReply>(
      `${this.endpoint}/app/role-cards`,
      'POST',
      this.token,
      { card: input, namespace: this.namespace },
      this.timeoutMs,
    );
    if (status === 200 && json.ok === true && json.card !== undefined) {
      const validation = validateAgentRoleCard(json.card);
      if (!validation.ok) {
        throw new RoleCardValidationError('ROLE_CARD_SCHEMA', [`守护返回的角色卡非法：${validation.errors.join('; ')}`]);
      }
      const card = json.card;
      const draft = input as AgentRoleCard;
      if (card.device !== draft.device || card.agent !== draft.agent || card.version !== draft.version) {
        throw new RoleCardValidationError('ROLE_CARD_CONFLICT', ['守护返回的角色卡与提交内容不一致']);
      }
      const createdBy = json.createdBy ?? card.device;
      if (createdBy !== card.device) {
        throw new RoleCardValidationError('ROLE_CARD_AUTHOR', ['守护返回的角色卡作者与 device 不一致']);
      }
      return {
        stored: json.replayed !== true,
        replayed: json.replayed === true,
        card,
        nodeId: json.nodeId ?? null,
        createdBy,
      };
    }
    const code = json.error;
    if (code !== undefined && ROLE_CARD_ERROR_CODES.has(code)) {
      throw new RoleCardValidationError(code, json.message !== undefined ? [json.message] : []);
    }
    if (status === 422 && (code === 'card_invalid' || code === 'role_card_invalid')) {
      throw new RoleCardValidationError('ROLE_CARD_SCHEMA', json.errors ?? [json.message ?? '角色卡 schema 非法']);
    }
    if (status === 403 && code === 'device_mismatch') {
      throw new RoleCardValidationError('ROLE_CARD_AUTHOR', [json.message ?? '角色卡 device 必须是本机守护设备']);
    }
    if (status === 400 && code === 'namespace_invalid') {
      throw new RoleCardValidationError('ROLE_CARD_SCHEMA', [json.message ?? '角色卡只能写入 agents 域']);
    }
    throw new Error(`守护 appendRoleCard 失败（HTTP ${status}）：${code ?? '未知'}`);
  }

  async close(): Promise<void> {
    // 按需 HTTP；无持久资源。
  }
}
