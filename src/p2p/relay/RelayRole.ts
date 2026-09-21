// C6 · 中继内部化：**守护内建 relay 角色**（不再有 `mebular relay` 命令）。
//
// 决策（锁定）：
//  - 传输/建联全自动：使用者只做「配对 + 授权」；桥的选举由本模块的判定 + 广播（C5）自动完成。
//  - 不设外部/公共种子 relay（默认空）；把「可达设备自动当桥」做扎实。
//  - 仅对本机**已配对/已授权**（地址簿 paired/config，含 deviceId↔peerId 别名）的对端提供中转；
//    默认限额（applyDefaultLimit + maxReservations，见 RelayPolicy）。
//  - relay 角色**不落任何记忆/授权状态**（纯传输角色，无图事件、无策略写入）。

import { classifyEndpoint, extractEndpointHost } from '../connection/EndpointBook.js';

export type RelayServiceMode = 'auto' | 'off' | 'on';

export interface RelayRoleInput {
  /** 策略档：auto = 有对外可达证据才提供；on = 强制提供；off = 不提供 */
  mode?: RelayServiceMode;
  /** 本机当前监听地址（multiaddr；含 /p2p/<id> 后缀亦可） */
  listenAddrs?: string[];
  /** 是否观察到入站**直连**证据（非 circuit：说明外部确实能连到本机） */
  inboundDirectEvidence?: boolean;
}

export interface RelayRoleDecision {
  serve: boolean;
  /** 人类可读原因（控制台/doctor 展示） */
  reason: string;
  /** 参与判定的对外可达地址 */
  publicAddrs: string[];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '']);

/** 是否回环地址（multiaddr 或裸 host 都可） */
export function isLoopbackEndpoint(address: string): boolean {
  const host = extractEndpointHost(address) ?? '';
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

/**
 * 是否「对外可达」地址：既非回环、也非私网/link-local（即 classifyEndpoint 判为 direct 的公网地址）。
 * 说明：私网地址（192.168/10/172.16-31）不算对外可达——它只说明同网段可连，不代表可当跨网桥。
 */
export function isPubliclyReachable(address: string): boolean {
  if (isLoopbackEndpoint(address)) return false;
  return classifyEndpoint(address) === 'direct';
}

/**
 * 中继角色判定（纯函数，无副作用）：
 *  - off → 永不提供；
 *  - on  → 始终提供（内部/测试开关）；
 *  - auto（默认）→ 仅当「存在对外可达监听地址」**或**「观察到入站直连证据」才提供，否则静默不提供。
 */
export function decideRelayRole(input: RelayRoleInput = {}): RelayRoleDecision {
  const mode: RelayServiceMode = input.mode ?? 'auto';
  const listenAddrs = (input.listenAddrs ?? []).filter((addr) => typeof addr === 'string' && addr.length > 0);
  const publicAddrs = listenAddrs.filter((addr) => isPubliclyReachable(addr));

  if (mode === 'off') {
    return { serve: false, reason: 'relayService=off（显式关闭）', publicAddrs };
  }
  if (mode === 'on') {
    return { serve: true, reason: 'relayService=on（内部/测试开关强制开启）', publicAddrs };
  }
  if (publicAddrs.length > 0) {
    return { serve: true, reason: `检测到对外可达监听地址（${publicAddrs.join(', ')}）`, publicAddrs };
  }
  if (input.inboundDirectEvidence === true) {
    return { serve: true, reason: '观察到入站直连证据（外部可连到本机）', publicAddrs };
  }
  return {
    serve: false,
    reason: '未检测到对外可达地址，也无入站直连证据（不对外提供中转）',
    publicAddrs,
  };
}
