// JsonFileStorage 持久化测试（phase-3-plan 3.0）
//
// 核心承诺：写操作追加为 JSONL，重开文件后状态完整恢复；
// compact 后文件收紧且状态不变；事件写入幂等。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonFileStorage } from '../../src/storage/JsonFileStorage.js';
import type { Node, Edge, Event } from '../../src/types/index.js';

function makeNode(id: string, updatedAt = 1000): Node {
  return {
    id,
    type: 'fact',
    content: { text: `node-${id}` },
    labels: [],
    createdBy: 'device-A',
    signature: '',
    createdAt: updatedAt,
    updatedAt,
    validFrom: updatedAt,
    validTo: 9999999999999,
    tags: [],
  };
}

function makeEdge(id: string, source: string, target: string): Edge {
  return {
    id,
    type: 'edge',
    source,
    target,
    relation: 'related',
    createdBy: 'device-A',
    signature: '',
    createdAt: 1000,
    updatedAt: 1000,
    labels: [],
  };
}

function makeEvent(id: string, author = 'device-A'): Event {
  return {
    id,
    type: 'node_created',
    timestamp: 1000,
    vectorClock: { [author]: 1 },
    data: { nodeId: id },
    author,
    signature: '',
  };
}

describe('JsonFileStorage', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-json-'));
    file = join(dir, 'store.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('写入后重放完整恢复节点/边/事件', async () => {
    const first = await JsonFileStorage.open(file);
    await first.putNode(makeNode('n1'));
    await first.putNode(makeNode('n2', 2000));
    await first.putEdge(makeEdge('e1', 'n1', 'n2'));
    await first.putEvent(makeEvent('ev1'));
    await first.close();

    const reopened = await JsonFileStorage.open(file);
    expect((await reopened.getNode('n1'))?.content).toEqual({ text: 'node-n1' });
    expect((await reopened.getNode('n2'))?.updatedAt).toBe(2000);
    expect((await reopened.getEdge('e1'))?.relation).toBe('related');
    expect((await reopened.getEvent('ev1'))?.type).toBe('node_created');
    expect(await reopened.listEvents()).toHaveLength(1);
    await reopened.close();
  });

  it('同 ID 事件重复写入幂等（重放后仅一条）', async () => {
    const storage = await JsonFileStorage.open(file);
    await storage.putEvent(makeEvent('ev1'));
    await storage.putEvent(makeEvent('ev1'));
    await storage.close();

    const reopened = await JsonFileStorage.open(file);
    expect(await reopened.listEvents()).toHaveLength(1);
    await reopened.close();
  });

  it('覆盖写重放后保留最新版本', async () => {
    const first = await JsonFileStorage.open(file);
    await first.putNode(makeNode('n1', 1000));
    await first.putNode(makeNode('n1', 5000));
    await first.close();

    const reopened = await JsonFileStorage.open(file);
    expect((await reopened.getNode('n1'))?.updatedAt).toBe(5000);
    await reopened.close();
  });

  it('compact 收紧日志且状态不变', async () => {
    const storage = await JsonFileStorage.open(file);
    await storage.putNode(makeNode('n1', 1000));
    await storage.putNode(makeNode('n1', 2000));
    await storage.putNode(makeNode('n2'));
    await storage.putEvent(makeEvent('ev1'));
    await storage.compact();

    const lines = (await readFile(file, 'utf-8')).trim().split('\n');
    // 2 个节点 + 1 个事件，覆盖写被压掉
    expect(lines).toHaveLength(3);

    const reopened = await JsonFileStorage.open(file);
    expect((await reopened.getNode('n1'))?.updatedAt).toBe(2000);
    expect(await reopened.listNodes()).toHaveLength(2);
    expect(await reopened.listEvents()).toHaveLength(1);
    await reopened.close();
  });

  it('close 后拒绝写入', async () => {
    const storage = await JsonFileStorage.open(file);
    await storage.close();
    await expect(storage.putNode(makeNode('n1'))).rejects.toThrow('closed');
  });

  it('末尾撕裂行（崩溃半行写）被容忍，前文完整恢复', async () => {
    const first = await JsonFileStorage.open(file);
    await first.putNode(makeNode('n1'));
    await first.putNode(makeNode('n2'));
    await first.close();

    // 模拟崩溃时的半行写：文件尾部追加一段不完整的 JSON
    await appendFile(file, '{"op":"putNode","value":{"id":"n3","typ', 'utf-8');

    const reopened = await JsonFileStorage.open(file);
    expect((await reopened.getNode('n1'))?.content).toEqual({ text: 'node-n1' });
    expect(await reopened.getNode('n2')).not.toBeNull();
    expect(await reopened.getNode('n3')).toBeNull();
    await reopened.close();
  });

  it('中间行损坏（非末尾）诚实报错，不静默截断', async () => {
    const first = await JsonFileStorage.open(file);
    await first.putNode(makeNode('n1'));
    await first.putNode(makeNode('n2'));
    await first.close();

    // 把第一行弄坏（保留第二行完好）：中间行损坏不可安全恢复
    const content = await readFile(file, 'utf-8');
    const lines = content.split('\n');
    lines[0] = '{"op":"putNode","value":###}';
    await rm(file);
    await writeFile(file, lines.join('\n'), 'utf-8');

    await expect(JsonFileStorage.open(file)).rejects.toThrow('第 1 行损坏');
  });
});
