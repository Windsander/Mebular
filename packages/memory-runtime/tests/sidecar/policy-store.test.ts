// PolicyStore：原子写/0600/0700、TTL、maxDomains、并发串行、阈值与 reset、损坏 fail-open。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicyStore } from '../../src/sidecar/policy-store.js';

const DAY = 24 * 60 * 60 * 1000;

describe('PolicyStore', () => {
  let dir: string;
  let now: number;
  let path: string;
  const stores: PolicyStore[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-policy-store-'));
    now = Date.UTC(2026, 0, 1, 12, 0, 0);
    path = join(dir, 'policy', 'state.json');
  });

  afterEach(async () => {
    await Promise.allSettled(stores.splice(0).map((policy) => policy.close()));
    await rm(dir, { recursive: true, force: true });
  });

  const store = (options: { ttlDays?: number; maxDomains?: number } = {}) => {
    const policy = new PolicyStore({
      path,
      now: () => now,
      ...options,
    });
    stores.push(policy);
    return policy;
  };

  it('首次写入创建 0700 目录与 0600 文件，并持久化计数', async () => {
    const policy = store();
    await policy.init();
    await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
    await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'silent' });
    await policy.recordOutcome({ agentId: 'opencode', domain: 'user', kind: 'accepted' });
    await policy.flush();

    const dirMode = (await stat(join(dir, 'policy'))).mode & 0o777;
    const fileMode = (await stat(path)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    const raw = JSON.parse(await readFile(path, 'utf8')) as any;
    expect(raw.global).toMatchObject({ spoken: 1, silent: 1, accepted: 1 });
    expect(Object.values(raw.domains).length).toBe(1);

    const reopened = store();
    await reopened.init();
    const snapshot = await reopened.snapshot();
    expect(snapshot.global).toMatchObject({ spoken: 1, silent: 1, accepted: 1 });
    expect(snapshot.domains[0]).toMatchObject({ agentId: 'opencode', domain: 'user' });
  });

  it('并发决策串行落盘，不丢计数', async () => {
    const policy = store();
    await policy.init();
    await Promise.all(Array.from({ length: 20 }, () => policy.recordDecision({
      agentId: 'opencode',
      domain: 'user',
      action: 'speak',
    })));
    await Promise.all(Array.from({ length: 5 }, () => policy.recordOutcome({
      agentId: 'opencode',
      domain: 'user',
      kind: 'reasked',
    })));
    const snapshot = await policy.snapshot();
    expect(snapshot.global.spoken).toBe(20);
    expect(snapshot.global.reasked).toBe(5);
  });

  it('write-behind：record 立即返回且不落盘，flush 后可见', async () => {
    const policy = store();
    await policy.init();
    await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
    const immediate = await stat(path).catch(() => null);
    expect(immediate).toBeNull();
    expect((await policy.snapshot()).global.spoken).toBe(1);

    await policy.flush();
    const persisted = JSON.parse(await readFile(path, 'utf8')) as any;
    expect(persisted.global.spoken).toBe(1);
  });

  it('写失败标记 degraded + lastError，下一次 flush 成功清除', async () => {
    const policy = store();
    await policy.init();
    // 把状态文件位置变成目录，让原子 rename 失败（确定性强于权限位）。
    await mkdir(path, { recursive: true });
    await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
    await expect(policy.flush()).rejects.toBeTruthy();
    expect(policy.isDegraded).toBe(true);
    expect(policy.lastError?.code).toBeTruthy();

    await rm(path, { recursive: true, force: true });
    await policy.flush();
    expect(policy.isDegraded).toBe(false);
    expect(policy.lastError).toBeNull();
    const persisted = JSON.parse(await readFile(path, 'utf8')) as any;
    expect(persisted.global.spoken).toBe(1);
  });

  it('effectiveStats：outcome 先验按 spoken/silent 分别归一', async () => {
    const policy = store();
    await policy.init();
    for (let index = 0; index < 10; index += 1) {
      await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
    }
    for (let index = 0; index < 10; index += 1) {
      await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'silent' });
    }
    for (let index = 0; index < 5; index += 1) {
      await policy.recordOutcome({ agentId: 'opencode', domain: 'user', kind: 'missed' });
    }
    for (let index = 0; index < 5; index += 1) {
      await policy.recordOutcome({ agentId: 'opencode', domain: 'user', kind: 'reasked' });
    }
    // 冷启动域只有 2 次 spoken，向全局先验收缩。
    await policy.recordDecision({ agentId: 'opencode', domain: 'agent:opencode', action: 'speak' });
    await policy.recordDecision({ agentId: 'opencode', domain: 'agent:opencode', action: 'speak' });

    const pooled = await policy.effectiveStats('opencode', 'agent:opencode');
    expect(pooled.source).toBe('global');
    // missed 先验按 global.silent 归一（5/10），useless 先验按 global.spoken 归一（5/10）。
    expect(pooled.missedRate).toBeGreaterThan(0.9);
    expect(pooled.uselessRate).toBeGreaterThan(0.55);
  });

  it('TTL 到期后丢弃域统计；全局计数保留', async () => {
    const policy = store({ ttlDays: 2 });
    await policy.init();
    await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
    await policy.flush();
    now += 3 * DAY;
    const reopened = store({ ttlDays: 2 });
    await reopened.init();
    const snapshot = await reopened.snapshot();
    expect(snapshot.domains).toEqual([]);
    expect(snapshot.global.spoken).toBe(1);
  });

  it('maxDomains 只保留最近更新的域', async () => {
    const policy = store({ maxDomains: 2 });
    await policy.init();
    for (const domain of ['user', 'agent:opencode', 'default']) {
      now += 1000;
      await policy.recordDecision({ agentId: 'opencode', domain, action: 'speak' });
    }
    const snapshot = await policy.snapshot();
    expect(snapshot.domains.map((entry) => entry.domain).sort()).toEqual(['agent:opencode', 'default']);
  });

  it('effectiveStats：样本 <20 向全局池化，>=20 使用本域', async () => {
    const policy = store();
    await policy.init();
    for (let index = 0; index < 10; index += 1) {
      await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
    }
    for (let index = 0; index < 5; index += 1) {
      await policy.recordOutcome({ agentId: 'opencode', domain: 'user', kind: 'dismissed' });
    }
    // 冷启动域：2 次决策，向全局收缩。
    await policy.recordDecision({ agentId: 'opencode', domain: 'agent:opencode', action: 'speak' });
    await policy.recordDecision({ agentId: 'opencode', domain: 'agent:opencode', action: 'speak' });
    const pooled = await policy.effectiveStats('opencode', 'agent:opencode');
    expect(pooled.source).toBe('global');
    expect(pooled.uselessRate).toBeGreaterThan(0);
    expect(pooled.domainSamples).toBe(2);

    for (let index = 0; index < 18; index += 1) {
      await policy.recordDecision({ agentId: 'opencode', domain: 'agent:opencode', action: 'speak' });
    }
    const own = await policy.effectiveStats('opencode', 'agent:opencode');
    expect(own.source).toBe('domain');
    expect(own.domainSamples).toBe(20);
    expect(own.uselessRate).toBe(0);
  });

  it('thresholdFor：样本足够后按 useless/missed 调整 ±0.03 并 clamp', async () => {
    const policy = store();
    await policy.init();
    for (let index = 0; index < 20; index += 1) {
      await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
    }
    for (let index = 0; index < 10; index += 1) {
      await policy.recordOutcome({ agentId: 'opencode', domain: 'user', kind: 'reasked' });
    }
    now += 8 * DAY;
    await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
    expect(await policy.thresholdFor('opencode', 'user', 0.55)).toBeCloseTo(0.58, 5);

    // 超过 missed 阈值后向下调回；先增加 spoken 样本把 uselessRate 稀释到阈值以下。
    for (let index = 0; index < 10; index += 1) {
      await policy.recordOutcome({ agentId: 'opencode', domain: 'user', kind: 'missed' });
    }
    for (let index = 0; index < 10; index += 1) {
      await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
    }
    for (let index = 0; index < 10; index += 1) {
      await policy.recordOutcome({ agentId: 'opencode', domain: 'user', kind: 'accepted' });
    }
    await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'silent' });
    now += 8 * DAY;
    await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'silent' });
    expect(await policy.thresholdFor('opencode', 'user', 0.55)).toBeCloseTo(0.55, 5);

    // config 超界时，自适应结果仍 clamp 到 [0.45, 0.80]。
    expect(await policy.thresholdFor('opencode', 'user', 0.95)).toBe(0.8);
    expect(await policy.thresholdFor('opencode', 'user', 0.1)).toBe(0.45);
  }, 20_000);

  it('reset 清空统计并保留可用状态', async () => {
    const policy = store();
    await policy.init();
    await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
    await policy.recordOutcome({ agentId: 'opencode', domain: 'user', kind: 'accepted' });
    expect(await policy.reset()).toBe(1);
    const snapshot = await policy.snapshot();
    expect(snapshot.domains).toEqual([]);
    expect(snapshot.global.spoken).toBe(0);
    await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'silent' });
    expect((await policy.snapshot()).global.silent).toBe(1);
  });

  it('损坏文件 fail-open 为空统计，之后仍可写', async () => {
    const creator = store();
    await creator.init();
    await writeFile(path, '{not-json', { mode: 0o600 });
    const policy = store();
    await policy.init();
    const snapshot = await policy.snapshot();
    expect(snapshot.domains).toEqual([]);
    expect(snapshot.global.spoken).toBe(0);
    await policy.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
    expect((await policy.snapshot()).global.spoken).toBe(1);
  });
});
