// U-3 · 设置页文案预算（纯数据断言，不起浏览器）：
//   - 每个可编辑字段都有一条 ≤1 行的帮助；
//   - 每个 section 说明 ≤1 行；
//   - 安全三档短句 + 一段边界，MCP 危险折叠 3 行；
//   - 主界面文案不出现内部错误码，禁用词为 0。
// 轮 i18n：用户可见文案真源迁到 locales/zh-CN/console.json；IA 常量只保留 key。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import {
  IA_ADVANCED_FIELDS,
  IA_ADVANCED_SECTIONS,
  IA_EDITOR_RENDER_PATHS,
  IA_FIELD_COPY,
  IA_MCP_DANGER_LINE_KEYS,
  IA_MCP_FIELDS,
  IA_MCP_SECTIONS,
  IA_SECURITY_SECTIONS,
  SECURITY_BOUNDARY_KEY,
  SECURITY_LEVEL_NOTE_KEY,
  SECURITY_LEVEL_TITLE_KEY,
  SECURITY_TOTP_FOOT_KEY,
} from '../../packages/console/settings-ia.js';

const zhPack = JSON.parse(readFileSync(new URL('../../locales/zh-CN/console.json', import.meta.url), 'utf-8')).messages;
const msg = (key) => zhPack[key];
const BANNED_WORDS = ['授权', '签发', '参与', '屏蔽', '踢出', '吊销'];
const INTERNAL_CODES = ['totp_not_configured', 'MCP_INSECURE_CONFIG', 'MCP_STORAGE_LOCKED'];
const compactLength = (text) => [...String(text).replace(/\s+/g, '')].length;

describe('U-3 设置页文案预算', () => {
  it('三个 tab 的 section 数量与字段集合稳定（高级 3 组 / MCP 2 组）', () => {
    expect(IA_ADVANCED_SECTIONS.map((section) => section.id)).toEqual(['resident', 'network', 'automation']);
    expect(IA_MCP_SECTIONS.map((section) => section.id)).toEqual(['connection', 'tls']);
    expect(IA_ADVANCED_SECTIONS.flatMap((section) => section.fields)).toEqual(IA_ADVANCED_FIELDS);
    expect(IA_MCP_SECTIONS.flatMap((section) => section.fields)).toEqual(IA_MCP_FIELDS);
    expect(IA_ADVANCED_FIELDS).toHaveLength(7);
    expect(IA_MCP_FIELDS).toHaveLength(6);
  });

  it('每个 section 说明 ≤1 行（≤40 字）', () => {
    const sections = [...IA_ADVANCED_SECTIONS, ...IA_MCP_SECTIONS, ...Object.values(IA_SECURITY_SECTIONS)];
    for (const section of sections) {
      expect(typeof section.descKey).toBe('string');
      expect(compactLength(msg(section.descKey))).toBeLessThanOrEqual(40);
    }
  });

  it('每个可编辑字段都有 ≤1 行帮助（≤36 字），且覆盖全部渲染字段', () => {
    expect(Object.keys(IA_FIELD_COPY).sort()).toEqual([...IA_EDITOR_RENDER_PATHS].sort());
    for (const copy of Object.values(IA_FIELD_COPY)) {
      expect(compactLength(msg(copy.helpKey))).toBeLessThanOrEqual(36);
    }
  });

  it('安全三档短句 + 一段边界；MCP 危险折叠恰好 3 行', () => {
    for (const tier of ['low', 'medium', 'high']) {
      expect(compactLength(msg(SECURITY_LEVEL_TITLE_KEY[tier]))).toBeLessThanOrEqual(12);
      expect(compactLength(msg(SECURITY_LEVEL_NOTE_KEY[tier]))).toBeLessThanOrEqual(30);
    }
    expect(compactLength(msg(SECURITY_BOUNDARY_KEY))).toBeLessThanOrEqual(80);
    expect(compactLength(msg(SECURITY_TOTP_FOOT_KEY))).toBeLessThanOrEqual(40);
    expect(IA_MCP_DANGER_LINE_KEYS).toHaveLength(3);
    expect(IA_MCP_DANGER_LINE_KEYS.every((key) => compactLength(msg(key)) <= 40)).toBe(true);
  });

  it('主界面文案禁用词与内部错误码均为 0', () => {
    const copy = [
      ...Object.values(IA_FIELD_COPY).flatMap((entry) => [entry.labelKey, entry.helpKey, entry.warnKey]
        .filter(Boolean)
        .map((key) => msg(key))),
      ...IA_ADVANCED_SECTIONS.flatMap((section) => [msg(section.titleKey), msg(section.descKey)]),
      ...IA_MCP_SECTIONS.flatMap((section) => [msg(section.titleKey), msg(section.descKey)]),
      ...Object.values(IA_SECURITY_SECTIONS).flatMap((section) => [msg(section.titleKey), msg(section.descKey)]),
      ...Object.values(SECURITY_LEVEL_TITLE_KEY).map((key) => msg(key)),
      ...Object.values(SECURITY_LEVEL_NOTE_KEY).map((key) => msg(key)),
      msg(SECURITY_BOUNDARY_KEY),
      msg(SECURITY_TOTP_FOOT_KEY),
      ...IA_MCP_DANGER_LINE_KEYS.map((key) => msg(key)),
    ].join('\n');
    expect(copy).not.toContain('undefined');
    for (const word of BANNED_WORDS) expect(copy).not.toContain(word);
    for (const code of INTERNAL_CODES) expect(copy).not.toContain(code);
  });
});
