// 故障注入传输（phase-5-plan 5.5，测试基建，非生产代码）
//
// 在连接抽象之上叠加可配置故障：延迟（含抖动）、丢包、网络分区。
// 随机源可注入（种子化），保证测试确定性。
//
// 语义说明（诚实边界）：
// - 单连接内不做乱序注入——Connection 抽象是有序字节报文（TCP 语义），
//   SecureChannel 的 (epoch, counter) 重放保护会合法拒绝乱序帧；
//   「重排」在真实部署中由并发连接/会话交错体现，抖动延迟已覆盖其时序面。
// - 丢包/分区表现为「帧丢失」：协议层无重传，会话会诚实失败；
//   调用方重试（新一轮会话）后应收敛——这正是要验证的可恢复性。

import type { Connection, ConnectionState, PeerId } from '../../src/p2p/P2PNetwork.js';
import { MessageQueue } from '../../src/p2p/transport/InMemoryTransport.js';

/** 确定性随机源（mulberry32），供故障策略注入 */
export function seededRng(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FaultPolicy {
  /** 每帧延迟（ms）；返回随机值即抖动 */
  latencyMs?: () => number;
  /** 每帧丢弃概率 0..1（静默丢失，模拟不可靠链路） */
  dropRate?: number;
  /** 动态分区谓词：true 时链路表现为断开（拨号不可达/在途帧丢失） */
  isPartitioned?: () => boolean;
  /** 随机源（缺省 Math.random；测试注入 seededRng） */
  rng?: () => number;
}

export const NO_FAULT: FaultPolicy = {};

class FaultyConnection implements Connection {
  readonly peerId: PeerId;
  readonly remoteAddress: string;
  private readonly inbox = new MessageQueue<Uint8Array>();
  private peerInbox: MessageQueue<Uint8Array> | null = null;
  private policy: FaultPolicy;
  private currentState: ConnectionState = 'connected';
  private onPeerClose: (() => void) | null = null;
  /** 投递串行化：延迟只拉开时序，不改变帧序（TCP 语义） */
  private deliveryChain: Promise<void> = Promise.resolve();

  constructor(localPeerId: PeerId, remotePeerId: PeerId, policy: FaultPolicy) {
    this.peerId = remotePeerId;
    this.remoteAddress = `faulty://${remotePeerId.id}`;
    this.policy = policy;
    void localPeerId;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  /** 与 InMemoryConnection.link 同语义：信箱互接 + 对端关闭联动 */
  link(peer: FaultyConnection): void {
    this.peerInbox = peer.inbox;
    this.onPeerClose = () => {
      if (this.currentState !== 'closed') {
        this.currentState = 'closed';
        this.inbox.close();
      }
    };
  }

  setPolicy(policy: FaultPolicy): void {
    this.policy = policy;
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.currentState === 'closed') {
      throw new Error('Connection closed');
    }
    if (!this.peerInbox) {
      throw new Error('Connection not linked');
    }
    const rng = this.policy.rng ?? Math.random;
    // 分区：在途帧静默丢失（真实分区的表现）
    if (this.policy.isPartitioned?.()) return;
    // 丢包
    if (this.policy.dropRate !== undefined && rng() < this.policy.dropRate) return;
    // 延迟投递：串行队列保证有序，延迟只影响时延（抖动语义）
    const latency = this.policy.latencyMs?.() ?? 0;
    const inbox = this.peerInbox;
    const payload = new Uint8Array(data);
    this.deliveryChain = this.deliveryChain.then(
      () => new Promise<void>((resolve) => {
        setTimeout(() => {
          inbox.push(payload);
          resolve();
        }, latency);
      }),
    );
  }

  receive(): AsyncIterable<Uint8Array> {
    return this.inbox.iterate();
  }

  async close(): Promise<void> {
    if (this.currentState === 'closed') return;
    this.currentState = 'closed';
    this.inbox.close();
    const notify = this.onPeerClose;
    this.onPeerClose = null;
    if (notify) notify();
  }

  async authenticate(): Promise<boolean> {
    return true;
  }

  isAuthenticated(): boolean {
    return true;
  }
}

/** 造一对带故障注入的互联连接（策略双侧对称生效） */
export function createFaultyLinkedPair(
  a: PeerId,
  b: PeerId,
  policy: FaultPolicy = NO_FAULT,
): [Connection, Connection, { setPolicy(p: FaultPolicy): void }] {
  const connA = new FaultyConnection(a, b, policy);
  const connB = new FaultyConnection(b, a, policy);
  connA.link(connB);
  connB.link(connA);
  return [
    connA,
    connB,
    {
      setPolicy(p: FaultPolicy) {
        connA.setPolicy(p);
        connB.setPolicy(p);
      },
    },
  ];
}
