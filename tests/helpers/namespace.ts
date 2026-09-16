// 测试用 namespace 授权策略（默认拒绝姿态下的显式授权）。
//
// 生产代码默认拒绝：未显式授权的对端拿不到任何分区。测试若只关心同步本身
// 而非授权边界，用这些助手显式授权，避免每个夹具都写一遍匿名实现。

import { DEFAULT_NAMESPACE } from '../../src/core/namespace.js';
import type { NamespaceGrantPolicy } from '../../src/sync/namespacePolicy.js';

/** 给任何对端授予给定分区；缺省授予 default */
export function grant(...namespaces: string[]): NamespaceGrantPolicy {
  const list = namespaces.length > 0 ? namespaces : [DEFAULT_NAMESPACE];
  return { getAuthorizedNamespaces: async () => [...list] };
}

/** 显式不授予任何分区（默认拒绝的最小表达） */
export function denyAll(): NamespaceGrantPolicy {
  return { getAuthorizedNamespaces: async () => [] };
}

/** 按对端设备 ID 授予不同分区（与 ConfigNamespacePolicy 语义一致，便于夹具内联） */
export function grantByPeer(mapping: Record<string, string[]>): NamespaceGrantPolicy {
  return { getAuthorizedNamespaces: async (peerDeviceId: string) => [...(mapping[peerDeviceId] ?? [])] };
}
