// P1 自动发布器：worker/daemon 启动、配置变更、agent 注册变化时重发能力卡。
//
// 失败不阻塞 worker 主循环：`publish()` 捕获错误写入 `lastError` 并调用 log；
// `tick()` 只在配置 mtime 变化时重载并发布。调用方只需在轮询循环里 `await tick()`。

import { stat } from 'node:fs/promises';
import type { Mebular } from '@mebular/core';
import { fleetConfigPath, loadFleetConfig, type FleetConfig } from '../config.js';
import type { ExecutorRegistry } from './agent.js';
import { publishFleetCards, type FleetCardsPublishResult } from '../cards.js';

export interface CapabilityCardPublisherOptions {
  mebular: Pick<Mebular, 'graph' | 'identity'>;
  config: FleetConfig;
  registry?: ExecutorRegistry;
  /** 卡片 namespace（默认 `agents`；配置变更重载时仍使用该值）。 */
  namespace?: string;
  configPath?: string;
  log?: (message: string) => void;
  now?: () => number;
  /** 配置检查最小间隔（默认 1000ms；测试可设 0）。 */
  checkIntervalMs?: number;
}

export interface CapabilityCardPublisherStatus {
  lastError: string | null;
  lastPublishedAt: number | null;
  lastConfigMtimeMs: number | null;
  publishing: boolean;
}

export class CapabilityCardPublisher {
  private config: FleetConfig;
  private readonly configPath: string;
  private readonly checkIntervalMs: number;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private inFlight: Promise<FleetCardsPublishResult | null> | null = null;
  private lastError: string | null = null;
  private lastPublishedAt: number | null = null;
  private lastConfigMtimeMs: number | null = null;
  private lastCheckAt = 0;

  constructor(private readonly options: CapabilityCardPublisherOptions) {
    this.config = options.config;
    this.configPath = options.configPath ?? fleetConfigPath(options.config.dir);
    this.checkIntervalMs = options.checkIntervalMs ?? 1_000;
    this.log = options.log ?? ((message) => console.error(message));
    this.now = options.now ?? Date.now;
  }

  status(): CapabilityCardPublisherStatus {
    return {
      lastError: this.lastError,
      lastPublishedAt: this.lastPublishedAt,
      lastConfigMtimeMs: this.lastConfigMtimeMs,
      publishing: this.inFlight !== null,
    };
  }

  /** 立即发布；并发调用合并为同一轮。错误不抛出，写入 status/log。 */
  async publish(): Promise<FleetCardsPublishResult | null> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const result = await publishFleetCards({
          mebular: this.options.mebular,
          config: this.config,
          ...(this.options.registry !== undefined ? { registry: this.options.registry } : {}),
          ...(this.options.namespace !== undefined ? { namespace: this.options.namespace } : {}),
          now: this.now(),
        });
        if (result.errors.length > 0) {
          this.lastError = result.errors.join('; ');
          this.log(`[fleet:caps] publish failed: ${this.lastError}`);
        } else {
          this.lastError = null;
        }
        if (result.cards.published > 0 || result.directory?.published === true) {
          this.lastPublishedAt = this.now();
        }
        return result;
      } catch (error) {
        this.lastError = (error as Error).message;
        this.log(`[fleet:caps] publish failed: ${this.lastError}`);
        return null;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** 配置 mtime 变化时重载并发布；未变化则 no-op。 */
  async tick(): Promise<void> {
    const at = this.now();
    if (at - this.lastCheckAt < this.checkIntervalMs) return;
    this.lastCheckAt = at;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.configPath)).mtimeMs;
    } catch (error) {
      this.lastError = `config stat: ${(error as Error).message}`;
      return;
    }
    if (this.lastConfigMtimeMs === null) {
      this.lastConfigMtimeMs = mtimeMs;
      return;
    }
    if (mtimeMs === this.lastConfigMtimeMs) return;
    this.lastConfigMtimeMs = mtimeMs;
    try {
      this.config = await loadFleetConfig(this.configPath);
    } catch (error) {
      this.lastError = `config reload: ${(error as Error).message}`;
      this.log(`[fleet:caps] config reload failed: ${this.lastError}`);
      return;
    }
    await this.publish();
  }

  /** agent 注册变化：异步重发；失败只记录，不影响注册方。 */
  onRegistryChange(): void {
    void this.publish().catch((error) => {
      this.lastError = (error as Error).message;
      this.log(`[fleet:caps] publish failed: ${this.lastError}`);
    });
  }

  /** 当前配置快照（测试/运维只读）。 */
  currentConfig(): FleetConfig {
    return this.config;
  }
}
