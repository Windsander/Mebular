// P5 角色卡本地 runtime job：任务完成后低频 tick，规则聚合任务历史 → 发布 internal 角色卡。
//
// 边界：
// - 只读本机任务事件与可选 internal 摘要（`RoleSummaryProvider`）；不读原始对话。
// - 默认 shadow=true；生成/发布不改变派发行为。
// - 没有摘要时仅使用任务历史，不阻塞；任何生成/发布错误只记录，不打断 worker/node 主循环。
import type { TaskEventStore } from '../store/file-store.js';
import {
  ROLE_CARD_DEFAULT_MIN_INTERVAL_MS,
  ROLE_CARD_DEFAULT_REFRESH_TASKS,
  ROLE_CARD_DEFAULT_WINDOW,
  ROLE_CARD_GENERATOR,
  collectRoleTaskSamples,
  publishRoleCards,
  type RoleCardPublishResult,
  type RoleCardStore,
  type RoleSummary,
  type RoleSummaryProvider,
} from '../role-cards.js';

export interface RoleCardJobOptions {
  device: string;
  /** 本机配置的 agent 名（不含 plan sentinel）；角色卡只为这些 agent 生成。 */
  agents: readonly string[];
  events: Pick<TaskEventStore, 'all'>;
  store: Pick<RoleCardStore, 'list' | 'append'>;
  /** 可选内部摘要 seam；缺省/失败时仅用任务历史。 */
  summaries?: RoleSummaryProvider;
  /** 最近性窗口/每 Agent 样本上限（默认 50）。 */
  window?: number;
  /** 完成 N 个本机任务后再生成（默认 5）。 */
  refreshEveryTasks?: number;
  /** 两次生成之间的最小间隔（默认 60s；测试可设 0）。 */
  minIntervalMs?: number;
  /** 角色卡是否仍处于 shadow（默认 true）。 */
  shadow?: boolean;
  generator?: string;
  now?: () => number;
  log?: (message: string) => void;
}

export interface RoleCardJobStatus {
  lastRunAt: number | null;
  lastTaskCount: number;
  lastPublishedAt: number | null;
  lastError: string | null;
  running: boolean;
}

/** 本机 runtime job；调用方在 worker/node tick 中 `await job.tick()` 即可。 */
export class RoleCardJob {
  private readonly device: string;
  private readonly agents: readonly string[];
  private readonly events: Pick<TaskEventStore, 'all'>;
  private readonly store: Pick<RoleCardStore, 'list' | 'append'>;
  private readonly summaries: RoleSummaryProvider | undefined;
  private readonly window: number;
  private readonly refreshEveryTasks: number;
  private readonly minIntervalMs: number;
  private readonly shadow: boolean;
  private readonly generator: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private lastRunAt: number | null = null;
  private lastCheckAt: number | null = null;
  private lastTaskCount = 0;
  private lastPublishedAt: number | null = null;
  private lastError: string | null = null;
  private inFlight: Promise<RoleCardPublishResult | null> | null = null;

  constructor(options: RoleCardJobOptions) {
    this.device = options.device;
    this.agents = [...new Set(options.agents.filter((agent) => agent.length > 0))].sort();
    this.events = options.events;
    this.store = options.store;
    this.summaries = options.summaries;
    this.window = Math.max(1, Math.trunc(options.window ?? ROLE_CARD_DEFAULT_WINDOW));
    this.refreshEveryTasks = Math.max(1, Math.trunc(options.refreshEveryTasks ?? ROLE_CARD_DEFAULT_REFRESH_TASKS));
    this.minIntervalMs = Math.max(0, Math.trunc(options.minIntervalMs ?? ROLE_CARD_DEFAULT_MIN_INTERVAL_MS));
    this.shadow = options.shadow ?? true;
    this.generator = options.generator ?? ROLE_CARD_GENERATOR;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.error(message));
  }

  status(): RoleCardJobStatus {
    return {
      lastRunAt: this.lastRunAt,
      lastTaskCount: this.lastTaskCount,
      lastPublishedAt: this.lastPublishedAt,
      lastError: this.lastError,
      running: this.inFlight !== null,
    };
  }

  /**
   * 低频 tick：满足“本机终态任务数增量 >= refreshEveryTasks + 最小间隔”才生成；
   * `force=true` 跳过阈值（测试/运维内部使用，不新增 UI/方法）。
   */
  async tick(options: { force?: boolean } = {}): Promise<RoleCardPublishResult | null> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = (async (): Promise<RoleCardPublishResult | null> => {
      const now = this.now();
      try {
        if (options.force !== true
          && this.lastCheckAt !== null
          && now - this.lastCheckAt < this.minIntervalMs) {
          return null;
        }
        this.lastCheckAt = now;
        const events = await this.events.all();
        const samples = collectRoleTaskSamples(events)
          .filter((sample) => sample.device === this.device && this.agents.includes(sample.agent));
        const taskCount = samples.length;
        if (options.force !== true && taskCount - this.lastTaskCount < this.refreshEveryTasks) return null;
        let summaries: readonly RoleSummary[] = [];
        if (this.summaries !== undefined) {
          try {
            summaries = await this.summaries.listSummaries({ device: this.device, agents: this.agents });
          } catch (error) {
            this.lastError = `summary provider: ${(error as Error).message}`;
            this.log(`[fleet:roles] summary provider failed: ${(error as Error).message}`);
            summaries = [];
          }
        }
        const result = await publishRoleCards({
          store: this.store,
          device: this.device,
          agents: this.agents,
          events,
          ...(summaries.length > 0 ? { summaries } : {}),
          now,
          window: this.window,
          shadow: this.shadow,
          generator: this.generator,
        });
        this.lastRunAt = now;
        this.lastTaskCount = taskCount;
        if (result.errors.length > 0) {
          this.lastError = result.errors.join('; ');
          this.log(`[fleet:roles] publish failed: ${this.lastError}`);
        } else {
          this.lastError = null;
        }
        if (result.published > 0 || result.tombstoned > 0) this.lastPublishedAt = now;
        return result;
      } catch (error) {
        this.lastRunAt = now;
        this.lastError = (error as Error).message;
        this.log(`[fleet:roles] tick failed: ${this.lastError}`);
        return null;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
