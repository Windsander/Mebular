// 小修复 · `yamlEntryBlock` 顶格注释/空行终止父段 → 真实结构的 `mebular:` 被漏判
//
// 真机实证：`~/.hermes/config.yaml` 的 `mcp_servers.mebular = {url, enabled}`，hermes 侧
// `config get`/`mcp test` 全通，但我们的行式解析把「顶格注释行」当父段结束 → 漏判。

import { describe, it, expect, jest } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { builtinAssistants, clearAssistantsCache, connectClient, landingState, yamlEntryBlock, yamlHasKey } from '../../packages/mcp/src/clients.mjs';

describe('yamlEntryBlock：注释/空行不终止父段（复刻真实结构）', () => {
  // 真机结构：child 在顶格注释块之后（hermes CLI 的新键追加落点）
  const REAL_SHAPE = [
    'mcp_servers:',
    '  openchamber:',
    '    command: /usr/bin/python3',
    '    args:',
    '      - shim.py',
    '',
    '  # ── Security ────────────────────────────────────────────',
    '  # Secret redaction is ON by default — strings…',
    '',
    '  mebular:',
    '    url: http://127.0.0.1:7331/mcp',
    '    enabled: true',
    '',
    'fallback_model: {}',
    '',
  ].join('\n');

  it('child 位于顶格注释块之后 → 命中（此前漏判）', () => {
    const block = yamlEntryBlock(REAL_SHAPE, 'mcp_servers', 'mebular');
    expect(block).not.toBeNull();
    expect(block).toMatch(/url:\s*http:\/\/127\.0\.0\.1:7331\/mcp/);
    expect(yamlHasKey(REAL_SHAPE, 'mcp_servers', 'mebular')).toBe(true);
  });

  it('未命中 → null（不误报）', () => {
    expect(yamlEntryBlock(REAL_SHAPE, 'mcp_servers', 'nope')).toBeNull();
    expect(yamlHasKey(REAL_SHAPE, 'mcp_servers', 'nope')).toBe(false);
    expect(yamlEntryBlock('mcp_servers:\n  other:\n    command: x\nnext: 1\n', 'mcp_servers', 'mebular')).toBeNull();
  });

  it('hermes：remote 形态（注释块后）→ url 有且 command 无；stdio → command 有且 url 无', () => {
    const remote = yamlEntryBlock(REAL_SHAPE, 'mcp_servers', 'mebular') ?? '';
    expect(/^\s*url\s*:\s*\S+/m.test(remote)).toBe(true);
    expect(/^\s*command\s*:/m.test(remote)).toBe(false);
    const stdioShape = ['mcp_servers:', '  # 注释', '  mebular:', '    command: mebular', '    args:', '      - mcp', ''].join('\n');
    const stdioBlock = yamlEntryBlock(stdioShape, 'mcp_servers', 'mebular') ?? '';
    expect(/^\s*command\s*:\s*\S+/m.test(stdioBlock)).toBe(true);
    expect(/^\s*url\s*:/m.test(stdioBlock)).toBe(false);
  });

  it('真机样本（若该文件存在且有 mebular 条目）→ readback 命中', () => {
    const real = join(homedir(), '.hermes', 'config.yaml');
    if (!existsSync(real)) return; // CI 上没有该文件 → 由上面的 fixture 覆盖
    const block = yamlEntryBlock(readFileSync(real, 'utf-8'), 'mcp_servers', 'mebular');
    if (block === null) return; // 该机器未接入 → 无可验（当前真实形态见 F-FIX-B 回执）
    expect(/^\s*url\s*:/m.test(block)).toBe(true); // 真机结构：块在注释块之后 → 必须命中
  });
});
