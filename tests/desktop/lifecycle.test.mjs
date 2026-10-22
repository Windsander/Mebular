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
import { loadDesktopI18n } from '../../apps/desktop/src/main/i18n.mjs';
import { closeAction, quitConfirm, quitDecision, trayMenuModel, trayStatusLine, daemonModeLabel, LOGIN_ITEM_ID } from '../../apps/desktop/src/main/lifecycle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// 壳层文案唯一真源 = locales/zh-CN/desktop.json；测试显式传 translator（模块本身不内置中文表）。
const zh = loadDesktopI18n({ localesDir: join(here, '..', '..', 'locales'), locale: 'zh-CN' });
const t = zh.t;
const quitConfirmT = (args) => quitConfirm(args, t);
const trayStatusLineT = (args) => trayStatusLine(args, t);
const trayMenuModelT = (args) => trayMenuModel(args, t);
const daemonModeLabelT = (mode) => daemonModeLabel(mode, t);

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
    const child = quitConfirmT({ daemonMode: 'child', hasManagedChild: true });
    expect(child.message).toContain('将停止本机 Mebular 守护');
    for (const mode of ['reused', 'service', null]) {
      const plan = quitConfirmT({ daemonMode: mode, hasManagedChild: false });
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
  const model = trayMenuModelT({ healthy: true, daemonMode: 'child', loginOpenAtLogin: false });
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
    expect(trayMenuModelT({ healthy: true, daemonMode: 'child', loginOpenAtLogin: true })
      .find((i) => i.id === LOGIN_ITEM_ID).checked).toBe(true);
  });

  it('未运行态：状态行显示未运行，启动可用', () => {
    const down = trayMenuModelT({ healthy: false, daemonMode: null, loginOpenAtLogin: false });
    expect(down.find((i) => i.id === 'status').label).toContain('未运行');
  });

  it('托盘 mode 文案：child/service/reused 映射人话，空 → 未运行（不展示裸值）', () => {
    expect(daemonModeLabelT('child')).toBe('临时运行（App 托管）');
    expect(daemonModeLabelT('service')).toBe('常驻服务');
    expect(daemonModeLabelT('reused')).toBe('已有守护');
    expect(daemonModeLabelT(null)).toBe('未运行');
    for (const [mode, text] of [['child', '临时运行（App 托管）'], ['service', '常驻服务'], ['reused', '已有守护']]) {
      const label = trayMenuModelT({ healthy: true, daemonMode: mode, loginOpenAtLogin: false })
        .find((i) => i.id === 'status').label;
      expect(label).toContain(text);
      expect(label).not.toMatch(new RegExp(`[（(]${mode}[）)]`));
      expect(label).not.toContain(` · ${mode}`);
    }
  });

  it('状态行保留圆点/运行中/启动中/未运行语义；tooltip 与菜单共用同一文案', () => {
    expect(trayStatusLineT({ healthy: true, daemonMode: 'child' })).toBe('● 运行中 · 临时运行（App 托管）');
    expect(trayStatusLineT({ healthy: false, daemonMode: 'service' })).toBe('○ 启动中 · 常驻服务');
    expect(trayStatusLineT({ healthy: false, daemonMode: null })).toBe('○ 未运行');
    expect(trayStatusLineT({ healthy: true, daemonMode: 'reused', cloudName: '云名' }))
      .toBe('● 运行中 · 已有守护 · 云名');
  });

  it('UX-2：托盘「重启向导」改名（回想入口，不再是「返回向导」）', () => {
    expect(model.find((i) => i.id === 'open-wizard').label).toBe('重启向导');
  });

  it('S3：托盘只读安全等级行（低/中/高；未知显示 — 且禁用）', () => {
    expect(model.find((i) => i.id === 'security-level').label).toBe('安全等级：—');
    expect(model.find((i) => i.id === 'security-level').enabled).toBe(false);
    for (const [level, label] of [['low', '低'], ['medium', '中'], ['high', '高']]) {
      const item = trayMenuModelT({ healthy: true, daemonMode: 'child', loginOpenAtLogin: false, securityLevel: level })
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
    const present = mainSrc.match(/function presentQuitDialog\(dialogWin, plan\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    const answer = mainSrc.match(/function onQuitDialogAnswer\(event, confirmed\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    const finish = mainSrc.match(/function finishQuitDialog\(confirmed\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(answer).toContain('event.sender !== quitDialog.webContents');
    expect(present).toContain('message: plan.message');
    expect(present).toContain('buttons: plan.buttons');
    expect(present).toContain("'quit-confirm:plan'");
    expect(finish).toContain('quitDialog.hide()');
    expect(mainSrc).toMatch(/dialogWin\.on\('close'[\s\S]{0,160}finishQuitDialog\(false\)/);
  });

  it('退出确认窗口启动时预热并复用，避免首次创建/加载延迟', () => {
    const create = mainSrc.match(/function createQuitDialog\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(mainSrc).toMatch(/createWindow\(\);[\s\S]{0,260}ensureQuitDialog\(\)/);
    expect(create).toContain('show: false');
    expect(create).toContain('alwaysOnTop: true');
    expect(create).toContain('quitDialogReady = new Promise');
    expect(create).toContain('loadFile(join(import.meta.dirname');
    expect(mainSrc).toMatch(/function ensureQuitDialog\(\) \{[\s\S]{0,120}createQuitDialog\(\)/);
  });

  it('后台退出确认：解除 App 隐藏、激活 App、切到当前 Space 并置顶', () => {
    const fn = mainSrc.match(/function bringQuitDialogToFront\(dialogWin\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('app.isHidden()');
    expect(fn).toContain('app.show()');
    expect(fn).toContain('app.focus({ steal: true })');
    expect(fn).toContain('dialogWin.moveTop()');
    expect(fn).toContain('dialogWin.focus()');
    expect(mainSrc).toContain('setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })');
  });

  it('退出确认窗口 HTML/JS：暗色对话框、取消/退出、Esc/关闭 = 取消、复用后可再次回答', () => {
    const html = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'renderer', 'quit-confirm.html'), 'utf-8');
    const js = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'renderer', 'quit-confirm.js'), 'utf-8');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('id="q-cancel"');
    expect(html).toContain('id="q-confirm"');
    expect(html).toContain("script-src 'self'");
    expect(js).toMatch(/event\.key !== 'Escape'[\s\S]{0,120}answer\(false\)/);
    expect(js).toContain('answer(true)');
    expect(js).toMatch(/onPlan\([\s\S]{0,140}answered = false/);
  });

  it('停止后窗口内横幅「守护已停止（托盘可重启）」', () => {
    expect(mainSrc).toContain("t('loading.stopped')");
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

  it('ensure() 合并 ensureDaemon 结果：存活的 App 托管 child 不被 reused 覆盖', () => {
    const fn = mainSrc.match(/async function ensure\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('reconcileManagedState({');
    expect(fn).toMatch(/existingChild: daemonChild/);
    expect(fn).toMatch(/daemonMode = managed\.mode;/);
    expect(fn).toMatch(/daemonChild = managed\.child;/);
  });

  it('child exit：立即清空托管状态并重绘托盘；旧 child 迟到事件不误伤新 child', () => {
    const fn = mainSrc.match(/function spawnChild\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain("child.on('exit'");
    expect(fn).toMatch(/if \(daemonChild !== child\) return;/);
    expect(fn).toMatch(/daemonChild = null;[\s\S]*daemonMode = null;[\s\S]*healthy = false;[\s\S]*securityLevel = null;[\s\S]*updateTray\(\)/);
  });

  it('20s 刷新会重新探测 /healthz；掉线清安全等级并更新托盘', () => {
    const fn = mainSrc.match(/async function refreshTrayStatus\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('probeHealthDetail(fetch, httpConf(), { expectedInstance: homeKey(home) })');
    expect(fn).toMatch(/healthy = false;/);
    expect(fn).toMatch(/securityLevel = null;/);
    expect(fn).toMatch(/if \(wasHealthy \|\| hadLevel\) updateTray\(\)/);
    expect(mainSrc).toMatch(/setInterval\(\(\) => \{ void refreshTrayStatus\(\); \}, 20_000\)/);
  });

  it('tooltip 与菜单共用 trayStatusLine（不展示裸 child/reused）', () => {
    expect(mainSrc).toMatch(/setToolTip\(t\('tray\.tooltip', \{ status: trayStatusLine\(\{ healthy, daemonMode, cloudName \}, t\) \}\)\)/);
  });
});
