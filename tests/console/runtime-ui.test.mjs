// C5 · Console 单一 UI：记忆模式（唯一产品增量 1）+ 高级模型来源（唯一产品增量 2）。
// 纯逻辑单测 + 源码/文案契约（不启浏览器、不引依赖）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import {
  IA_RUNTIME_CONTROL_PATHS,
  IA_RUNTIME_FIELDS,
  IA_RUNTIME_FIELD_COPY,
  IA_RUNTIME_MODEL_SOURCES,
  IA_RUNTIME_MODEL_SOURCE_DEFAULT,
  IA_SETTINGS_FOLDS,
  IA_TABS,
  RUNTIME_SIDECAR_STATES,
  filterRuntimeTimeline,
  isInternalRuntimeMemory,
  memoryRuntimeEnabledOf,
  memoryRuntimeModeOf,
  runtimeModelSourceAvailable,
  runtimeModelSourceOf,
  runtimeModelSourceReady,
  runtimeShowsModelSettings,
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

const functionSource = (name, nextName) => {
  const start = consoleJs.indexOf(`function ${name}(`);
  const end = consoleJs.indexOf(`function ${nextName}(`, start);
  return start >= 0 && end > start ? consoleJs.slice(start, end) : '';
};

const statusFactsSource = functionSource('runtimeStatusFactsHtml', 'runtimeModeSettingsHtml');
const modelSourceSectionSource = functionSource('runtimeModelSourceSectionHtml', 'renderRuntimeSettings');

describe('0.3 设置 IA：只有两个产品增量', () => {
  it('tab 顺序稳定：常用/安全/AI 助手/记忆运行时/MCP 接入/高级', () => {
    expect(IA_TABS.map((tab) => tab.id)).toEqual(['common', 'security', 'assistants', 'runtime', 'mcp', 'advanced']);
    expect(IA_TABS.find((tab) => tab.id === 'runtime')?.labelKey).toBe('settings.tab.runtime');
  });

  it('增量 1：memoryRuntime.enabled 是唯一模式控制键；不再映射旧 runtime.* 设置', () => {
    expect(IA_RUNTIME_CONTROL_PATHS).toEqual(['memoryRuntime.enabled']);
    expect(IA_RUNTIME_FIELDS).toEqual([]);
    expect(IA_RUNTIME_FIELD_COPY).toEqual({});
    expect(JSON.stringify(settingsIa)).not.toMatch(/runtime\.mode\b|runtime\.capture\b|runtime\.checkpoint\.sync\b|runtime\.self\.sync\b/);
  });

  it('增量 2：模型来源只允许 heuristic/local/host/api/auto，默认 heuristic', () => {
    expect(IA_RUNTIME_MODEL_SOURCES).toEqual(['heuristic', 'local', 'host', 'api', 'auto']);
    expect(IA_RUNTIME_MODEL_SOURCE_DEFAULT).toBe('heuristic');
    expect(runtimeModelSourceOf(undefined)).toBe('heuristic');
    expect(runtimeModelSourceOf('AUTO')).toBe('auto');
    expect(runtimeModelSourceOf('bogus')).toBe('heuristic');
  });

  it('设置折叠白名单不含 runtime-advanced（旧运行时诊断 UI 已删除）', () => {
    expect(IA_SETTINGS_FOLDS.map((fold) => fold.id)).toEqual(['mcp-danger', 'diagnostics', 'about-runtime']);
    expect(IA_SETTINGS_FOLDS.length).toBeLessThanOrEqual(5);
  });

  it('memoryRuntime.enabled 默认关闭；状态优先、配置兜底', () => {
    expect(memoryRuntimeEnabledOf(null, null)).toBe(false);
    expect(memoryRuntimeEnabledOf(null, { memoryRuntime: { enabled: true } })).toBe(true);
    expect(memoryRuntimeEnabledOf({ enabled: false }, { memoryRuntime: { enabled: true } })).toBe(false);
    expect(memoryRuntimeEnabledOf({ enabled: true }, { memoryRuntime: { enabled: false } })).toBe(true);
  });

  it('记忆模式映射：lightweight / immersive；轻量不显示模型配置', () => {
    expect(memoryRuntimeModeOf(null, null)).toBe('lightweight');
    expect(memoryRuntimeModeOf(null, { memoryRuntime: { enabled: true } })).toBe('immersive');
    expect(memoryRuntimeModeOf({ enabled: false }, { memoryRuntime: { enabled: true } })).toBe('lightweight');
    expect(memoryRuntimeModeOf({ enabled: true }, { memoryRuntime: { enabled: false } })).toBe('immersive');
    expect(runtimeShowsModelSettings(null, null)).toBe(false);
    expect(runtimeShowsModelSettings({ enabled: true }, null)).toBe(true);
  });

  it('模型来源可用性：heuristic/auto 总是可用；local/api 需已配置；host 为基础来源', () => {
    expect(runtimeModelSourceAvailable('heuristic', null)).toBe(true);
    expect(runtimeModelSourceAvailable('auto', null)).toBe(true);
    expect(runtimeModelSourceAvailable('host', null)).toBe(true);
    expect(runtimeModelSourceAvailable('local', null)).toBe(false);
    expect(runtimeModelSourceAvailable('local', { sources: ['heuristic', 'host', 'local'] })).toBe(true);
    expect(runtimeModelSourceAvailable('api', { sources: ['heuristic', 'host'] })).toBe(false);
    expect(runtimeModelSourceAvailable('api', { sources: ['heuristic', 'host', 'api'] })).toBe(true);
  });

  it('模型来源控件只在沉浸式且记忆运行时可用时启用', () => {
    expect(runtimeModelSourceReady(null)).toBe(false);
    expect(runtimeModelSourceReady({ enabled: false, available: false })).toBe(false);
    expect(runtimeModelSourceReady({ enabled: true, available: false })).toBe(false);
    expect(runtimeModelSourceReady({ enabled: true, available: true })).toBe(true);
  });

  it('sidecar 状态码映射完整，未知状态按 stopped', () => {
    expect(RUNTIME_SIDECAR_STATES).toEqual(['disabled', 'not_installed', 'stopped', 'starting', 'ready', 'degraded', 'stopping', 'failed']);
    for (const state of RUNTIME_SIDECAR_STATES) {
      expect(runtimeSidecarStateKey(state)).toBe(`runtime.sidecar.state.${state}`);
    }
    expect(runtimeSidecarStateKey('bogus')).toBe('runtime.sidecar.state.stopped');
  });
});

