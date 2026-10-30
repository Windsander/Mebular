// 0.3 · Console 记忆运行时：memoryRuntime.enabled 映射 / sidecar 状态 / 治理视图 / 静态契约。
// 纯逻辑单测 + 源码契约（不启浏览器、不引依赖）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import {
  IA_RUNTIME_CONTROL_PATHS,
  IA_RUNTIME_FIELDS,
  IA_RUNTIME_FIELD_COPY,
  IA_SETTINGS_FOLDS,
  IA_TABS,
  RUNTIME_SIDECAR_STATES,
  formatByteSize,
  filterRuntimeTimeline,
  isInternalRuntimeMemory,
  memoryRuntimeEnabledOf,
  runtimePackProgress,
  runtimePackStateKey,
  runtimeSidecarStateKey,
  runtimeTimelineKind,
} from '../../packages/console/settings-ia.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const consoleJs = readFileSync(join(root, 'packages', 'console', 'console.js'), 'utf-8');
const settingsIa = readFileSync(join(root, 'packages', 'console', 'settings-ia.js'), 'utf-8');
const indexHtml = readFileSync(join(root, 'packages', 'console', 'index.html'), 'utf-8');
const zh = JSON.parse(readFileSync(join(root, 'locales', 'zh-CN', 'console.json'), 'utf-8')).messages;
const en = JSON.parse(readFileSync(join(root, 'locales', 'en-US', 'console.json'), 'utf-8')).messages;

const normal = { id: '01A', type: 'fact', namespace: 'notes', preview: '普通事实' };
const compact = { id: '01B', type: 'compact', namespace: 'notes', preview: '摘要', metadata: { internal: true } };
const checkpoint = { id: '01C', type: 'context_checkpoint', namespace: 'task:th_1', preview: '恢复点', metadata: { internal: true } };
const self = { id: '01D', type: 'self_record', namespace: 'agent:opencode', preview: '自我', metadata: { internal: true } };
const hiddenRecord = { id: '01E', type: 'fact', namespace: 'notes', metadata: { internal: true } };
const legacyHidden = { id: '01F', type: 'fact', namespace: '__checkpoint__', preview: '旧原型' };

const modelCardSource = (() => {
  const start = consoleJs.indexOf('function runtimePackCard(');
  const end = consoleJs.indexOf('function runtimeLocalModelsHtml(', start);
  return start >= 0 && end > start ? consoleJs.slice(start, end) : '';
})();

describe('0.3 设置 IA：记忆运行时单开关', () => {
  it('tab 顺序稳定：常用/安全/AI 助手/记忆运行时/MCP 接入/高级', () => {
    expect(IA_TABS.map((tab) => tab.id)).toEqual(['common', 'security', 'assistants', 'runtime', 'mcp', 'advanced']);
    expect(IA_TABS.find((tab) => tab.id === 'runtime')?.labelKey).toBe('settings.tab.runtime');
  });

  it('只有一个控制键 memoryRuntime.enabled；不再映射旧 runtime.* 设置', () => {
    expect(IA_RUNTIME_CONTROL_PATHS).toEqual(['memoryRuntime.enabled']);
    expect(IA_RUNTIME_FIELDS).toEqual([]);
    expect(IA_RUNTIME_FIELD_COPY).toEqual({});
    expect(JSON.stringify(settingsIa)).not.toMatch(/runtime\.mode|runtime\.capture|runtime\.model\.source|runtime\.checkpoint\.sync|runtime\.self\.sync/);
  });

  it('设置折叠仍在白名单内（≤5）', () => {
    expect(IA_SETTINGS_FOLDS.map((fold) => fold.id)).toContain('runtime-advanced');
    expect(IA_SETTINGS_FOLDS.length).toBeLessThanOrEqual(5);
  });

  it('memoryRuntime.enabled 默认关闭；状态优先、配置兜底', () => {
    expect(memoryRuntimeEnabledOf(null, null)).toBe(false);
    expect(memoryRuntimeEnabledOf(null, { memoryRuntime: { enabled: true } })).toBe(true);
    expect(memoryRuntimeEnabledOf({ enabled: false }, { memoryRuntime: { enabled: true } })).toBe(false);
    expect(memoryRuntimeEnabledOf({ enabled: true }, { memoryRuntime: { enabled: false } })).toBe(true);
  });

  it('sidecar 状态码映射完整，未知状态按 stopped', () => {
    expect(RUNTIME_SIDECAR_STATES).toEqual(['disabled', 'not_installed', 'stopped', 'starting', 'ready', 'degraded', 'stopping', 'failed']);
    for (const state of RUNTIME_SIDECAR_STATES) {
      expect(runtimeSidecarStateKey(state)).toBe(`runtime.sidecar.state.${state}`);
    }
    expect(runtimeSidecarStateKey('bogus')).toBe('runtime.sidecar.state.stopped');
  });
});

