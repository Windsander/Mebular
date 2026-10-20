// 订阅策略接口（greenfield）。
//
// 「谁能读什么」只由订阅决定：每台设备自己声明参与哪些记忆域。本接口是
// 供给端/入站端读取订阅与移出状态的唯一接缝——没有「对端授权」白名单，
// 也没有按对端 × 按域的配置策略。
//
// 唯一否定是移出（`device_revoke` 事件，作者级）；`getBlockedDevices` 只回答
// 「谁当前被移出」，不沿证书链传播。

import type { SecurityPolicyState } from './grantPolicy.js';

export interface NamespaceSubscriptionPolicy {
  /**
   * 某分区的订阅视图：
   * - `active=false` = 图上还没有任何被采纳的订阅记录（回退 hello 会话声明）；
   * - `active=true` = 订阅记录是权威（`subscribers` 之外的对端不发）。
   */
  getNamespaceSubscriptions(namespace: string): Promise<{ active: boolean; subscribers: string[]; recorded?: string[] }>;

  /** 某设备作为 member 的 active 订阅域（只读审计/派发判定）。 */
  getSubscriptions?(deviceId: string): Promise<string[]>;

  /** 当前处于移出状态的设备集合。 */
  getBlockedDevices?(): Promise<ReadonlySet<string>>;

  /** 域公告（目录可见；不含本地节点）。 */
  getDeclaredNamespaces?(): Promise<string[]>;

  /** 网络级安全档（只读）。 */
  getSecurityTier?(): Promise<SecurityPolicyState>;
}

/** 未配置策略时的空实现：没有订阅记录、没有移出。 */
export class EmptySubscriptionPolicy implements NamespaceSubscriptionPolicy {
  async getNamespaceSubscriptions(): Promise<{ active: boolean; subscribers: string[] }> {
    return { active: false, subscribers: [] };
  }

  async getSubscriptions(): Promise<string[]> {
    return [];
  }

  async getBlockedDevices(): Promise<ReadonlySet<string>> {
    return new Set<string>();
  }

  async getDeclaredNamespaces(): Promise<string[]> {
    return [];
  }
}
