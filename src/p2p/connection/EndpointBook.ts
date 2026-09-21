// C1 · 候选端点簿 + 端点存储（core 机制；注入式、离线安全）
//
// 机制在 core、策略在 app：
//   - core 只提供「每对端多地址 + 分类 + 来源 + 成败统计 + 拨号顺序」这套引擎，
//     以及可注入的存储接口（默认内存实现；可选文件实现）。
//   - app 决定文件位置/开关/参数（core 从不读文件、不猜路径）。
// 设计约束：零新依赖；network 关闭时全部 no-op（不 load/不 persist）。

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname } from 'path';

/** 端点类别：直连（公网/可路由）> 局域网 > circuit relay。 */
export type EndpointKind = 'direct' | 'lan' | 'relay';

/** 端点来源：配置 / 配对 hints / 运行时学习。 */
export type EndpointSource = 'config' | 'paired' | 'learned';

export interface EndpointCandidate {
  address: string;
  kind: EndpointKind;
  source: EndpointSource;
  addedAt: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

export interface PathState {
  kind: EndpointKind;
  address: string;
  /** 本路径生效时间（ms） */
  since: number;
  lastError?: string;
}

/** 端点簿持久化接缝：默认内存；app 可注入文件实现（<home>/net/peers.json，0600）。 */
export interface EndpointStore {
  load(): Promise<Record<string, EndpointCandidate[]>>;
  save(book: Record<string, EndpointCandidate[]>): Promise<void>;
}

/**
 * 保留键：relay seeds（**不是 peer**，故不放进任何 peer 候选，避免把它当对端地址拨号）。
 * 由 app 决定如何使用（如并入 network.libp2p.relayServers）。
 */
export const RELAY_SEEDS_KEY = '__relay-seeds__';

/** 拨号优先级：direct > lan > relay（同类别按最近成功优先）。 */
export const KIND_PRIORITY: Record<EndpointKind, number> = { direct: 0, lan: 1, relay: 2 };

const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local
];

/** 从 multiaddr/host 串里取出主机部分（支持 /ip4 /ip6 /dns4 /dns6 /dns）。 */
export function extractEndpointHost(address: string): string | null {
  const match = String(address ?? '').match(/\/(ip4|ip6|dns4|dns6|dns)\/([^/]+)/);
  if (match) return match[2] ?? null;
  const plain = String(address ?? '').trim();
  return plain.length > 0 ? plain : null;
}

/** 端点分类：relay（含 /p2p-circuit）> lan（私有 IPv4/.local）> direct。 */
export function classifyEndpoint(address: string): EndpointKind {
  const value = String(address ?? '');
  if (value.includes('/p2p-circuit')) return 'relay';
  const host = extractEndpointHost(value);
  if (!host) return 'direct';
  if (host.endsWith('.local')) return 'lan';
  if (PRIVATE_V4.some((re) => re.test(host))) return 'lan';
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return 'lan';
  return 'direct';
}

/**
 * 由设备公钥派生 peerId 字符串（hex(sha256(pubkey))）——与 P2PNode.derivePeerId 同一规则。
 * 用途：配对 hints 以 deviceId 给出时，app 可同时算出对端 peerId，让首次拨号即可命中地址簿。
 */
export function derivePeerIdHex(publicKey: Uint8Array): string {
  return Buffer.from(createHash('sha256').update(publicKey).digest()).toString('hex');
}

/** 默认内存实现（无文件 IO；离线安全）。 */
export class InMemoryEndpointStore implements EndpointStore {
  private book: Record<string, EndpointCandidate[]>;
  constructor(initial: Record<string, EndpointCandidate[]> = {}) {
    this.book = deepCopyBook(initial);
  }
  async load(): Promise<Record<string, EndpointCandidate[]>> {
    return deepCopyBook(this.book);
  }
  async save(book: Record<string, EndpointCandidate[]>): Promise<void> {
    this.book = deepCopyBook(book);
  }
}

/**
 * 可选文件实现（原子写 + 0600）。**core 不决定路径**：由 app 传入（如 <home>/net/peers.json）。
 * 读失败/损坏一律降级为空簿（绝不因地址簿问题阻断启动）。
 */
export class FileEndpointStore implements EndpointStore {
  constructor(private readonly path: string) {}