describe('0.3 时间线：默认隐藏内部对象（治理能力保留）', () => {
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

  it('默认 filter=memory 只返回普通记录；管理员开关后才出现内部对象', () => {
    const all = [normal, compact, checkpoint, self, hiddenRecord];
    expect(filterRuntimeTimeline(all).map((row) => row.id)).toEqual(['01A']);
    expect(filterRuntimeTimeline(all, { filter: 'all', includeInternal: true }).map((row) => row.id)).toEqual(['01A', '01B', '01C', '01D', '01E']);
    expect(filterRuntimeTimeline(all, { filter: 'compact', includeInternal: true }).map((row) => row.id)).toEqual(['01B']);
    expect(filterRuntimeTimeline(all, { filter: 'checkpoint', includeInternal: true }).map((row) => row.id)).toEqual(['01C']);
    expect(filterRuntimeTimeline(all, { filter: 'self', includeInternal: true }).map((row) => row.id)).toEqual(['01D']);
    expect(filterRuntimeTimeline(all, { filter: 'compact', includeInternal: false })).toEqual([]);
  });
});

describe('0.3 静态 DOM / 数据面契约', () => {
  it('导航与治理视图保留：运行时在审计之后', () => {
    const nav = indexHtml.slice(indexHtml.indexOf('id="view-nav"'), indexHtml.indexOf('</nav>'));
    const order = [...nav.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['map', 'domains', 'memories', 'audit', 'runtime']);
    for (const id of ['runtime-view', 'runtime-status', 'runtime-timeline', 'runtime-timeline-controls', 'runtime-traces', 'runtime-refresh']) {
      expect(indexHtml).toContain(`id="${id}"`);
    }
    expect(indexHtml).toContain('data-i18n="nav.runtime"');
  });

  it('数据面：模式状态、模型来源、轨迹、反馈都走 admin 薄代理；不再调用本地模型包接口', () => {
    expect(consoleJs).toContain("api('/admin/api/memory-runtime/status')");
    expect(consoleJs).toContain("api('/admin/api/memory-runtime/model-source')");
    expect(consoleJs).toContain("api('/admin/api/memory-runtime/traces?limit=20')");
    expect(consoleJs).toContain("api('/admin/api/memory-runtime/feedback'");
    expect(consoleJs).toContain('api(`/admin/api/memory-runtime/traces/${encodeURIComponent(id)}`)');
    expect(consoleJs).not.toContain("api('/admin/api/models')");
    expect(consoleJs).not.toContain('/runtime/v1');
    expect(consoleJs).not.toMatch(/runtimePack|data-rt-pack|settings\.runtime\.local/);
    expect(consoleJs).toContain('saveRuntimePatch({ memoryRuntime: { enabled } }');
    expect(consoleJs).toContain('data-rt-mode');
    expect(consoleJs).toContain('data-rt-model-source');
    expect(consoleJs).toContain('data-rt-mem-action');
    expect(consoleJs).toContain("api(`/admin/api/memories/${encodeURIComponent(id)}/${action}`");
    expect(consoleJs).toContain('runtime.trace.disabled');
    expect(consoleJs).toContain('includeInternal=1');
    expect(consoleJs).toContain('data-rt-internal-toggle');
    const memQuery = consoleJs.match(/function memQuery\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(memQuery).not.toContain('includeInternal');
  });

  it('状态卡只显示 mode/state/degraded/error/version，不显示 token/tokenFile/PID', () => {
    expect(statusFactsSource.length).toBeGreaterThan(0);
    for (const marker of ['runtime.status.mode', 'runtime.sidecar.state', 'runtime.sidecar.degraded', 'runtime.sidecar.error', 'runtime.sidecar.version']) {
      expect(statusFactsSource).toContain(marker);
    }
    expect(statusFactsSource).not.toMatch(/status\.pid|tokenFile|hostToken|host-token|token/i);
  });

  it('轻量模式不渲染模型配置；高级模型来源禁用并说明', () => {
    expect(consoleJs).toContain('${enabled ? runtimeModelStatusHtml(status) : \'\'}');
    expect(consoleJs).toContain("t('settings.runtime.modelSource.light')");
    expect(consoleJs).toContain('meta.available !== true');
    expect(modelSourceSectionSource.length).toBeGreaterThan(0);
    expect(modelSourceSectionSource).not.toMatch(/endpoint|keyRef|baseUrl|modelPath|api[ _-]?key/i);
    expect(modelSourceSectionSource).toContain('data-rt-model-source');
    expect(modelSourceSectionSource).toContain('IA_RUNTIME_MODEL_SOURCES');
    expect(modelSourceSectionSource).toContain('runtimeModelSourceReady(meta)');
  });

  it('轨迹详情展示 why / citations / confidence / domain / owner / provenance；反馈走 admin proxy', () => {
    for (const marker of ['runtime.trace.reasonTopics', 'runtime.trace.citations', 'runtime.trace.confidence', 'runtime.trace.domain', 'runtime.trace.owner', 'runtime.trace.provenance']) {
      expect(consoleJs).toContain(marker);
    }
    expect(consoleJs).toContain('runtimeTraceFeedback');
  });

  it('中英文运行时文案完整；旧 capture/raw/token 文案与模型包文案已删除', () => {
    const keys = Object.keys(zh).filter((key) => key.startsWith('runtime.') || key.startsWith('settings.runtime.') || key === 'nav.runtime' || key === 'settings.tab.runtime');
    expect(keys.length).toBeGreaterThan(120);
    for (const key of keys) {
      expect(typeof zh[key]).toBe('string');
      expect(typeof en[key]).toBe('string');
      expect(en[key]).not.toMatch(/[\u3400-\u9fff]/);
      expect(zh[key]).not.toMatch(/capture|raw|tokenFile|host-token|host adapter|discovery|endpoint|keyRef|api[ _-]?key|retention|self\.sync|\bsync\b/i);
      expect(en[key]).not.toMatch(/capture|raw|tokenFile|host-token|host adapter|discovery|endpoint|keyRef|api[ _-]?key|retention|self\.sync|\bsync\b/i);
    }
    expect(zh).not.toHaveProperty('settings.runtime.local.title');
    expect(zh).not.toHaveProperty('settings.runtime.state.installed');
    expect(zh).not.toHaveProperty('runtime.sidecar.enabled');
    expect(zh['settings.runtime.mode.title']).toBe('记忆模式');
    expect(zh['settings.runtime.modelSource.title']).toBe('模型来源');
    expect(en['settings.runtime.modelSource.title']).toBe('Model source');
  });
});