describe('0.3 时间线：默认隐藏内部对象', () => {
  it('三重判定：内部类型 / metadata.internal / 保留 namespace', () => {
    expect(isInternalRuntimeMemory(compact)).toBe(true);
    expect(isInternalRuntimeMemory(checkpoint)).toBe(true);
    expect(isInternalRuntimeMemory(self)).toBe(true);
    expect(isInternalRuntimeMemory(hiddenRecord)).toBe(true);
    expect(isInternalRuntimeMemory(legacyHidden)).toBe(true);
    expect(isInternalRuntimeMemory(normal)).toBe(false);
    expect(runtimeTimelineKind(compact)).toBe('compact');
    expect(runtimeTimelineKind(checkpoint)).toBe('checkpoint');
    expect(runtimeTimelineKind(self)).toBe('self');
    expect(runtimeTimelineKind(hiddenRecord)).toBe('other');
  });

  it('默认 filter=memory 只返回普通记录；打开管理员开关后才出现 compact/checkpoint/self', () => {
    const all = [normal, compact, checkpoint, self, hiddenRecord];
    expect(filterRuntimeTimeline(all).map((row) => row.id)).toEqual(['01A']);
    expect(filterRuntimeTimeline(all, { filter: 'all', includeInternal: true }).map((row) => row.id)).toEqual(['01A', '01B', '01C', '01D', '01E']);
    expect(filterRuntimeTimeline(all, { filter: 'compact', includeInternal: true }).map((row) => row.id)).toEqual(['01B']);
    expect(filterRuntimeTimeline(all, { filter: 'checkpoint', includeInternal: true }).map((row) => row.id)).toEqual(['01C']);
    expect(filterRuntimeTimeline(all, { filter: 'self', includeInternal: true }).map((row) => row.id)).toEqual(['01D']);
    // 未打开管理员开关时，内部筛选为空（不偷偷显示）
    expect(filterRuntimeTimeline(all, { filter: 'compact', includeInternal: false })).toEqual([]);
  });
});

describe('0.3 模型状态与数值格式', () => {
  it('模型包状态映射完整，未知状态回退 failed', () => {
    for (const state of ['not_installed', 'downloading', 'verifying', 'installing', 'paused', 'failed', 'cancelled', 'installed', 'corrupt']) {
      expect(runtimePackStateKey(state)).toBe(`settings.runtime.state.${state}`);
    }
    expect(runtimePackStateKey('bogus')).toBe('settings.runtime.state.failed');
  });

  it('下载进度：total 未知不伪造百分比', () => {
    expect(runtimePackProgress({ downloadedBytes: 1_200_000_000, totalBytes: 2_900_000_000 }).percent).toBeCloseTo(41.379, 2);
    expect(runtimePackProgress({ downloadedBytes: 10 }).percent).toBeNull();
    expect(runtimePackProgress(null)).toEqual({ downloadedBytes: 0, totalBytes: 0, percent: null });
  });

  it('体积显示十进制单位；3 个精选包分别显示 4B/9B/27B', () => {
    expect(formatByteSize(6_300_000_000)).toBe('6.3 GB');
    expect(formatByteSize(17_600_000_000)).toBe('17.6 GB');
    expect(formatByteSize(0)).toBe('0 B');
    expect(consoleJs).toContain("pack?.tier === 'quality' ? '27B'");
    expect(consoleJs).toContain("pack?.tier === 'light' ? '4B' : '9B'");
  });
});