  async load(): Promise<Record<string, EndpointCandidate[]>> {
    try {
      const raw = await readFile(this.path, 'utf-8');
      const parsed = JSON.parse(raw);
      return normalizeBook(parsed);
    } catch {
      return {};
    }
  }

  async save(book: Record<string, EndpointCandidate[]>): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(normalizeBook(book), null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    // Windows 上 rename 不覆盖已存在目标 → 先删（POSIX 直接原子替换）
    if (process.platform === 'win32') await rm(this.path, { force: true });
    await rename(tmp, this.path);
  }
}

function deepCopyBook(book: Record<string, EndpointCandidate[]>): Record<string, EndpointCandidate[]> {
  const out: Record<string, EndpointCandidate[]> = {};
  for (const [key, list] of Object.entries(book ?? {})) {
    out[key] = (list ?? []).map((entry) => ({ ...entry }));
  }
  return out;
}

function normalizeBook(value: unknown): Record<string, EndpointCandidate[]> {
  const out: Record<string, EndpointCandidate[]> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const entries: EndpointCandidate[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (typeof record.address !== 'string' || record.address.length === 0) continue;
      entries.push({
        address: record.address,
        kind: (['direct', 'lan', 'relay'] as EndpointKind[]).includes(record.kind as EndpointKind)
          ? (record.kind as EndpointKind)
          : classifyEndpoint(record.address),
        source: (['config', 'paired', 'learned'] as EndpointSource[]).includes(record.source as EndpointSource)
          ? (record.source as EndpointSource)
          : 'learned',
        addedAt: typeof record.addedAt === 'number' ? record.addedAt : Date.now(),
        ...(typeof record.lastSuccessAt === 'number' ? { lastSuccessAt: record.lastSuccessAt } : {}),
        ...(typeof record.lastFailureAt === 'number' ? { lastFailureAt: record.lastFailureAt } : {}),
        ...(typeof record.lastError === 'string' ? { lastError: record.lastError } : {}),
      });
    }
    if (entries.length > 0) out[key] = entries;
  }
  return out;
}

export interface EndpointBookOptions {
  /** 存储接缝；缺省内存实现 */
  store?: EndpointStore;
  /** 每对端候选上限（默认 16；防止 hints/学习无限增长） */
  maxPerPeer?: number;
  /** 时间源（测试用） */
  now?: () => number;
}

/**
 * 候选端点簿：per-key（peerId，或 app 侧的 deviceId 键）多地址 + 分类/来源/成败统计；
 * 维护「当前路径」状态并在路径变化时发 `path-changed`。
 */
export class EndpointBook extends EventEmitter {
  private readonly store: EndpointStore;
  private readonly maxPerPeer: number;
  private readonly now: () => number;
  private book = new Map<string, EndpointCandidate[]>();
  private paths = new Map<string, PathState>();
  private loaded = false;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(options: EndpointBookOptions = {}) {
    super();
    this.store = options.store ?? new InMemoryEndpointStore();
    this.maxPerPeer = options.maxPerPeer ?? 16;
    this.now = options.now ?? (() => Date.now());
  }

  /** 从存储加载（幂等；network 关闭时调用方不应调用）。 */
  async load(): Promise<void> {
    const raw = await this.store.load();
    this.book = new Map(Object.entries(raw).map(([key, list]) => [key, list.map((entry) => ({ ...entry }))]));
    this.loaded = true;
  }

