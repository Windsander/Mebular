// 英文界面不得回落到中文：静态契约（纯数据，无浏览器）。
// 覆盖：IA tab/折叠/TTL/安全分区/字段文案、config-schema ui 文案与 reason 映射、
// AI 助手 tr() 文案、状态投影 labelKey。中文仍保留为 zh 兜底，但 en-US 必须命中 key。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import {
  IA_ADVANCED_SECTIONS,
  IA_FIELD_COPY,
  IA_MCP_SECTIONS,
  IA_SECURITY_SECTIONS,
  IA_SETTINGS_EXTRA,
  IA_SETTINGS_FOLDS,
  IA_TABS,
  INVITE_TTL_OPTIONS,
  SCHEMA_REASON_RULES,
  localizeSchemaReason,
} from '../../packages/console/settings-ia.js';
import { CONFIG_SCHEMA } from '../../packages/mcp/src/config-schema.mjs';
import { projectAssistantStatus } from '../../packages/console/assistant-status.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const readMessages = (locale) => JSON.parse(
  readFileSync(join(root, 'locales', locale, 'console.json'), 'utf-8'),
).messages;
const zh = readMessages('zh-CN');
const en = readMessages('en-US');
const CJK = /[\u4e00-\u9fff]/;
const placeholderSet = (text) => new Set([...String(text).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]));

/** key 必须双语存在、占位符对等，且英文不含中文。 */
function expectLocalizedKey(key) {
  expect(typeof key).toBe('string');
  expect(Object.prototype.hasOwnProperty.call(zh, key)).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(en, key)).toBe(true);
  expect(CJK.test(en[key])).toBe(false);
  expect([...placeholderSet(en[key])].sort()).toEqual([...placeholderSet(zh[key])].sort());
}

function expectOptionalKey(key) {
  if (key !== null && key !== undefined) expectLocalizedKey(key);
}

