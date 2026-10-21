// R-1 PR-A · 壳层生命周期断言（纯逻辑；不启 GUI、不动真实 launchd / 真实 home）
//
// 高-1 向导完成态跨进程持久：③done = 曾生成邀请 ∨ 已知对端≥1（真实状态推导，非内存变量）；
//       skipped/邀请标记持久化在 <home>/.desktop-state.json；完成 → 重启直达控制台。
// 高-2 关窗生命周期：关窗=隐藏（守护不动）；托盘退出=唯一真退出，确认文案仅当壳托管守护时
//       才说「将停止本机 Mebular 守护」；activate 重建/显示窗口。
// 中-9 托盘菜单分组：导航 / 守护控制（停止·重启带确认）/ 诊断 / 登录时启动 / 退出。

import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeWizardState, readDesktopState, writeDesktopState } from '../../apps/desktop/src/main/wizard.mjs';
import { closeAction, quitConfirm, quitDecision, trayMenuModel, LOGIN_ITEM_ID } from '../../apps/desktop/src/main/lifecycle.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const doneStart = { daemonHealthy: true, service: { registered: true, running: true } };

describe('R-1 高-1/UX-2 向导完成推导（跨进程持久；两段模型）', () => {
  it('UX-2：邀请标记/已知对端不再驱动完成（邀请移出引导）——仅「已完成」确认（assistantsAcked）', () => {
    const byPeers = computeWizardState({ ...doneStart, assistants: { connectedCount: 1 }, peers: { known: 1 } });
    expect(byPeers.complete).toBe(false);
    const byInvite = computeWizardState({ ...doneStart, assistants: { connectedCount: 1 }, wizard: { inviteCreated: true } });
    expect(byInvite.complete).toBe(false);
    const acked = computeWizardState({ ...doneStart, assistants: { connectedCount: 1 }, wizard: { assistantsAcked: true } });
    expect(acked.complete).toBe(true);
  });

  it('「已接入 ✓」不自动翻段：connected≥1 但未确认 → ② 不 done、不 complete', () => {
    const s = computeWizardState({ ...doneStart, assistants: { connectedCount: 1 } });
    expect(s.steps.find((x) => x.id === 'assistants').done).toBe(false);
    expect(s.complete).toBe(false);
    expect(s.current).toBe('assistants');
  });

  it('桌面状态文件读写：assistantsAcked / skipped 持久化（脏文件不炸）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mebular-desktop-state-'));
    try {
      expect(readDesktopState(home)).toEqual({});
      writeDesktopState(home, { assistantsAcked: true });
      expect(readDesktopState(home)).toMatchObject({ assistantsAcked: true });
      writeDesktopState(home, { skipped: true });
      expect(readDesktopState(home)).toMatchObject({ assistantsAcked: true, skipped: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('用户跳过 → complete（重启直达控制台，不再回向导）', () => {
    const s = computeWizardState({ ...doneStart, wizard: { skipped: true } });
    expect(s.complete).toBe(true);
    expect(s.skipped).toBe(true);
  });
});

describe('R-1 高-2 关窗生命周期（决策纯函数）', () => {
  it('未退出时关窗 → hide（守护不动）；退出中 → quit', () => {
    expect(closeAction({ quitting: false })).toBe('hide');
    expect(closeAction({ quitting: true })).toBe('quit');
  });

  it('退出确认：仅当壳确实托管守护（child）才说「将停止本机 Mebular 守护」', () => {
    const child = quitConfirm({ daemonMode: 'child', hasManagedChild: true });
    expect(child.message).toContain('将停止本机 Mebular 守护');
    for (const mode of ['reused', 'service', null]) {
      const plan = quitConfirm({ daemonMode: mode, hasManagedChild: false });
      expect(plan.message).not.toContain('将停止本机 Mebular 守护');
    }
  });

  it('退出决策：只有明确确认（true）才 quit；取消 / 关闭 / 无结果都留在 App', () => {
    expect(quitDecision({ confirmed: true })).toBe('quit');
    expect(quitDecision({ confirmed: false })).toBe('cancel');
    expect(quitDecision({})).toBe('cancel');
    expect(quitDecision()).toBe('cancel');
  });
});

describe('R-1 中-9 托盘菜单分组', () => {
  const model = trayMenuModel({ healthy: true, daemonMode: 'child', loginOpenAtLogin: false });
  const flat = model.map((i) => (i.type === 'separator' ? '|' : i.id ?? i.label));

  it('分组顺序：导航 → 守护控制 → 诊断 → 登录时启动 → 退出', () => {
    expect(flat).toEqual([
      'status', 'security-level', '|',
      'open-console', 'manage-clouds', 'connect-assistants', 'add-device', 'open-wizard', '|',
      'daemon-start', 'daemon-stop', 'daemon-restart', '|',
      'open-logs', '|',
      LOGIN_ITEM_ID, '|',
      'quit',
    ]);
  });

  it('U-1 文案：托盘邀请入口统一为「邀请设备」（id/绑定不变）', () => {
    expect(model.find((item) => item.id === 'add-device')?.label).toBe('邀请设备');
  });

  it('停止/重启带确认标志；登录时启动为 checkbox 且回显当前值', () => {
    const stop = model.find((i) => i.id === 'daemon-stop');
    const restart = model.find((i) => i.id === 'daemon-restart');
    const login = model.find((i) => i.id === LOGIN_ITEM_ID);
    expect(stop.confirm).toBe(true);
    expect(restart.confirm).toBe(true);
    expect(login.type).toBe('checkbox');
    expect(login.checked).toBe(false);
    expect(trayMenuModel({ healthy: true, daemonMode: 'child', loginOpenAtLogin: true })
      .find((i) => i.id === LOGIN_ITEM_ID).checked).toBe(true);
  });

  it('未运行态：状态行显示未运行，启动可用', () => {
    const down = trayMenuModel({ healthy: false, daemonMode: null, loginOpenAtLogin: false });
    expect(down.find((i) => i.id === 'status').label).toContain('未运行');
  });

  it('UX-2：托盘「重启向导」改名（回想入口，不再是「返回向导」）', () => {
    expect(model.find((i) => i.id === 'open-wizard').label).toBe('重启向导');
  });

  it('S3：托盘只读安全等级行（低/中/高；未知显示 — 且禁用）', () => {
    expect(model.find((i) => i.id === 'security-level').label).toBe('安全等级：—');
    expect(model.find((i) => i.id === 'security-level').enabled).toBe(false);
    for (const [level, label] of [['low', '低'], ['medium', '中'], ['high', '高']]) {
      const item = trayMenuModel({ healthy: true, daemonMode: 'child', loginOpenAtLogin: false, securityLevel: level })
        .find((i) => i.id === 'security-level');
      expect(item.label).toBe(`安全等级：${label}`);
      expect(item.enabled).toBe(true);
    }
  });
});

describe('R-1 高-2 薄壳接线（index.mjs 静态契约）', () => {
  const mainSrc = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'main', 'index.mjs'), 'utf-8');

  it('关窗被拦截为隐藏（close → preventDefault + hide），window-all-closed 不再 quit/停守护', () => {
    expect(mainSrc).toMatch(/win\.on\('close'[\s\S]*?preventDefault\(\)[\s\S]*?hide\(\)/);
    const allClosed = mainSrc.match(/window-all-closed'[\s\S]*?\}\);/)?.[0] ?? '';
    expect(allClosed).not.toMatch(/app\.quit\(\)|stopManaged/);
  });

  it('activate → 重建/显示窗口；退出确认仅在 quitConfirm 判定后设 quitting', () => {
    expect(mainSrc).toMatch(/app\.on\('activate'[\s\S]*?showWindow\(\)/);
    expect(mainSrc).toMatch(/quitConfirm\(\{ daemonMode, hasManagedChild/);
    expect(mainSrc).toMatch(/quitting = true;\s*app\.quit\(\)/);
  });

  it('退出确认不用原生 dialog：应用内窗口 + 显式决策（取消不退出，确认才退出）', () => {
    const fn = mainSrc.match(/async function confirmQuit\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).not.toContain('showMessageBox');
    expect(fn).toContain('showQuitConfirmation(plan)');
    expect(fn).toMatch(/quitDecision\(\{ confirmed \}\) !== 'quit'\) return;/);
    expect(fn.indexOf('quitting = true')).toBeGreaterThan(fn.indexOf("!== 'quit'"));
  });

  it('退出确认窗口 preload 白名单：只收 plan / 只答 answer（无任意 channel）', () => {
    const preload = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'preload', 'quit-confirm.cjs'), 'utf-8');
    expect(preload).toContain("ipcRenderer.on('quit-confirm:plan'");
    expect(preload).toContain("ipcRenderer.send('quit-confirm:answer'");
    expect(preload).not.toContain('invoke');
    expect(preload).not.toMatch(/ipcRenderer\.(on|send)\(\s*channel/);
    expect(preload).not.toMatch(/ipcRenderer\.(on|send)\([^'"]/);
  });

  it('退出确认窗口复用 quitConfirm 文案/按钮；关闭窗口 = 取消；校验 sender', () => {
    const fn = mainSrc.match(/function showQuitConfirmation\(plan\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('event.sender !== dialogWin.webContents');
    expect(fn).toContain('message: plan.message');
    expect(fn).toContain('buttons: plan.buttons');
    expect(fn).toContain("dialogWin.once('closed', () => finish(false))");
    expect(fn).toContain("'quit-confirm:plan'");
  });

  it('退出确认窗口 HTML/JS：暗色对话框、取消/退出、Esc/关闭 = 取消', () => {
    const html = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'renderer', 'quit-confirm.html'), 'utf-8');
    const js = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'renderer', 'quit-confirm.js'), 'utf-8');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('id="q-cancel"');
    expect(html).toContain('id="q-confirm"');
    expect(html).toContain("script-src 'self'");
    expect(js).toMatch(/event\.key !== 'Escape'[\s\S]{0,120}answer\(false\)/);
    expect(js).toContain('answer(true)');
  });

  it('停止后窗口内横幅「守护已停止（托盘可重启）」', () => {
    expect(mainSrc).toContain('守护已停止（托盘可重启）');
  });

  it('托盘菜单由 trayMenuModel 驱动；登录时启动走 setLoginItemSettings', () => {
    expect(mainSrc).toMatch(/trayMenuModel\(/);
    expect(mainSrc).toMatch(/setLoginItemSettings\(\{ openAtLogin/);
  });

  it('S3：托盘等级只读（probeSecurityLevel）+ 点击原地打开控制台安全卡', () => {
    const navSrc = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'main', 'console-nav.mjs'), 'utf-8');
    expect(mainSrc).toMatch(/probeSecurityLevel\(/);
    expect(mainSrc).toContain("navigateConsole('security')");
    expect(navSrc).toMatch(/focus: 'security'/);
    expect(mainSrc).toMatch(/securityLevel/);
  });
});
