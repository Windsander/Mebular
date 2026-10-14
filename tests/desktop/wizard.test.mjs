// M2/UX-2：两段向导 / 日志脱敏 / 邀请构造 / 段②行级接入 API 单元测试（纯逻辑，不启 GUI、不真发邀请）

import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WIZARD_STEPS,
  computeWizardState,
  deepLinks,
  isLoopbackUrl,
  invitePlan,
  parseInviteOutput,
  inviteText,
  redactLog,
  tailText,
  clientsViaApi,
  clientActionViaApi,
} from '../../apps/desktop/src/main/wizard.mjs';
import { readDaemonLogs } from '../../apps/desktop/src/main/logs.mjs';

const http = { host: '127.0.0.1', port: 7331 };

describe('M2/UX-2 向导：状态机（两段；幂等可重入，逐步检测）', () => {
  it('无守护 → current=start；守护健康 → 前进到 assistants', () => {
    const s0 = computeWizardState({ daemonHealthy: false });
    expect(s0.current).toBe('start');
    expect(s0.complete).toBe(false);
    const s1 = computeWizardState({ daemonHealthy: true, service: { registered: false, running: true, autostart: null } });
    expect(s1.steps[0].done).toBe(true);
    expect(s1.current).toBe('assistants');
  });

  it('UX-2：已接入 ≥1 不自动翻段——仅解锁「已完成」；显式确认（assistantsAcked）才 complete', () => {
    const connected = computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 2, total: 7 } });
    expect(connected.current).toBe('assistants');
    expect(connected.complete).toBe(false);
    expect(connected.steps[1].detail).toMatchObject({ connectedCount: 2, total: 7 });
    const acked = computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 1 }, wizard: { assistantsAcked: true } });
    expect(acked.complete).toBe(true);
    expect(acked.current).toBeNull();
  });

  it('UX-2：邀请不再参与完成推导（邀请移出引导，归控制台单动作页）', () => {
    const s = computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 0 }, invite: { created: true }, peers: { known: 3 } });
    expect(s.complete).toBe(false);
    expect(s.steps.map((x) => x.id)).toEqual(['start', 'assistants']);
  });

  it('步骤顺序固定为 start→assistants（两段）', () => {
    expect(WIZARD_STEPS).toEqual(['start', 'assistants']);
    const s = computeWizardState({ daemonHealthy: true, wizard: { assistantsAcked: true } });
    expect(s.steps.map((x) => x.id)).toEqual(['start', 'assistants']);
  });

  it('段① detail 携带 healthy（子步骤流水静态进度用）', () => {
    expect(computeWizardState({ daemonHealthy: true }).steps[0].detail.healthy).toBe(true);
    expect(computeWizardState({ daemonHealthy: false }).steps[0].detail.healthy).toBe(false);
  });
});

describe('UX-2 段②行级接入：clientsViaApi / clientActionViaApi（假 fetch，不真发）', () => {
  it('clientsViaApi：200 → clients 数组；非 200/异常 → warning 不阻断', async () => {
    const ok = await clientsViaApi(async () => ({ ok: true, status: 200, json: async () => ({ clients: [{ id: 'opencode' }] }) }), http);
    expect(ok).toEqual({ ok: true, clients: [{ id: 'opencode' }] });
    const bad = await clientsViaApi(async () => ({ ok: false, status: 500, json: async () => ({}) }), http);
    expect(bad.ok).toBe(false);
    expect(bad.warning).toMatch(/500/);
    const err = await clientsViaApi(async () => { throw new Error('ECONNREFUSED'); }, http);
    expect(err.ok).toBe(false);
    expect(err.warning).toMatch(/ECONNREFUSED/);
  });

  it('clientActionViaApi：CSRF 预取 + POST；id/action 白名单外直接拒（防路径注入）', async () => {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      calls.push({ url, method: opts.method ?? 'GET', csrf: opts.headers?.['x-mebular-csrf'] ?? null });
      if (calls.length === 1) return { headers: { get: () => 'CSRF1' } };
      return { ok: true, status: 200, json: async () => ({ ok: true, changed: true }) };
    };
    const res = await clientActionViaApi(fetchImpl, http, 'opencode', 'connect');
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(calls[1].url).toContain('/admin/api/clients/opencode/connect');
    expect(calls[1].method).toBe('POST');
    expect(calls[1].csrf).toBe('CSRF1');
    const evil = await clientActionViaApi(fetchImpl, http, '../admin', 'connect');
    expect(evil.ok).toBe(false);
    const evilAct = await clientActionViaApi(fetchImpl, http, 'opencode', 'rollback');
    expect(evilAct.ok).toBe(false);
  });

  it('clientActionViaApi：422 needsManual 透传；网络异常 → warning', async () => {
    const manual = await clientActionViaApi(async () => ({ ok: false, status: 422, json: async () => ({ needsManual: true, reason: '配置无法解析' }) }), http, 'cursor', 'connect');
    expect(manual).toMatchObject({ ok: false, needsManual: true });
    expect(manual.warning).toMatch(/配置无法解析/);
    const err = await clientActionViaApi(async () => { throw new Error('boom'); }, http, 'cursor', 'connect');
    expect(err.ok).toBe(false);
    expect(err.warning).toMatch(/boom/);
  });
});

