// P3 route provider：embedded（本地 Mebular）与 daemon（守护 app 只读面）共用同一 resolver。
//
// 边界（P0 契约 §5.3 / §7）：
// - `online` 来自 sync 已认证在线 peer；`inflight` 来自本地任务视图；最近成败/时延来自本机观察。
// - 状态视图不落盘、不同步；provider 只做读取，不写 plan/card/task。
// - daemon 模式无法取得远端设备公钥时，卡片读取只能信任本机；远端候选 fail-closed，
//   记录为 P6 双守护 E2E 风险（不伪造通过）。
// - 授权只看任务 namespace 的订阅声明；本机（plan owner/coordinator）始终在授权集合内。

import type { Mebular } from '@mebular/core';
import { AGENT_NAMESPACE } from '../agentdir.js';
import { listCapabilityCards, type AgentCapabilityCard } from '../cards.js';
import type { CapabilityCardBackend } from '../cards.js';
import type { FleetConfig } from '../config.js';
import { listAgentRoleCards, type AgentRoleCard } from '../role-cards.js';
import type { TaskEventStore } from '../store/file-store.js';
import {
  observeRouteOutcomes,
  type PlanRoutingProvider,
  type RouteAuthorization,
  type RouteObservation,
  type RouteRoleCardMode,
} from '../routing.js';

type EmbeddedRoutingMebular = Pick<Mebular, 'graph' | 'identity' | 'sync'> & {
  getSubscriptions(deviceId: string): Promise<string[]>;
  getPeerPath?(peerKey: string): unknown;
};

export interface EmbeddedRoutingProviderOptions {
  mebular: EmbeddedRoutingMebular;
  config: Pick<FleetConfig, 'device' | 'namespace' | 'peers' | 'roleCards'>;
  store: TaskEventStore;
  /** 本机观察窗口（最近 N 个终态任务）；默认 20。 */
  window?: number;
}

/**
 * embedded provider：读取本机 Mebular 的卡片目录、sync 在线 peer、任务视图与本机观察。
 * 卡片验证仍由 `listCapabilityCards` 完成（author 绑定 + 设备签名 + sync 公钥）。
 * 角色卡按 P5 默认 shadow；只有配置 `roleCards.enabled=true` 才切换到 enabled。
 */
export function embeddedRoutingProvider(options: EmbeddedRoutingProviderOptions): PlanRoutingProvider {
  const { mebular, config, store } = options;
  return {
    namespace: config.namespace,
    cards: async (): Promise<readonly AgentCapabilityCard[]> => listCapabilityCards(mebular, AGENT_NAMESPACE),
    roleCards: async (): Promise<readonly AgentRoleCard[]> => listAgentRoleCards(mebular, AGENT_NAMESPACE),
    roleCardMode: roleCardModeOf(config),
    authorized: async (): Promise<RouteAuthorization> => {
      const devices = new Set<string>([config.device]);
      for (const peer of config.peers) {
        if (peer.device === config.device) continue;
        try {
          const namespaces = await mebular.getSubscriptions(peer.device);
          if (namespaces.includes(config.namespace)) devices.add(peer.device);
        } catch {
          // 订阅未知/策略读取失败 → 不作为授权候选（fail-closed）。
        }
      }
      return { devices: [...devices].sort() };
    },
    online: (device: string): boolean => {
      if (device === config.device) return true;
      try {
        if (mebular.sync.getOnlinePeers().some((peer) => peer.deviceId === device)) return true;
      } catch {
        // 无 sync 实例时继续看 endpoint path。
      }
      try {
        const path = mebular.getPeerPath?.(device);
        return path !== null && path !== undefined;
      } catch {
        return false;
      }
    },
    observations: async (): Promise<readonly RouteObservation[]> =>
      observeRouteOutcomes(await store.all(), { window: options.window }),
  };
}

export interface DaemonRoutingProviderOptions {
  backend: Pick<CapabilityCardBackend, 'listCards'> & {
    /** 只读订阅查询（`/app/policy/subscriptions?device=`）。 */
    getSubscriptions(device: string): Promise<string[]>;
  };
  config: Pick<FleetConfig, 'device' | 'namespace' | 'peers' | 'roleCards'>;
  store: TaskEventStore;
  /** daemon 模式下没有 sync peer 视图；调用方可注入本机已知在线集合。 */
  online?: (device: string) => boolean;
  /** P6：守护内部 `/app/peers` 的已认证在线设备；与 local device 合并后参与软排序。 */
  onlineDevices?: () => Promise<readonly string[]>;
  /** P5：`/app/role-cards` 只读角色卡（author/schema 已过滤）。 */
  roleCards?: () => Promise<readonly AgentRoleCard[]>;
  /** P5：默认 shadow；显式 enabled 才允许软排序。 */
  roleCardMode?: RouteRoleCardMode;
  window?: number;
}

function roleCardModeOf(config: Pick<FleetConfig, 'roleCards'>): RouteRoleCardMode {
  return config.roleCards?.enabled === true ? 'enabled' : 'shadow';
}

/**
 * daemon provider：复用 P1 `DaemonAgentBackend` 的卡片读取/验证。
 * 没有远端公钥时 listCards 只返回本机卡；远端候选会因缺少可信能力卡被拒绝（fail-closed）。
 * **授权**：本机 + 对每个 config peer 查询其是否订阅任务 namespace；查询失败/未订阅 →
 * 该 peer 不进入授权集合（绝不回退 `config.peers` 地址簿）。真正的硬门槛仍是卡片验证。
 */
export function daemonRoutingProvider(options: DaemonRoutingProviderOptions): PlanRoutingProvider {
  const { backend, config, store } = options;
  return {
    namespace: config.namespace,
    cards: async (): Promise<readonly AgentCapabilityCard[]> => backend.listCards(),
    roleCards: async (): Promise<readonly AgentRoleCard[]> => options.roleCards?.() ?? [],
    roleCardMode: options.roleCardMode ?? roleCardModeOf(config),
    authorized: async (): Promise<RouteAuthorization> => {
      const devices = new Set<string>([config.device]);
      for (const peer of config.peers) {
        if (peer.device === config.device) continue;
        try {
          const namespaces = await backend.getSubscriptions(peer.device);
          if (namespaces.includes(config.namespace)) devices.add(peer.device);
        } catch {
          // 订阅未知/查询失败 → 不授权；不回退地址簿。
        }
      }
      return { devices: [...devices].sort() };
    },
    online: (device: string): boolean => device === config.device || (options.online?.(device) ?? false),
    ...(options.onlineDevices !== undefined
      ? {
          onlineDevices: async (): Promise<readonly string[]> => {
            const devices = new Set<string>([config.device]);
            try {
              for (const device of await options.onlineDevices!()) {
                if (typeof device === 'string' && device.length > 0) devices.add(device);
              }
            } catch {
              // /app/peers 读取失败：只保留本机在线，远端 fail-closed。
            }
            return [...devices].sort();
          },
        }
      : {}),
    observations: async (): Promise<readonly RouteObservation[]> =>
      observeRouteOutcomes(await store.all(), { window: options.window }),
  };
}