  /** 落盘（记忆中的簿 → store）。 */
  async persist(): Promise<void> {
    const snapshot: Record<string, EndpointCandidate[]> = {};
    for (const [key, list] of this.book.entries()) snapshot[key] = list.map((entry) => ({ ...entry }));
    await this.store.save(snapshot);
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** 写入/合并候选（去重；同 address 保留更早的 addedAt 并刷新来源优先级与分类）。 */
  async upsert(key: string, addresses: string[], source: EndpointSource): Promise<number> {
    const list = this.book.get(key) ?? [];
    const byAddress = new Map(list.map((entry) => [entry.address, entry]));
    let changed = 0;
    for (const address of addresses ?? []) {
      if (typeof address !== 'string' || address.length === 0) continue;
      const existing = byAddress.get(address);
      if (existing) {
        if (sourceRank(source) > sourceRank(existing.source)) {
          existing.source = source;
          changed += 1;
        }
        continue;
      }
      byAddress.set(address, { address, kind: classifyEndpoint(address), source, addedAt: this.now() });
      changed += 1;
    }
    if (changed === 0) return 0;
    const merged = [...byAddress.values()].sort(compareCandidates).slice(0, this.maxPerPeer);
    this.book.set(key, merged);
    await this.persist();
    return changed;
  }

  /** 把 fromKey 的候选并入 toKey（配对 hints 用 deviceId 键，握手后按 peerId 归并）。 */
  async alias(fromKey: string, toKey: string): Promise<number> {
    const list = this.book.get(fromKey);
    if (!list || list.length === 0 || fromKey === toKey) return 0;
    const addresses = list.map((entry) => entry.address);
    const source = list.every((entry) => entry.source === 'paired') ? 'paired' : 'learned';
    return this.upsert(toKey, addresses, source);
  }

  /** 候选（按拨号优先级排序：direct > lan > relay，其次最近成功、最近加入）。 */
  list(key: string): EndpointCandidate[] {
    return [...(this.book.get(key) ?? [])].sort(compareCandidates);
  }

  /** relay seeds（保留键内容；不是 peer 候选）。 */
  relaySeeds(): string[] {
    return (this.book.get(RELAY_SEEDS_KEY) ?? []).map((entry) => entry.address);
  }

  /** 候选地址（拨号顺序）。 */
  addresses(key: string): string[] {
    return this.list(key).map((entry) => entry.address);
  }

  keys(): string[] {
    return [...this.book.keys()];
  }

  getCandidate(key: string, address: string): EndpointCandidate | null {
    return (this.book.get(key) ?? []).find((entry) => entry.address === address) ?? null;
  }

  recordSuccess(key: string, address: string): void {
    const candidate = this.getCandidate(key, address);
    if (!candidate) return;
    candidate.lastSuccessAt = this.now();
    delete candidate.lastError;
    this.schedulePersist();
  }

  recordFailure(key: string, address: string, error?: unknown): void {
    const candidate = this.getCandidate(key, address);
    if (!candidate) return;
    candidate.lastFailureAt = this.now();
    candidate.lastError = error instanceof Error ? error.message : error === undefined ? 'dial failed' : String(error);
    this.schedulePersist();
  }

  /** 成败统计合并落盘（去抖 ~50ms；不拖住宿主进程退出）。 */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist().catch(() => undefined);
    }, 50);
    this.persistTimer.unref?.();
  }

  /** 当前生效路径（null = 未连/未知）。 */
  getPath(key: string): PathState | null {
    const path = this.paths.get(key);
    return path ? { ...path } : null;
  }

  /** 记录生效路径；变化时发 `path-changed`（{ key, path, previous }）。 */
  setPath(key: string, address: string, error?: unknown): boolean {
    const previous = this.paths.get(key) ?? null;
    if (previous && previous.address === address) {
      if (error !== undefined) previous.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
    const path: PathState = {
      kind: classifyEndpoint(address),
      address,
      since: this.now(),
      ...(error !== undefined ? { lastError: error instanceof Error ? error.message : String(error) } : {}),
    };
    this.paths.set(key, path);
    this.emit('path-changed', { key, path: { ...path }, previous });
    return true;
  }

  clearPath(key: string, error?: unknown): void {
    const previous = this.paths.get(key);
    if (!previous) return;
    this.paths.delete(key);
    this.emit('path-changed', {
      key,
      path: null,
      previous: { ...previous, ...(error !== undefined ? { lastError: error instanceof Error ? error.message : String(error) } : {}) },
    });
  }

  /** 测试/诊断用：内存簿快照。 */
  snapshot(): Record<string, EndpointCandidate[]> {
    return deepCopyBook(Object.fromEntries(this.book.entries()));
  }
}

function sourceRank(source: EndpointSource): number {
  return source === 'config' ? 2 : source === 'paired' ? 1 : 0;
}

function compareCandidates(a: EndpointCandidate, b: EndpointCandidate): number {
  const kindDiff = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
  if (kindDiff !== 0) return kindDiff;
  const successDiff = (b.lastSuccessAt ?? 0) - (a.lastSuccessAt ?? 0);
  if (successDiff !== 0) return successDiff;
  return b.addedAt - a.addedAt;
}
