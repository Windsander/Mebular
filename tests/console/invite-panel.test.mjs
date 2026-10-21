// 邀请面板：两栏精简（左 QR / 右引导 + 令牌 + TTL），右上角 X 关闭；不再堆说明段落。
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
const indexHtml = readFileSync(join(root, 'packages', 'console', 'index.html'), 'utf-8');
const serveSrc = readFileSync(join(root, 'packages', 'mcp', 'src', 'serve.mjs'), 'utf-8');

function invitePanelSource() {
  const start = consoleJs.indexOf('function showInviteResult');
  const end = consoleJs.indexOf("$('#invite-device')", start);
  return start >= 0 && end > start ? consoleJs.slice(start, end) : '';
}

describe('邀请面板 · TTL 档位与两栏结构', () => {
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

  it('两栏结构：左二维码（150–160px），右引导 + 令牌 + TTL 控件', () => {
    const panel = invitePanelSource();
    expect(panel).toContain('class="invite-layout"');
    expect(panel).toContain('class="invite-qr"');
    expect(panel).toContain('class="invite-main"');
    expect(panel).toContain('扫码加入，或复制令牌发给对方。');
    expect(panel).toContain('class="invite-token-block"');
    expect(panel).toContain('一次性令牌');
    expect(panel).toContain('data-copy=');
    expect(panel).toContain('qrSvg');
    expect(panel).toContain('id="invite-ttl"');
    expect(panel).toContain('id="invite-regenerate"');
    expect(panel).toContain('id="invite-expiry"');
    expect(panel).toContain('inviteExpiryLabel(selectedTtl)');
    expect(panel).toContain('INVITE_TTL_OPTIONS');
    expect(panel).toContain('class="btn btn-small btn-primary invite-copy"');
    expect(panel).toContain('class="btn btn-small invite-regenerate"');
    expect((panel.match(/btn-primary/g) ?? []).length).toBe(1);
    const css = readFileSync(join(root, 'packages', 'console', 'console.css'), 'utf-8');
    expect(css).toMatch(/\.qr-img \{[^}]*width: 15[0-9]px[^}]*height: 15[0-9]px/);
    expect(css).toMatch(/\.invite-layout \{[^}]*grid-template-columns: 156px minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.invite-token-block \{[^}]*border: 1px solid var\(--border\)/);
    expect(css).toMatch(/@media \(max-width: 520px\) \{\s*\.invite-layout \{ grid-template-columns: minmax\(0, 1fr\)/);
  });

  it('细节段落已移除：无「对方已用过 / 新设备 / 当前令牌有效至 / 改档后点 / 令牌即入网权限 / 扫码即通」', () => {
    const panel = invitePanelSource();
    const removed = [
      '对方已用过',
      '新设备',
      '当前令牌有效至',
      '改档后点',
      '令牌即入网权限',
      '扫码即通',
      '本忆云',
      'QR 内容 = 令牌文本',
    ];
    for (const text of removed) expect(panel).not.toContain(text);
    expect(panel).toContain('一次性 · 仅当面或可信局域网传递。');
  });

  it('底部一行忆云身份 + 一行安全提示；端点/会签只留短警告', () => {
    const panel = invitePanelSource();
    expect(panel).toContain('id="invite-cloud-identity"');
    expect(panel).toContain('根指纹');
    expect(panel).toContain('端点仅本机可达');
    expect(panel).toContain('已带上会签批准。');
    expect(panel).not.toContain('请在「设置 → 高级 → 常驻服务」');
  });

  it('右上角 X 关闭（复用 modal-x），无底部关闭按钮；点击清空 token', () => {
    expect(indexHtml).toMatch(/<div class="modal-head">[\s\S]*?id="invite-close"[^>]*class="modal-x"/);
    const inviteDialog = indexHtml.slice(indexHtml.indexOf('<div id="invite"'), indexHtml.indexOf('<div id="cloud-join"'));
    expect(inviteDialog).not.toContain('modal-actions');
    expect(inviteDialog).not.toContain('>关闭<');
    expect(consoleJs).toMatch(/\$\('#invite-close'\)\.addEventListener\('click',[\s\S]{0,160}\$\('#invite'\)\.hidden = true;[\s\S]{0,80}state\.inviteToken = null;/);
  });

  it('改档不自动刷新；点重新生成直接执行（无 confirmModal / window.confirm），成功后原地换结果', () => {
    const panelStart = consoleJs.indexOf('function showInviteResult');
    const changeAt = consoleJs.indexOf("body.querySelector('#invite-ttl')", panelStart);
    const regenAt = changeAt >= 0 ? consoleJs.indexOf("body.querySelector('#invite-regenerate')", changeAt) : -1;
    const changeHandler = changeAt >= 0 && regenAt > changeAt ? consoleJs.slice(changeAt, regenAt) : '';
    expect(changeHandler.length).toBeGreaterThan(0);
    expect(changeHandler).not.toMatch(/openInvite\(|renderInvite\(|api\(/);
    expect(changeHandler).toContain('state.inviteTtlMs = value');
    expect(changeHandler).toContain("expiry.textContent = inviteExpiryLabel(value)");

    expect(invitePanelSource()).not.toContain('window.confirm');
    expect(consoleJs).not.toContain('重新生成令牌？');
    const regenHandler = regenAt >= 0 ? consoleJs.slice(regenAt, regenAt + 700) : '';
    expect(regenHandler).toContain("renderInvite(state.inviteTtlMs, { keepPanel: true })");
    expect(regenHandler).not.toContain('confirmModal');
    expect(regenHandler).not.toContain('window.confirm');
    expect(consoleJs).toContain('已重新生成，旧令牌已失效');
    expect(consoleJs).toContain('换新令牌后旧的立即失效，已发出的邀请将无法再兑换。');
    expect(consoleJs).toMatch(/async function renderInvite\(ttlMs = state\.inviteTtlMs, \{ keepPanel = false \} = \{\}\)/);
    expect(consoleJs).toMatch(/body\.classList\.add\('is-busy'\)/);
    expect(consoleJs).toMatch(/body\.setAttribute\('aria-busy', 'true'\)/);
    expect(consoleJs).toContain("button.textContent = '正在更新…'");
    expect(consoleJs).toContain('重新生成失败：');
    expect(consoleJs).toMatch(/async function renderInvite\(ttlMs = state\.inviteTtlMs[\s\S]{0,1800}body: \{ ttlMs \}/);
    expect(consoleJs).toMatch(/body: \{ code, ttlMs: selectedTtl \}/);
    expect(consoleJs).toMatch(/body: \{ approvalId, namespace: inviteNamespace\(\), ttlMs: selectedTtl \}/);
  });

  it('TTL 改档只更新「重新生成后至」预估，不重新生成；当前 TTL 显示现令牌到期', () => {
    const start = consoleJs.indexOf('function inviteExpiryLabel');
    const end = consoleJs.indexOf('/** 令牌结果面板', start);
    const helper = start >= 0 && end > start ? consoleJs.slice(start, end) : '';
    expect(helper.length).toBeGreaterThan(0);
    expect(helper).toContain('当前令牌至 ${formatClock(current.expiresAt)}');
    expect(helper).toContain('重新生成后至 ${formatClock(Date.now() + ttlMs)}');
    expect(helper).toContain('Number(current.ttlMs) === Number(ttlMs)');
    expect(consoleJs).not.toContain('改档后点');
  });

  it('令牌块带可见短指纹：同令牌稳定、换令牌必变；不只靠截断区分新旧', () => {
    const start = consoleJs.indexOf('function inviteTokenFingerprint');
    const end = start >= 0 ? consoleJs.indexOf('\n}', start) : -1;
    const source = start >= 0 && end > start ? consoleJs.slice(start, end + 2) : '';
    expect(source.length).toBeGreaterThan(0);
    const fingerprintOf = new Function(`${source}\nreturn inviteTokenFingerprint;`)();
    const first = 'mebular-join.v1.aaaabbbbccccddddeeeeffff00001111';
    const second = 'mebular-join.v1.aaaabbbbccccddddeeeeffff22223333';
    expect(fingerprintOf(first)).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprintOf(first)).toBe(fingerprintOf(first));
    expect(fingerprintOf(first)).not.toBe(fingerprintOf(second));

    const panel = invitePanelSource();
    expect(panel).toContain('id="invite-token-fingerprint"');
    expect(panel).toContain('令牌 #${tokenFingerprint}');
    expect(panel).toContain('const tokenFingerprint = inviteTokenFingerprint(res.token)');
    expect(panel).toContain('escapeHtml(shortToken)');
  });

  it('邀请首次打开先渲染稳定骨架（QR 占位 + 多行占位），不显示一行「正在生成令牌」小框', () => {
    const start = consoleJs.indexOf('function inviteSkeletonHtml');
    const end = consoleJs.indexOf('async function openInvite', start);
    const skeleton = start >= 0 && end > start ? consoleJs.slice(start, end) : '';
    expect(skeleton.length).toBeGreaterThan(0);
    expect(skeleton).toContain('invite-skeleton-qr');
    expect(skeleton).toContain('invite-skeleton-line-lg');
    expect((skeleton.match(/invite-skeleton-line/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(skeleton).toContain('正在生成令牌…');
    expect(skeleton).toContain('换新令牌后旧的立即失效');
    expect(consoleJs).toMatch(/body\.innerHTML = inviteSkeletonHtml\(\)/);
    const css = readFileSync(join(root, 'packages', 'console', 'console.css'), 'utf-8');
    // 高度由内容决定：不再用固定 min-height 撑底部空白；稳定性由 live 对话高度差 ≤12px 断言
    expect(css).not.toMatch(/#invite \.modal-box \{[^}]*min-height/);
    expect(css).toMatch(/\.invite-skeleton-qr \{[^}]*width: 156px[^}]*height: 156px/);
  });

  it('有效期 / 到期时刻 / 重新生成同排 flex：空间不足才换行，重新生成靠右且为次级动作', () => {
    const css = readFileSync(join(root, 'packages', 'console', 'console.css'), 'utf-8');
    expect(css).toMatch(/\.invite-controls \{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*gap: 8px 10px/);
    expect(css).toMatch(/\.invite-controls #invite-regenerate \{ margin-left: auto; \}/);
    expect(css).not.toMatch(/\.invite-controls #invite-regenerate \{[^}]*grid-column/);
    expect(css).not.toMatch(/\.invite-expiry \{[^}]*grid-column/);
    expect(css).toMatch(/\.invite-fingerprint \{[^}]*white-space: nowrap/);
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
