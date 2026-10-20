// 邀请面板：单动作（令牌 + 二维码 + 忆云身份 + 有效期/重新生成），不再有详情折叠。
// 静态契约 + TTL 档位单一真源断言（不启浏览器；活体见 verify:console / verify:console:ui）。

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IA_SETTINGS_FOLDS,
  INVITE_TTL_DEFAULT_MS,
  INVITE_TTL_OPTIONS,
} from '../../packages/console/settings-ia.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const consoleJs = readFileSync(join(root, 'packages', 'console', 'console.js'), 'utf-8');
const serveSrc = readFileSync(join(root, 'packages', 'mcp', 'src', 'serve.mjs'), 'utf-8');

function invitePanelSource() {
  const start = consoleJs.indexOf('function showInviteResult');
  const end = consoleJs.indexOf("$('#invite-device')", start);
  return start >= 0 && end > start ? consoleJs.slice(start, end) : '';
}

describe('邀请面板 · TTL 档位与单动作结构', () => {
  it('令牌有效期档位精确：5/15/20 分钟、2/6/12/24 小时；默认 15 分钟', () => {
    expect(INVITE_TTL_OPTIONS).toEqual([
      { label: '5 分钟', ttlMs: 300_000 },
      { label: '15 分钟', ttlMs: 900_000 },
      { label: '20 分钟', ttlMs: 1_200_000 },
      { label: '2 小时', ttlMs: 7_200_000 },
      { label: '6 小时', ttlMs: 21_600_000 },
      { label: '12 小时', ttlMs: 43_200_000 },
      { label: '24 小时', ttlMs: 86_400_000 },
    ]);
    expect(INVITE_TTL_DEFAULT_MS).toBe(900_000);
    expect(consoleJs).toContain('inviteTtlMs: INVITE_TTL_DEFAULT_MS');
    expect(consoleJs).toMatch(/state\.inviteTtlMs = INVITE_TTL_DEFAULT_MS;\s*\n\s*void openInvite\(\)/);
  });

  it('邀请面板不再有 details / endpoint 编辑器 / CLI 命令 / 默认域与订阅说明', () => {
    const panel = invitePanelSource();
    expect(panel.length).toBeGreaterThan(0);
    expect(panel).not.toContain('<details');
    expect(panel).not.toContain('data-settings-fold="invite"');
    expect(panel).not.toContain('invite-detail-fold');
    expect(panel).not.toContain('invite-endpoint');
    expect(panel).not.toContain('endpointEditor');
    expect(panel).not.toContain('fleet join --token');
    expect(panel).not.toContain('默认记忆域');
    expect(panel).not.toContain('兑换只建立入网信任');
    expect(consoleJs).not.toContain("foldLabel('invite')");
    expect(IA_SETTINGS_FOLDS.map((fold) => fold.id)).toEqual(['mcp-danger', 'diagnostics', 'about-runtime']);
  });

  it('保留令牌/二维码/本忆云名 + 根指纹/一句安全提示；TTL 选择 + 重新生成在面板内', () => {
    const panel = invitePanelSource();
    expect(panel).toContain('data-copy=');
    expect(panel).toContain('qrBlock');
    expect(panel).toContain('invite-cloud-identity');
    expect(panel).toContain('根指纹');
    expect(panel).toContain('令牌即入网权限');
    expect(panel).toContain('重新生成后旧令牌立即失效');
    expect(panel).toContain('id="invite-ttl"');
    expect(panel).toContain('id="invite-regenerate"');
    expect(panel).toContain('INVITE_TTL_OPTIONS');
  });

  it('改档不自动刷新；点重新生成才把选中的 ttlMs 传给 /admin/api/invite', () => {
    const changeAt = consoleJs.indexOf("body.querySelector('#invite-ttl')");
    const regenAt = consoleJs.indexOf("body.querySelector('#invite-regenerate')");
    const changeHandler = changeAt >= 0 && regenAt > changeAt ? consoleJs.slice(changeAt, regenAt) : '';
    expect(changeHandler.length).toBeGreaterThan(0);
    expect(changeHandler).not.toMatch(/openInvite\(|renderInvite\(|api\(/);
    expect(changeHandler).toContain('state.inviteTtlMs = value');

    expect(consoleJs).toMatch(/invite-regenerate[\s\S]{0,220}confirm\(/);
    expect(consoleJs).toMatch(/confirm\('重新生成后旧令牌立即失效。确定？'\)\)\s*void openInvite\(state\.inviteTtlMs\)/);
    expect(consoleJs).toMatch(/async function renderInvite\(ttlMs = state\.inviteTtlMs\)[\s\S]{0,260}body: \{ ttlMs \}/);
    expect(consoleJs).toMatch(/body: \{ code, ttlMs: selectedTtl \}/);
    expect(consoleJs).toMatch(/body: \{ approvalId, namespace: inviteNamespace\(\), ttlMs: selectedTtl \}/);
  });

  it('守护生成令牌时激活 nonce（撤销旧 active）；回环提示指向高级设置而非面板编辑', () => {
    expect(serveSrc).toContain("import { activateJoinInvite, buildJoinToken } from './jointoken.mjs';");
    expect(serveSrc).toMatch(/const nonce = randomBytes\(16\)\.toString\('hex'\)/);
    expect(serveSrc).toMatch(/await activateJoinInvite\(joinStateStoragePath, nonce\)/);
    expect(serveSrc).toContain('请在「设置 → 高级 → 常驻服务」将 joinService.bind 设为 0.0.0.0');
    expect(serveSrc).toContain('邀请端点不是有效地址');
    expect(serveSrc).not.toContain('或在本面板填写新设备可达地址');
  });
});
