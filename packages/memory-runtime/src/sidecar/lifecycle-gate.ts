// Sidecar 生命周期门闩（WP2）。
//
// 目标（contract §4.2）：
// - 一旦开始禁用/停止，新的 ingest/staging/model/capability 写与 outbox 入队立即被拒绝；
// - 已经发出的 capability 写如果晚于门闩成功返回，视为含糊的成功：不得再当作新提交、
//   不得删除 pending outbox，并必须让本次禁用保持 incomplete；
// - capability 撤销/mode_mismatch 是准入信号，不是可重试的写失败，绝不因此新建 outbox。

import { SidecarSettlementError } from './errors.js';

export type LifecyclePhase = 'immersive' | 'draining' | 'dormant';

export class LifecycleGate {
  private phase: LifecyclePhase = 'immersive';
  private epoch = 0;
  private readonly ambiguityReasons = new Set<string>();

  get currentPhase(): LifecyclePhase {
    return this.phase;
  }

  get ambiguous(): boolean {
    return this.ambiguityReasons.size > 0;
  }

  get ambiguity(): string[] {
    return [...this.ambiguityReasons];
  }

  acceptsWork(): boolean {
    return this.phase === 'immersive';
  }

  generation(): number {
    return this.epoch;
  }

  /** 同步撤销准入；返回 false 表示已经处于 dormant。 */
  beginDrain(_reason: string): boolean {
    if (this.phase === 'dormant') return false;
    if (this.phase === 'immersive') {
      this.phase = 'draining';
      this.epoch += 1;
      this.ambiguityReasons.clear();
    }
    return true;
  }

  /** 有一笔已发请求在门闩之后才成功/结果不可判定；本次禁用不得报告 clean。 */
  noteAmbiguousSuccess(reason: string): void {
    if (this.phase === 'immersive') return;
    if (reason.length > 0) this.ambiguityReasons.add(reason);
  }

  finishDrain(): void {
    this.phase = 'dormant';
  }

  resume(): void {
    this.phase = 'immersive';
    this.epoch += 1;
    this.ambiguityReasons.clear();
  }

  /** 新工作入口：draining/dormant 时给出既有 409 mode_mismatch。 */
  assertAccepting(operation = 'work'): void {
    if (this.acceptsWork()) return;
    throw new SidecarSettlementError(
      'mode_mismatch',
      'Memory Runtime 已休眠：沉浸式能力未启用',
      { status: 409, retryable: false, details: { operation, phase: this.phase } },
    );
  }
}
