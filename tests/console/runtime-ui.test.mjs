// 0.3 · Console 记忆运行时：设置映射 / 模型状态 / 时间线内部对象过滤 / 静态 DOM 契约。
// 纯逻辑单测 + 源码契约（不启浏览器、不引依赖）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import {
  IA_RUNTIME_ADVANCED_FIELDS,
  IA_RUNTIME_API_FIELDS,
  IA_RUNTIME_CONTROL_PATHS,
  IA_RUNTIME_FIELDS,
  IA_RUNTIME_FIELD_COPY,
  IA_RUNTIME_MODEL_SOURCES,
  IA_RUNTIME_MODES,
  IA_SETTINGS_FOLDS,
  IA_TABS,
  formatByteSize,
  filterRuntimeTimeline,
  isInternalRuntimeMemory,
  runtimeModeOf,
  runtimeModelSourceOf,
  runtimePackProgress,
  runtimePackStateKey,
  runtimeTimelineKind,
} from '../../packages/console/settings-ia.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const consoleJs = readFileSync(join(root, 'packages', 'console', 'console.js'), 'utf-8');
const indexHtml = readFileSync(join(root, 'packages', 'console', 'index.html'), 'utf-8');
const zh = JSON.parse(readFileSync(join(root, 'locales', 'zh-CN', 'console.json'), 'utf-8')).messages;
const en = JSON.parse(readFileSync(join(root, 'locales', 'en-US', 'console.json'), 'utf-8')).messages;

const normal = { id: '01A', type: 'fact', namespace: 'notes', preview: '普通事实' };
const compact = { id: '01B', type: 'compact', namespace: 'notes', preview: '摘要' };
const checkpoint = { id: '01C', type: 'context_checkpoint', namespace: '__checkpoint__', preview: '恢复点' };
const self = { id: '01D', type: 'self_record', namespace: '__self__', preview: '自我' };
const hiddenRecord = { id: '01E', type: 'fact', namespace: 'notes', metadata: { runtime: { internal: true } } };

const modelCardSource = (() => {
  const start = consoleJs.indexOf('function runtimePackCard(');
  const end = consoleJs.indexOf('function runtimeLocalModelsHtml(', start);
  return start >= 0 && end > start ? consoleJs.slice(start, end) : '';
})();

describe('0.3 设置 IA：记忆运行时 tab 与字段映射', () => {
  it('tab 顺序稳定：常用/安全/AI 助手/记忆运行时/MCP 接入/高级', () => {
    expect(IA_TABS.map((tab) => tab.id)).toEqual(['common', 'security', 'assistants', 'runtime', 'mcp', 'advanced']);
    expect(IA_TABS.find((tab) => tab.id === 'runtime')?.labelKey).toBe('settings.tab.runtime');
  });

  it('运行时高级折叠在白名单内（≤5），且高级字段各有文案 key', () => {
    expect(IA_SETTINGS_FOLDS.map((fold) => fold.id)).toContain('runtime-advanced');
    expect(IA_SETTINGS_FOLDS.length).toBeLessThanOrEqual(5);
    expect(Object.keys(IA_RUNTIME_FIELD_COPY).sort()).toEqual([...IA_RUNTIME_FIELDS].sort());
    for (const copy of Object.values(IA_RUNTIME_FIELD_COPY)) {
      expect(typeof copy.labelKey).toBe('string');
      expect(typeof copy.helpKey).toBe('string');
    }
  });

  it('两条主轴只有三个模型来源；host 不在全局来源开关里', () => {
    expect(IA_RUNTIME_MODES).toEqual(['mcp', 'immersive']);
    expect(IA_RUNTIME_MODEL_SOURCES).toEqual(['heuristic', 'local', 'api']);
    expect(IA_RUNTIME_MODEL_SOURCES).not.toContain('host');
    expect(IA_RUNTIME_CONTROL_PATHS).toEqual(['runtime.mode', 'runtime.model.source']);
  });

  it('API / 高级字段覆盖契约范围，且不包含线程/量化等技术项', () => {
    expect(IA_RUNTIME_API_FIELDS).toEqual([
      'runtime.model.api.baseUrl',
      'runtime.model.api.model',
      'runtime.model.api.keyRef',
      'runtime.model.api.allowRemote',
      'runtime.model.api.timeoutMs',
    ]);
    expect(IA_RUNTIME_ADVANCED_FIELDS).toEqual([
      'runtime.capture',
      'runtime.trace',
      'runtime.retention.rawDays',
      'runtime.retention.traceDays',
      'runtime.retention.checkpointDays',
      'runtime.limits.maxContextTokens',
      'runtime.checkpoint.sync',
      'runtime.self.sync',
    ]);
    expect(IA_RUNTIME_FIELDS.join(' ')).not.toMatch(/threads|quantization|port/i);
  });
});

