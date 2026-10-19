/* eslint-env jest */
// S2-3 门禁接线：medium 下 /admin/api/invite、/devices/:id/revoke、/security/tier 缺码 → 403；
// low 放行；high 缺会签/恢复码 → 403；GET /admin/api/security 不泄露 secret。
//
// 实现说明：serve.mjs 在 jest `--coverage` 下经 `config.mjs → @mebular/core` 的 ESM 桶会触发
// `EndpointBook` 命名导出链接错误（仅 coverage 复现，普通 npm test 绿）。故用**原生 Node 子进程**
// 启动真实 HTTP handler（tests/mcp/fixtures/security-gate-harness.mjs），保留 CSRF/状态码语义，
// 不把 serve.mjs 拉进 jest 的模块图。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HARNESS = fileURLToPath(new URL('./fixtures/security-gate-harness.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function runHarness() {
  const result = spawnSync(process.execPath, [HARNESS], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`security gate harness failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`);
  }
  const line = String(result.stdout).split('\n').find((entry) => entry.startsWith('SECURITY_GATE_RESULT '));
  if (!line) throw new Error(`security gate harness produced no result:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice('SECURITY_GATE_RESULT '.length));
}

const result = runHarness();

describe('S2-3 写端点门禁', () => {
  test('medium：invite / revoke / tier 缺码 → 403 且可读', () => {
    for (const key of ['invite', 'revoke', 'tier']) {
      expect(result.medium[key].status).toBe(403);
      expect(result.medium[key].error).toBe('totp_required');
      expect(result.medium[key].message).toMatch(/动态码/);
    }
  });

  test('medium：错码 → totp_invalid；正确码放行 tier 端点', () => {
    expect(result.medium.wrong.status).toBe(403);
    expect(['totp_invalid', 'totp_replayed']).toContain(result.medium.wrong.error);
    expect(result.medium.correct.status).toBe(200);
    expect(result.medium.correct.level).toBe('low');
    expect(result.medium.correct.applied).toBe('low');
  });

  test('low 放行；high 缺证明 → 403 approval_required', () => {
    expect(result.low.status).toBe(200);
    expect(result.low.applied).toBe('medium');
    expect(result.high.tier.status).toBe(403);
    expect(result.high.tier.error).toBe('approval_required');
    expect(result.high.tier.message).toMatch(/会签|恢复码/);
    expect(result.high.invite.status).toBe(403);
    expect(result.high.invite.error).toBe('approval_required');
  });

  test('GET /admin/api/security 返回档位/种子/恢复码状态（不泄露 secret）', () => {
    expect(result.read.status).toBe(200);
    expect(result.read.level).toBe('medium');
    expect(result.read.imported).toBe(true);
    expect(result.read.fingerprint).toBe(result.read.expectedFingerprint);
    expect(result.read.leaksSecret).toBe(false);
    expect(result.read.recoveryRegistered).toBe(false);
    expect(result.read.pendingIsArray).toBe(true);
  });

  test('批准请求 / 待批准 / 批准 / 拒绝', () => {
    expect(result.approvals.pendingSeen).toBe(true);
    expect(result.approvals.approvedStatus).toBe(200);
    expect(result.approvals.approvedApprovalId).toBe('approval-approve');
    expect(result.approvals.signatureLength).toBeGreaterThan(0);
    expect(result.approvals.deniedStatus).toBe(200);
    expect(result.approvals.deniedDecision).toBe('deny');
  });

  test('TOTP 分发/导入端点；恢复码生成/轮换端点', () => {
    const r = result.totpRecovery;
    expect(r.importStatus).toBe(200);
    expect(r.fingerprintLength).toBe(8);
    expect(r.noCodeStatus).toBe(403);
    expect(r.noCodeError).toBe('totp_required');
    expect(r.showStatus).toBe(200);
    expect(r.showSecretMatches).toBe(true);
    expect(r.showOtpauth).toBe(true);
    expect(r.generatedStatus).toBe(201);
    expect(r.generatedShownOnce).toBe(true);
    expect(r.rotatedStatus).toBe(200);
    expect(r.keyChanged).toBe(true);
    expect(r.staleStatus).toBe(403);
    expect(r.staleError).toBe('recovery_mismatch');
    expect(r.recoveryRegistered).toBe(true);
    expect(r.recoveryKeyMatches).toBe(true);
    expect(r.leaksGeneratedCode).toBe(false);
    expect(r.leaksRotatedCode).toBe(false);
  });
});
