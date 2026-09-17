// Fleet M2 基建单测：SpoolTransport / FileTaskEventStore / ExecutionLog / executeOnce。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SpoolTransport,
  FileTaskEventStore,
  ExecutionLog,
  executeOnce,
  reduceTaskEvents,
  type TaskExecutor,
} from '../../packages/fleet/src/index.js';
import { mkEvent, endpoint } from './helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-infra-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('SpoolTransport', () => {
  it('publish 后被 drain 消费一次（移入 processed）', async () => {
    const t = new SpoolTransport(join(dir, 'spool'));
    const event = mkEvent('created', 't1', { to: endpoint('device-B', '*') });
    await t.publish({ msgId: 'm1', from: endpoint('device-A', 'board'), to: endpoint('device-B', '*'), event });
    const first = await t.drain(endpoint('device-B', 'echo'));
    expect(first).toHaveLength(1);
    expect(first[0]!.msgId).toBe('m1');
    expect(await t.drain(endpoint('device-B', 'echo'))).toEqual([]); // 不重复消费
    await t.close();
  });

  it('收件箱为空 → []', async () => {
    const t = new SpoolTransport(join(dir, 'spool'));
    expect(await t.drain(endpoint('device-Z', 'x'))).toEqual([]);
    await t.close();
  });

  it('损坏 JSON 被移走（不返回、不反复失败）', async () => {
    const t = new SpoolTransport(join(dir, 'spool'));
    const inbox = join(dir, 'spool', 'device-B');
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, 'bad.json'), '{not json', 'utf-8');
    expect(await t.drain(endpoint('device-B', 'echo'))).toEqual([]);
    await t.close();
  });
});

describe('FileTaskEventStore', () => {
  it('按 eventId 幂等去重并可跨重启恢复', async () => {
    const path = join(dir, 'events.jsonl');
    const s1 = await FileTaskEventStore.open(path);
    const e = mkEvent('created', 't1', { eventId: 'e1', to: endpoint('device-B', '*') });
    expect(await s1.append(e)).toBe(true);
    expect(await s1.append(e)).toBe(false); // 重复
    await s1.close();

    const s2 = await FileTaskEventStore.open(path);
    expect(await s2.all()).toHaveLength(1);
    await s2.close();
  });

  it('中间损坏行被跳过，其余保留', async () => {
    const path = join(dir, 'broken.jsonl');
    const good = JSON.stringify(mkEvent('created', 't1', { eventId: 'e1', to: endpoint('device-B', '*') }));
    const good2 = JSON.stringify(mkEvent('claimed', 't1', { eventId: 'e2' }));
    await writeFile(path, `${good}\n{bad\n${good2}\n`, 'utf-8');
    const s = await FileTaskEventStore.open(path);
    expect((await s.all()).map((x) => x.eventId)).toEqual(['e1', 'e2']);
    await s.close();
  });
});

describe('ExecutionLog 与 executeOnce', () => {
  class CountingExecutor implements TaskExecutor {
    count = 0;
    async execute() {
      this.count += 1;
      return { ok: true, resultRef: 'r' };
    }
  }

  it('按 taskId 至多执行一次（跨 log 恢复）', async () => {
    const path = join(dir, 'exec.jsonl');
    const log = await ExecutionLog.open(path);
    const task = reduceTaskEvents([mkEvent('created', 't1', { to: endpoint('device-B', '*') })])!;
    const exec = new CountingExecutor();
    expect((await executeOnce(task, exec, log)).resultRef).toBe('r');
    expect((await executeOnce(task, exec, log)).resultRef).toBe('r');
    expect(exec.count).toBe(1); // 第二次走 log，不再执行

    await log.close();
    const log2 = await ExecutionLog.open(path);
    expect(log2.has('t1')).toBe(true);
    expect(log2.resultOf('t1')).toBe('r');
    await log2.record('t1', 'ignored'); // 重复记录被忽略
    expect(log2.size()).toBe(1);
  });
});