describe('0.3 时间线：默认隐藏内部对象', () => {
  it('三重判定：内部类型 / metadata.runtime.internal / 保留 namespace', () => {
    expect(isInternalRuntimeMemory(compact)).toBe(true);
    expect(isInternalRuntimeMemory(checkpoint)).toBe(true);
    expect(isInternalRuntimeMemory(self)).toBe(true);
    expect(isInternalRuntimeMemory(hiddenRecord)).toBe(true);
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
    // 静态契约：render 卡片只使用 tier 推导名称，不读取后端 displayName。
    expect(consoleJs).toContain("pack?.tier === 'quality' ? '27B'");
    expect(consoleJs).toContain("pack?.tier === 'light' ? '4B' : '9B'");
  });

  it('模式/模型来源：status 优先，config 兜底；host 保留为状态值', () => {
    expect(runtimeModeOf({ mode: 'immersive' }, { runtime: { mode: 'mcp' } })).toBe('immersive');
    expect(runtimeModeOf(null, { runtime: { mode: 'immersive' } })).toBe('immersive');
    expect(runtimeModeOf(null, null)).toBe('mcp');
    expect(runtimeModelSourceOf({ model: { configured: 'host' } }, { runtime: { model: { source: 'api' } } })).toBe('host');
    expect(runtimeModelSourceOf(null, { runtime: { model: { source: 'local' } } })).toBe('local');
    expect(runtimeModelSourceOf(null, null)).toBe('heuristic');
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

  it('数据面：状态/模式/模型/轨迹/内部对象；普通 memories 查询不带 includeInternal', () => {
    expect(consoleJs).toContain("api('/runtime/v1/status')");
    expect(consoleJs).toContain("api('/runtime/v1/mode'");
    expect(consoleJs).toContain("api('/admin/api/models')");
    expect(consoleJs).toContain('api(`/admin/api/models/${action}`');
    expect(consoleJs).toContain("api('/runtime/v1/traces?limit=20')");
    expect(consoleJs).toContain('includeInternal=1');
    expect(consoleJs).toContain('data-rt-internal-toggle');
    const memQuery = consoleJs.match(/function memQuery\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(memQuery).not.toContain('includeInternal');
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

  it('API 密钥只显示引用/状态；非 env/keychain/file 值掩码', () => {
    expect(consoleJs).toContain('runtimeKeyRefDisplay');
    expect(consoleJs).toContain('/^(env|keychain|file):/');
    expect(consoleJs).toContain('settings.runtime.api.keyRefMasked');
    expect(consoleJs).toContain('allowRemoteWarn');
  });

  it('中英文运行时文案完整，英文无中文兜底', () => {
    const keys = Object.keys(zh).filter((key) => key.startsWith('runtime.') || key.startsWith('settings.runtime.') || key === 'nav.runtime' || key === 'settings.tab.runtime' || key === 'settings.fold.runtimeAdvanced');
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      expect(typeof zh[key]).toBe('string');
      expect(typeof en[key]).toBe('string');
      expect(en[key]).not.toMatch(/[\u3400-\u9fff]/);
    }
  });
});