describe('0.3 静态 DOM / 数据面契约', () => {
  it('导航与视图存在：运行时在审计之后（不移动既有 1–4 编号）', () => {
    const nav = indexHtml.slice(indexHtml.indexOf('id="view-nav"'), indexHtml.indexOf('</nav>'));
    const order = [...nav.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['map', 'domains', 'memories', 'audit', 'runtime']);
    for (const id of ['runtime-view', 'runtime-status', 'runtime-timeline', 'runtime-timeline-controls', 'runtime-traces', 'runtime-refresh']) {
      expect(indexHtml).toContain(`id="${id}"`);
    }
    expect(indexHtml).toContain('data-i18n="nav.runtime"');
  });

  it('数据面：admin sidecar 代理 / models / memories；Console 不再调用 /runtime/v1', () => {
    expect(consoleJs).toContain("api('/admin/api/memory-runtime/status')");
    expect(consoleJs).toContain("api('/admin/api/memory-runtime/traces?limit=20')");
    expect(consoleJs).toContain("api('/admin/api/memory-runtime/feedback'");
    expect(consoleJs).toContain('api(`/admin/api/memory-runtime/traces/${encodeURIComponent(id)}`)');
    expect(consoleJs).toContain("api('/admin/api/models')");
    expect(consoleJs).toContain('api(`/admin/api/models/${action}`');
    expect(consoleJs).not.toContain('/runtime/v1');
    expect(consoleJs).not.toMatch(/runtime\.mode\b/);
    expect(consoleJs).toContain('saveRuntimePatch({ memoryRuntime: { enabled } }');
    expect(consoleJs).toContain('data-rt-mem-action');
    expect(consoleJs).toContain("api(`/admin/api/memories/${encodeURIComponent(id)}/${action}`");
    expect(consoleJs).toContain('runtime.trace.disabled');
    expect(consoleJs).toContain('includeInternal=1');
    expect(consoleJs).toContain('data-rt-internal-toggle');
    expect(consoleJs).toContain('data-rt-enabled');
    const memQuery = consoleJs.match(/function memQuery\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(memQuery).not.toContain('includeInternal');
  });

  it('轨迹详情展示 why / citations / confidence / domain / owner / provenance；反馈走 admin proxy', () => {
    for (const marker of ['runtime.trace.reasonTopics', 'runtime.trace.citations', 'runtime.trace.confidence', 'runtime.trace.domain', 'runtime.trace.owner', 'runtime.trace.provenance']) {
      expect(consoleJs).toContain(marker);
    }
    expect(consoleJs).toContain('runtimeTraceFeedback');
    expect(consoleJs).toContain("api('/admin/api/memory-runtime/feedback'");
  });

  it('本地模型卡片不显示量化/上下文长度/线程/端口；显示体积与内存要求', () => {
    expect(modelCardSource.length).toBeGreaterThan(0);
    expect(modelCardSource).not.toContain('quantization');
    expect(modelCardSource).not.toContain('contextLength');
    expect(modelCardSource).not.toContain('threads');
    expect(modelCardSource).not.toContain('port');
    expect(modelCardSource).toContain('settings.runtime.local.size');
    expect(modelCardSource).toContain('settings.runtime.local.memory');
    expect(modelCardSource).toContain('data-rt-pack-action');
  });

  it('模型区：宿主管理状态不伪造，本地模型明确由 Mebular 管理', () => {
    expect(consoleJs).toContain('data-rt-host-model');
    expect(consoleJs).toContain('settings.runtime.model.hostManaged');
    expect(consoleJs).toContain('settings.runtime.model.localManaged');
    expect(zh['settings.runtime.model.hostManaged']).toBe('宿主管理');
    expect(zh['settings.runtime.model.localManaged']).toBe('由 Mebular 管理');
  });

  it('sidecar 状态只展示 enabled/state/pid/version/degraded/error，不含 token/tokenFile', () => {
    for (const key of ['runtime.sidecar.enabled', 'runtime.sidecar.state', 'runtime.sidecar.pid', 'runtime.sidecar.version', 'runtime.sidecar.degraded', 'runtime.sidecar.error']) {
      expect(consoleJs).toContain(key);
    }
    expect(consoleJs).not.toMatch(/tokenFile|hostToken|host-token/);
  });

  it('中英文运行时文案完整，英文无中文兜底', () => {
    const keys = Object.keys(zh).filter((key) => key.startsWith('runtime.') || key.startsWith('settings.runtime.') || key === 'nav.runtime' || key === 'settings.tab.runtime' || key === 'settings.fold.runtimeAdvanced');
    expect(keys.length).toBeGreaterThan(120);
    for (const key of keys) {
      expect(typeof zh[key]).toBe('string');
      expect(typeof en[key]).toBe('string');
      expect(en[key]).not.toMatch(/[\u3400-\u9fff]/);
    }
    expect(zh).not.toHaveProperty('runtime.mode.mcp');
    expect(en).not.toHaveProperty('runtime.mode.mcp');
  });
});