describe('英文界面 · 代码兜底中文清理', () => {
  it('设置 IA：Tab / 关于本机 / 折叠 / TTL / 安全分区 / 字段文案均 key 化', () => {
    for (const tab of IA_TABS) expectLocalizedKey(tab.labelKey);
    for (const item of IA_SETTINGS_EXTRA) expectLocalizedKey(item.labelKey);
    for (const fold of IA_SETTINGS_FOLDS) expectLocalizedKey(fold.labelKey);
    for (const option of INVITE_TTL_OPTIONS) {
      expectLocalizedKey(option.labelKey);
      expect(option.labelVars).toBeTruthy();
      expect(option.label.replace(/\s+/g, '')).toContain(String(option.labelVars.n));
    }
    for (const section of [...IA_ADVANCED_SECTIONS, ...IA_MCP_SECTIONS, ...Object.values(IA_SECURITY_SECTIONS)]) {
      expectLocalizedKey(section.titleKey);
      expectLocalizedKey(section.descKey);
    }
    for (const copy of Object.values(IA_FIELD_COPY)) {
      expectOptionalKey(copy.labelKey);
      expectLocalizedKey(copy.helpKey);
      expectOptionalKey(copy.warnKey);
    }
  });

  it('config-schema：Console 渲染的 label/help/warn/options 都有 key，且英文无中文', () => {
    const rendered = CONFIG_SCHEMA.filter(
      (entry) => entry.exposure === 'editable' || entry.exposure === 'status-only',
    );
    expect(rendered.length).toBeGreaterThan(0);
    for (const entry of rendered) {
      const ui = entry.ui ?? {};
      expectLocalizedKey(ui.labelKey);
      expectOptionalKey(ui.helpKey);
      expectOptionalKey(ui.warnKey);
      if (ui.help) expect(typeof ui.helpKey).toBe('string');
      if (ui.warn) expect(typeof ui.warnKey).toBe('string');
      if (Array.isArray(ui.options)) {
        for (const [value] of ui.options) {
          expect(typeof ui.optionKeys?.[value]).toBe('string');
          expectLocalizedKey(ui.optionKeys[value]);
        }
      }
    }
  });

  it('config-schema reason 模板：key 双语齐备，已知静态原因译成英文，动态原文原样保留', () => {
    for (const rule of SCHEMA_REASON_RULES) expectLocalizedKey(rule.key);

    const samples = [
      ['network.libp2p.listen', '仅回环监听：LAN 内其他设备不可达（如需 LAN 可设 0.0.0.0 或本机 LAN IP）'],
      ['joinService.enabled', 'join 端点解析为回环地址：LAN 内新设备不可达（joinService.bind 设 0.0.0.0）'],
      ['joinService.port', 'join 端口被占（上次启动失败：4002）——改端口或释放占用'],
      ['status.relay.bridge', '已生效：经 /ip4/1.2.3.4/tcp/1 中转'],
      ['status.net.broadcast', '已生效：档位 full（已发布 2 / 已采用 1）'],
      ['status.join.endpoint', '上次启动失败：EADDRINUSE'],
      ['status.tls', '未启用：明文 HTTP（仅回环安全）'],
    ];
    for (const [path, text] of samples) {
      const translated = localizeSchemaReason(path, text, (key, vars) => {
        const template = en[key];
        return Object.entries(vars ?? {}).reduce(
          (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
          template,
        );
      });
      expect(translated).not.toBe(text);
      expect(CJK.test(translated)).toBe(false);
    }

    // 未命中的动态错误原文（serve 下一批处理）不误翻、不改写。
    const dynamic = 'EACCES: permission denied, open /tmp/x';
    expect(localizeSchemaReason('status.relay.role', dynamic, () => 'should-not-be-used')).toBe(dynamic);
    expect(localizeSchemaReason('status.relay.role', '', () => 'should-not-be-used')).toBe('');
  });

  it('AI 助手：所有 tr() 文案 key 双语存在，英文不回落中文；状态投影提供 labelKey', () => {
    const src = readFileSync(join(root, 'packages', 'console', 'assistants.js'), 'utf-8');
    const keys = [...src.matchAll(/\btr\(\s*'([^']+)'/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of new Set(keys)) expectLocalizedKey(key);

    const states = [
      projectAssistantStatus({}, { busy: 'write' }),
      projectAssistantStatus({}, { busy: 'verify' }),
      projectAssistantStatus({}, { failed: { kind: 'connect' } }),
      projectAssistantStatus({}, { failed: { kind: 'verify' } }),
      projectAssistantStatus({}, { verifyState: 'pending-restart' }),
      projectAssistantStatus({ state: 'connected' }, {}),
      projectAssistantStatus({ state: 'detect-failed' }, {}),
      projectAssistantStatus({ state: 'stale' }, {}),
      projectAssistantStatus({ needsManual: true }, {}),
      projectAssistantStatus({ state: 'not-installed' }, {}),
      projectAssistantStatus({ state: 'not-connected' }, {}),
    ];
    for (const status of states) expectLocalizedKey(status.labelKey);
  });

  it('Console 渲染层确实使用 key（不是直接打印 schema 中文）', () => {
    const consoleSrc = readFileSync(join(root, 'packages', 'console', 'console.js'), 'utf-8');
    expect(consoleSrc).toContain('localizeSchemaUi');
    expect(consoleSrc).toContain('localizeSchemaReason');
    expect(consoleSrc).toContain('tab.labelKey');
    expect(consoleSrc).toContain('optionKey');
    expect(consoleSrc).toContain('reasonText');

    // 待重启横幅里可能出现、但 configSchema/statusSchema 未下发的可写 internal。
    const internalKeys = [...consoleSrc.matchAll(/'(settings\.schema\.internal\.[^']+)'/g)].map((m) => m[1]);
    expect(internalKeys.length).toBeGreaterThanOrEqual(5);
    for (const key of internalKeys) expectLocalizedKey(key);
  });
});

describe('运行时错误 · 错误码文案层（errors pack）', () => {
  const readErrors = (locale) => JSON.parse(
    readFileSync(join(root, 'locales', locale, 'errors.json'), 'utf-8'),
  ).messages;
  const zhErrors = readErrors('zh-CN');
  const enErrors = readErrors('en-US');

  it('errors pack：双语 key 对等、占位符一致、英文无中文', () => {
    expect(Object.keys(zhErrors).sort()).toEqual(Object.keys(enErrors).sort());
    for (const key of Object.keys(zhErrors)) {
      expect(placeholderSet(enErrors[key])).toEqual(placeholderSet(zhErrors[key]));
      expect(CJK.test(enErrors[key])).toBe(false);
    }
    expect(zhErrors['errors.unknown']).toBeTruthy();
  });

  it('Console 错误路径统一走 localizeError，不再直接透出服务端 message', () => {
    const consoleSrc = readFileSync(join(root, 'packages', 'console', 'console.js'), 'utf-8');
    expect(consoleSrc).toContain('function localizeError');
    expect(consoleSrc).toContain('function localizeEffectiveReason');
    expect(consoleSrc).toContain("t('errors.unknown')");
    // 已知动态错误使用 helper；原始 error.message 只允许出现在错误对象构造/内部逻辑。
    expect(consoleSrc).not.toMatch(/\{ message: error\.message \}/);
    expect(consoleSrc).not.toContain('${error.message}');
    for (const key of [...consoleSrc.matchAll(/t\('(errors\.[^']+)'/g)].map((m) => m[1])) {
      expect(Object.prototype.hasOwnProperty.call(zhErrors, key)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(enErrors, key)).toBe(true);
    }
  });

  it('服务端错误响应带稳定 errorKey（配置 / 记忆 / 交接 / 邀请）', () => {
    const serve = readFileSync(join(root, 'packages', 'mcp', 'src', 'serve.mjs'), 'utf-8');
    for (const code of [
      'invite_endpoint_invalid', 'memory_not_found', 'memory_deleted_archive',
      'namespace_required', 'address_required', 'handoff_force_local_only',
      'handoff_successor_required', 'config_patch_invalid',
    ]) {
      expect(serve).toContain(`errorKey: '${code}'`);
      expect(Object.prototype.hasOwnProperty.call(zhErrors, `errors.${code}`)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(enErrors, `errors.${code}`)).toBe(true);
    }
  });

  it('Desktop 主进程 / 向导错误详情有英文兜底，不直接展示中文原文', () => {
    const main = readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'index.mjs'), 'utf-8');
    expect(main).toContain('function localizeErrorDetail');
    expect(main).toContain('localizeErrorDetail(error');
    const wizard = readFileSync(join(root, 'apps', 'desktop', 'src', 'renderer', 'wizard.js'), 'utf-8');
    expect(wizard).toContain('function safeDetail');
    expect(wizard).toContain('function detailFrom');
    expect(wizard).not.toMatch(/error:\s*error\.message/);
  });
});