describe('M2 向导：深链（仅回环）', () => {
  it('构造控制台/连接助手/添加设备深链', () => {
    const links = deepLinks(http);
    expect(links.console).toBe('http://127.0.0.1:7331/console');
    expect(links.assistants).toContain('/console?view=connect');
    expect(links.device).toContain('step=device');
  });
  it('isLoopbackUrl：只接受 127.0.0.1（拒绝外站/其他主机）', () => {
    expect(isLoopbackUrl('http://127.0.0.1:7331/console')).toBe(true);
    expect(isLoopbackUrl('https://127.0.0.1/x')).toBe(true);
    expect(isLoopbackUrl('http://evil.example/x')).toBe(false);
    expect(isLoopbackUrl('http://localhost:7331/x')).toBe(false);
    expect(isLoopbackUrl('http://127.0.0.1.evil.com/x')).toBe(false);
  });
});

describe('M2 向导：邀请构造与解析（不真发）', () => {
  it('invitePlan 只构造命令（node fleet-cli invite --dir <home>）', () => {
    const plan = invitePlan({ fleetBin: '/repo/packages/fleet/dist/cli.js', home: '/h', device: 'device-A' });
    expect(plan.command).toBe(process.execPath);
    expect(plan.args).toEqual(['/repo/packages/fleet/dist/cli.js', 'invite', '--dir', '/h', '--device', 'device-A']);
    expect(plan.cwd).toBe('/h');
    const noDevice = invitePlan({ fleetBin: '/b.js', home: '/h' });
    expect(noDevice.args).toEqual(['/b.js', 'invite', '--dir', '/h']);
  });

  it('parseInviteOutput：取最后一个 JSON 行（QR/文本/端点）', () => {
    const out = 'log line\n{"ok":true,"token":"TOK123","qrSvg":"<svg/>","endpoint":"http://127.0.0.1:4002"}\n';
    expect(parseInviteOutput(out)).toEqual({ token: 'TOK123', qrSvg: '<svg/>', endpoint: 'http://127.0.0.1:4002', warning: null });
    expect(parseInviteOutput('no json here')).toMatchObject({ token: null, qrSvg: null });
    // qrcode 缺失：warning + 无 svg（仍给文本令牌）
    const noQr = parseInviteOutput('{"token":"T","qrSvg":null,"warning":"缺少 qrcode：只给文本令牌"}');
    expect(noQr.qrSvg).toBeNull();
    expect(noQr.warning).toMatch(/qrcode/);
  });

  it('inviteText：文本令牌兜底（含端点）', () => {
    expect(inviteText({ token: 'T', endpoint: 'http://127.0.0.1:4002' })).toContain('T');
    expect(inviteText({ token: 'T', endpoint: 'http://127.0.0.1:4002' })).toContain('端点');
    expect(inviteText({ token: null })).toBeNull();
  });
});

describe('M2 日志页：脱敏 + 回退', () => {
  it('redactLog：结构化键 / Bearer / meb_ 令牌 / 签名 全被抹掉；普通文本保留', () => {
    const raw = [
      '{"accessToken":"aaaa.bbbb.cccc","privateKeyPkcs8":"MIIabc==","note":"keep-this"}',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'joining with meb_AbCdEf123456',
      '{"signature":"deadbeefcafe"}',
    ].join('\n');
    const out = redactLog(raw);
    expect(out).not.toContain('aaaa.bbbb.cccc');
    expect(out).not.toContain('MIIabc==');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('meb_AbCdEf123456');
    expect(out).not.toContain('deadbeefcafe');
    expect(out).toContain('keep-this');
    expect(out).toMatch(/\[redacted\]/);
  });

  it('tailText：取末尾 N 行（去尾部空行）', () => {
    expect(tailText('a\nb\nc\n\n', 2)).toBe('b\nc');
  });

  it('readDaemonLogs：优先服务日志；无服务 → serve.log 兜底（且脱敏）；都没有 → none', async () => {
    const home = await mkdtemp(join(tmpdir(), 'm2-logs-'));
    try {
      const svc = { serviceLogs: () => ({ stdoutLog: '/l/out', stderrLog: '/l/err', stdout: ['token=SECRETVALUE'], stderr: [] }) };
      const fromService = await readDaemonLogs({ home, service: svc, descriptor: { kind: 'mebular-serve' }, readFileImpl: async () => { throw new Error('no file'); } });
      expect(fromService.source).toBe('service');
      expect(fromService.text).not.toContain('SECRETVALUE');
      expect(fromService.paths.stdout).toBe('/l/out');

      const noService = await readDaemonLogs({ home, service: null, descriptor: null, readFileImpl: async () => 'boot ok\nBearer zzzz.token.value\n' });
      expect(noService.source).toBe('file');
      expect(noService.text).toContain('boot ok');
      expect(noService.text).not.toContain('zzzz.token.value');

      const none = await readDaemonLogs({ home, service: null, descriptor: null, readFileImpl: async () => { throw new Error('ENOENT'); } });
      expect(none.source).toBe('none');

      // 服务日志**为空**（未安装常驻）→ 回退 <home>/serve.log
      const emptySvc = { serviceLogs: () => ({ stdoutLog: '/l/out', stderrLog: '/l/err', stdout: [], stderr: [] }) };
      const fallback = await readDaemonLogs({ home, service: emptySvc, descriptor: { kind: 'mebular-serve' }, readFileImpl: async () => 'PROVISION_READY {"home":"/h"}\n' });
      expect(fallback.source).toBe('file');
      expect(fallback.text).toContain('PROVISION_READY');

      // 真实文件路径兜底（走默认 readFile）
      await writeFile(join(home, 'serve.log'), 'PROVISION_READY {"home":"/h"}\n', 'utf-8');
      const real = await readDaemonLogs({ home });
      expect(real.source).toBe('file');
      expect(real.text).toContain('PROVISION_READY');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
