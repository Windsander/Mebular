// W2 B1：fleet 客户端化——任务事件存进**守护的本机 app 接口**（loopback HTTP + token）。
//
// daemon 模式（默认于统一上车）：node/worker 不再监听 libp2p、不托管 join——网络/身份/信任归守护；
// fleet 只保留任务语义/agents/配额/执行器/工具体系。embedded 模式仅供测试/CI。

import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import type { TaskEvent } from '../protocol/events.js';
import { validateTaskEvent } from '../protocol/events.js';
import { dedupeEvents } from '../model.js';
import type { TaskEventStore } from './file-store.js';

export interface DaemonStoreOptions {
  /** 守护 app 端点，如 http://127.0.0.1:7331 */
  endpoint: string;
  /** 任务分区（默认 tasks） */
  namespace?: string;
  /** 事件节点类型（默认 task_event） */
  type?: string;
  /** bearer token（内联）；与 tokenFile 二选一 */
  token?: string;
  /** token 文件（JSON 数组或 {tokens:[…]}? 这里取纯文本/JSON 点路径，默认整文件文本） */
  tokenFile?: string;
  timeoutMs?: number;
}

interface DaemonReply {
  ok: boolean;
  error?: string;
  count?: number;
  nodes?: Array<{ id: string; type: string; namespace: string; content: unknown }>;
  node?: { id: string; type: string; namespace: string };
}

function readToken(options: DaemonStoreOptions): string | undefined {
  if (options.token !== undefined && options.token.length > 0) return options.token;
  if (options.tokenFile !== undefined) {
    try {
      const raw = readFileSync(options.tokenFile, 'utf-8').trim();
      if (raw.startsWith('{')) {
        const parsed = JSON.parse(raw) as { token?: unknown };
        // 仅接受 `{ token }` 形态；`tokens.json`（多令牌）不猜，返回 undefined（调用方应内联 token）
        return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : undefined;
      }
      return raw.length > 0 ? raw : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function requestJson<T>(url: string, method: string, token: string | undefined, body: unknown, timeoutMs: number): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const req = transport.request(u, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c.toString('utf-8')));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) as T });
        } catch (error) {
          reject(new Error(`守护响应无法解析：${(error as Error).message}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('守护请求超时')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * 走守护 app 接口的任务事件存储。**无本地 Mebular、无 libp2p、无身份处理**。
 * 幂等由 `eventId` 去重保证（与 `MebularTaskEventStore` 同一语义）。
 */
export class DaemonTaskEventStore implements TaskEventStore {
  private readonly endpoint: string;
  private readonly namespace: string;
  private readonly type: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: DaemonStoreOptions) {
    if (typeof options.endpoint !== 'string' || options.endpoint.length === 0) {
      throw new Error('DaemonTaskEventStore 需要 endpoint');
    }
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.namespace = options.namespace ?? 'tasks';
    this.type = options.type ?? 'task_event';
    this.token = readToken(options);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async list(): Promise<DaemonReply> {
    const url = `${this.endpoint}/app/nodes?namespace=${encodeURIComponent(this.namespace)}&type=${encodeURIComponent(this.type)}`;
    const { status, json } = await requestJson<DaemonReply>(url, 'GET', this.token, undefined, this.timeoutMs);
    if (status !== 200 || json.ok !== true) throw new Error(`守护 listNodes 失败（HTTP ${status}）：${json.error ?? '未知'}`);
    return json;
  }

  async all(): Promise<TaskEvent[]> {
    const reply = await this.list();
    const valid: TaskEvent[] = [];
    for (const node of reply.nodes ?? []) {
      if (typeof node.content !== 'object' || node.content === null) continue;
      if (!validateTaskEvent(node.content).ok) continue;
      valid.push(node.content as unknown as TaskEvent);
    }
    return dedupeEvents(valid);
  }

  async append(event: TaskEvent): Promise<boolean> {
    const existing = await this.all();
    if (existing.some((e) => e.eventId === event.eventId)) return false;
    const { status, json } = await requestJson<DaemonReply>(
      `${this.endpoint}/app/nodes`,
      'POST',
      this.token,
      { type: this.type, namespace: this.namespace, content: event },
      this.timeoutMs,
    );
    if (status !== 200 || json.ok !== true) throw new Error(`守护 createNode 失败（HTTP ${status}）：${json.error ?? '未知'}`);
    return true;
  }

  async byTask(taskId: string): Promise<TaskEvent[]> {
    return (await this.all()).filter((e) => e.taskId === taskId);
  }

  async close(): Promise<void> {
    // 连接按需创建；无持久资源。
  }
}
