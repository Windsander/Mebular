// 通用「消息」存储（1d）：协商/闲聊消息以**图节点**承载，落在既有 **已授权** 的 tasks 分区内，
// 用**不同节点类型**区分（`negotiation_message` / `chatter_message`），从而随 core 记忆同步传递
// ——无需新增分区/授权/同步原语。幂等键 = `messageId`（重复 append 返回 false）。

import type { Mebular } from '@mebular/core';

export interface MebularMessageStoreOptions<T> {
  /** 节点类型（必填，用于与任务事件区分） */
  type: string;
  /** 分区（默认 `tasks`：复用既有已授权分区） */
  namespace?: string;
  /** 校验（形状非法 → 忽略） */
  validate: (input: unknown) => { ok: boolean };
  /** 幂等键 */
  idOf: (message: T) => string;
}

/** 以 Mebular 图示记忆承载的幂等消息存储（协商/闲聊）。 */
export class MebularMessageStore<T> {
  private readonly mebular: Mebular;
  private readonly namespace: string;
  private readonly type: string;
  private readonly validate: (input: unknown) => { ok: boolean };
  private readonly idOf: (message: T) => string;

  constructor(mebular: Mebular, options: MebularMessageStoreOptions<T>) {
    this.mebular = mebular;
    this.namespace = options.namespace ?? 'tasks';
    this.type = options.type;
    this.validate = options.validate;
    this.idOf = options.idOf;
  }

  async all(): Promise<T[]> {
    const nodes = await this.mebular.graph.listNodes({ type: this.type });
    const valid: T[] = [];
    for (const node of nodes) {
      if (node.namespace !== this.namespace) continue;
      const candidate = node.content;
      if (typeof candidate !== 'object' || candidate === null) continue;
      if (!this.validate(candidate).ok) continue;
      valid.push(candidate as unknown as T);
    }
    // 幂等去重（同 messageId 确定取首见；去重后按 id 字典序 → 顺序无关）
    const byId = new Map<string, T>();
    for (const message of valid) if (!byId.has(this.idOf(message))) byId.set(this.idOf(message), message);
    return [...byId.values()].sort((a, b) => (this.idOf(a) < this.idOf(b) ? -1 : this.idOf(a) > this.idOf(b) ? 1 : 0));
  }

  async append(message: T): Promise<boolean> {
    const id = this.idOf(message);
    if ((await this.all()).some((m) => this.idOf(m) === id)) return false;
    await this.mebular.graph.createNode(this.type, message as unknown as Record<string, unknown>, [], {
      namespace: this.namespace,
    });
    return true;
  }

  async close(): Promise<void> {
    // 生命周期由 Mebular 管理
  }
}
