// EventLog 测试（phase-3-plan 3.1）
//
// 核心承诺：
// - 本地事件带内容寻址 ID（sha256:…）与 Ed25519 签名，可被公钥验证；
// - 内容寻址幂等：同内容同 ID，篡改内容或伪造签名一律被拒；
// - appendRemote 按 ID 去重并合并向量时钟；
// - missingEvents 按作者高水位计算对端缺失集，按因果序返回。

import { describe, it, expect } from '@jest/globals';
import {
  EventLog,
  computeEventId,
  canonicalEventData,
  type EventSigner,
} from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import type { Event } from '../../src/types/event.js';

async function createSigner(deviceId: string): Promise<{ signer: EventSigner; publicKey: Uint8Array }> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return { signer: { deviceId, privateKey: keyPair.privateKey }, publicKey };
}

describe('EventLog（签名与内容寻址）', () => {
  it('append 产出 sha256 内容寻址 ID 与可验证签名', async () => {
    const { signer, publicKey } = await createSigner('device-A');
    const log = new EventLog(new MemoryStorage(), 'device-A', { signer });

    const event = await log.append({ type: 'node_created', data: { nodeId: 'n1' } });

    expect(event.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(event.author).toBe('device-A');
    expect(event.signature).not.toBe('');
    expect(event.vectorClock['device-A']).toBe(1);
    await expect(EventLog.verifyEvent(event, publicKey)).resolves.toBe(true);
  });

  it('事件 ID 由内容决定：同内容同 ID，异内容异 ID', async () => {
    const unsigned = {
      type: 'node_created',
      data: { nodeId: 'n1' },
      timestamp: 1234,
      vectorClock: { 'device-A': 1 },
      author: 'device-A',
    };
    const id1 = await computeEventId(unsigned);
    const id2 = await computeEventId({ ...unsigned });
    const id3 = await computeEventId({ ...unsigned, data: { nodeId: 'n2' } });

    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    // 规范化序列化与键序无关
    const reordered = canonicalEventData({
      type: unsigned.type,
      data: unsigned.data,
      timestamp: unsigned.timestamp,
      vectorClock: unsigned.vectorClock,
      author: unsigned.author,
    });
    expect(reordered).toBe(canonicalEventData(unsigned));
  });

  it('篡改内容、错误公钥、缺签名一律验签失败', async () => {
    const { signer, publicKey } = await createSigner('device-A');
    const other = await createSigner('device-B');
    const log = new EventLog(new MemoryStorage(), 'device-A', { signer });
    const event = await log.append({ type: 'node_created', data: { nodeId: 'n1' } });

    // 篡改内容（ID 不再绑定内容）
    const tampered: Event = { ...event, data: { nodeId: 'evil' } };
    await expect(EventLog.verifyEvent(tampered, publicKey)).resolves.toBe(false);

    // 错误公钥
    await expect(EventLog.verifyEvent(event, other.publicKey)).resolves.toBe(false);

    // 缺签名
    const unsignedEvent: Event = { ...event, signature: '' };
    await expect(EventLog.verifyEvent(unsignedEvent, publicKey)).resolves.toBe(false);
  });

  it('未配置签名者时事件不带签名，验签失败', async () => {
    const log = new EventLog(new MemoryStorage(), 'device-A');
    const { publicKey } = await createSigner('device-A');
    const event = await log.append({ type: 'node_created', data: {} });
    expect(event.signature).toBe('');
    await expect(EventLog.verifyEvent(event, publicKey)).resolves.toBe(false);
  });

  it('appendRemote 按 ID 去重并合并向量时钟', async () => {
    const remote = await createSigner('device-B');
    const remoteLog = new EventLog(new MemoryStorage(), 'device-B', { signer: remote.signer });
    const event = await remoteLog.append({ type: 'node_created', data: { nodeId: 'n1' } });

    const local = new EventLog(new MemoryStorage(), 'device-A');
    expect(await local.appendRemote(event)).toBe('applied');
    expect(await local.appendRemote(event)).toBe('duplicate');
    expect(await local.listEvents()).toHaveLength(1);
    expect(local.getClock().toJSON()).toEqual({ 'device-B': 1 });
  });

  it('missingEvents 按作者高水位过滤并按因果序返回', async () => {
    const { signer } = await createSigner('device-A');
    const log = new EventLog(new MemoryStorage(), 'device-A', { signer });
    const e1 = await log.append({ type: 'node_created', data: { nodeId: 'n1' } });
    const e2 = await log.append({ type: 'node_created', data: { nodeId: 'n2' } });
    const e3 = await log.append({ type: 'node_created', data: { nodeId: 'n3' } });

    // 对端已有 device-A 的第 1 条 → 缺 2、3，按计数器升序
    const missing = await log.missingEvents({ 'device-A': 1 });
    expect(missing.map((e) => e.id)).toEqual([e2.id, e3.id]);

    // 对端时钟为空 → 全缺
    expect(await log.missingEvents({})).toHaveLength(3);

    // 对端已覆盖 → 无缺失
    expect(await log.missingEvents({ 'device-A': 3 })).toHaveLength(0);
    void e1;
  });

  it('restore 从既有事件重建时钟，重启后计数器不回退', async () => {
    const storage = new MemoryStorage();
    const { signer } = await createSigner('device-A');
    const first = new EventLog(storage, 'device-A', { signer });
    await first.append({ type: 'node_created', data: { nodeId: 'n1' } });
    await first.append({ type: 'node_created', data: { nodeId: 'n2' } });

    const restored = await EventLog.restore(storage, 'device-A', { signer });
    expect(restored.getClock().toJSON()).toEqual({ 'device-A': 2 });
    const next = await restored.append({ type: 'node_created', data: { nodeId: 'n3' } });
    expect(next.vectorClock['device-A']).toBe(3);
  });

  it('兼容旧三参签名：第三个参数直接作初始时钟', async () => {
    const log = new EventLog(new MemoryStorage(), 'device-A', { 'device-A': 5 });
    expect(log.getClock().toJSON()).toEqual({ 'device-A': 5 });
    const event = await log.append({ type: 'node_created', data: {} });
    expect(event.vectorClock['device-A']).toBe(6);
  });
});
