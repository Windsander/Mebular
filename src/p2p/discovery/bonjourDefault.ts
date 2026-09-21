// C3 · 默认 mDNS（bonjour）factory：把已声明依赖 `bonjour` 真正接起来。
//
// 设计：同步加载（bonjour 是 CJS，经 createRequire）+ **失败软降级**：
// 缺包/导出不符/初始化抛错 → 返回 null 并告警，绝不 panic；DeviceDiscovery 侧随后按
// 「无服务」处理（发现功能禁用，其他连接方式不受影响）。测试可注入替代 loader。

import { createRequire } from 'node:module';
import type { BonjourServiceFactory, BonjourServiceInstance } from '../DeviceDiscovery.js';

interface BonjourLike {
  publish(options: { name: string; type: string; port: number; txt?: Record<string, string> }): void;
  find(query: { type: string }, callback: (service: unknown) => void): { stop: () => void };
  destroy(): void;
}

type BonjourFactoryLike = (options?: Record<string, unknown>) => BonjourLike;

export interface DefaultBonjourFactoryOptions {
  /** 同步加载 bonjour 模块（测试注入；缺省 createRequire(import.meta.url)('bonjour')） */
  loadModule?: () => unknown;
  onWarn?: (message: string) => void;
  /** 传给 bonjour() 的选项 */
  serviceOptions?: Record<string, unknown>;
}

function adapter(instance: BonjourLike, onWarn: (message: string) => void): BonjourServiceInstance {
  return {
    publish: (options: Parameters<BonjourLike['publish']>[0]) => {
      // 真 bonjour 要求端口 > 0（否则抛 Required port not given）。端口未知（如 provider 未暴露
      // 监听地址）时用占位端口保证发布不炸；可拨地址由 TXT addrs 携带。
      if (!(options.port > 0)) {
        onWarn('mDNS：本机端口未知，使用占位端口发布（可拨地址以 TXT addrs 为准）');
        options = { ...options, port: 9 };
      }
      instance.publish(options);
    },
    find: (
      query: Parameters<BonjourLike['find']>[0],
      callback: (service: never) => void,
    ) => instance.find(query, (service: unknown) => callback(service as never)),
    destroy: () => instance.destroy(),
  } as unknown as BonjourServiceInstance;
}

/**
 * 构造默认 bonjour factory。任何失败 → null + onWarn（调用方据此显示「发现已禁用」）。
 */
export function createDefaultBonjourFactory(options: DefaultBonjourFactoryOptions = {}): BonjourServiceFactory {
  const warn = options.onWarn ?? (() => undefined);
  // 解析锚点：优先入口脚本（CLI/测试进程），否则 cwd —— 避免 import.meta（CJS 构建下不可用）
  const anchor = process.argv[1] && process.argv[1].length > 0 ? process.argv[1] : `${process.cwd()}/index.js`;
  const load = options.loadModule ?? (() => createRequire(anchor)('bonjour'));
  return () => {
    try {
      const mod = load() as { default?: BonjourFactoryLike } | BonjourFactoryLike | undefined;
      const factory = typeof mod === 'function' ? mod : mod?.default;
      if (typeof factory !== 'function') {
        warn('mDNS：bonjour 导出非函数，设备发现禁用（其他连接方式不受影响）');
        return null;
      }
      return adapter(factory(options.serviceOptions ?? {}), warn);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warn(`mDNS：bonjour 不可用（${reason}），设备发现禁用（其他连接方式不受影响）`);
      return null;
    }
  };
}
