// S2-3 HTTP 门禁夹具：在**原生 Node 进程**里启动 serve 的 HTTP handler。
//
// 为什么不在 jest 里静态 import `serve.mjs`：`serve.mjs → config.mjs → @mebular/core`
// 的 ESM 桶在 jest `--coverage` 下会触发 `EndpointBook` 命名导出链接错误（仅 coverage 复现）。
// 本夹具由 `tests/mcp/security-gate.test.mjs` spawn，保留真实 HTTP/CSRF/状态码语义。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../../../packages/mcp/src/serve.mjs';

const fleet = await import('../../../packages/fleet/dist/index.js');

function makeApp(level, options = {}) {
  const calls = { tier: [], revoke: [] };
  const events = [];
  if (options.recovery) {
    events.push({
      id: 'policy-event-recovery-seed',
      timestamp: Date.now() - 60_000,
      author: 'device-A',
      type: 'security_recovery',
      data: {
        securityRecovery: {
          keyId: options.recovery.keyId,
          publicKey: options.recovery.publicKeyHex,
          createdAt: Date.now() - 60_000,
          mode: 'set',
        },
      },
    });
  }
  return {
    deviceId: 'device-A',
    calls,
    events,
    getSecurityTier: async () => ({
      level,
      admitted: ['device-A', 'device-B'],
      rejections: [],
      ...(options.recovery ? { recoveryKeyId: options.recovery.keyId } : {}),
    }),
    setSecurityTier: async (input) => {
      calls.tier.push(input);
      return { id: 'tier-event', data: {} };
    },
    getBlockedDevices: async () => [],
    revokeDevice: async (input) => {
      calls.revoke.push(input);
      return { id: 'revoke-event', data: {} };
    },
    eventLog: {
      append: async (input) => {
        const event = { id: `policy-event-${events.length + 1}`, timestamp: Date.now(), author: 'device-A', ...input };
        events.push(event);
        return event;
      },
      listEvents: async () => events,
    },
    identity: { getDeviceKey: () => undefined },
  };
}

async function start(level, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'security-gate-harness-'));
  const app = makeApp(level, options);
  const server = await startHttpServer({
    home,
    app,
    service: { status: async () => ({ running: false }) },
    config: {},
    buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
    host: '127.0.0.1',
    port: 0,
    auth: 'none',
    writesEnabled: true,
    namespace: 'tasks',
  });
  const base = `http://127.0.0.1:${server.port}`;
  const page = await fetch(`${base}/console/`);
  const csrf = page.headers.get('x-mebular-csrf');
  const setCookie = page.headers.getSetCookie().find((value) => value.startsWith('mebular_csrf='));
  const cookie = setCookie.split(';')[0];
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie, origin: base },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { cookie } });
    return { status: res.status, body: await res.json() };
  };
  const close = async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
  };
  return { home, app, base, cookie, csrf, post, get, close };
}

const out = {};

// 1) medium：三个写端点缺码 → 403；错码；正确码
{
  const s = await start('medium');
  try {
    out.medium = {};
    for (const [name, path, body] of [
      ['invite', '/admin/api/invite', {}],
      ['revoke', '/admin/api/devices/device-B/revoke', {}],
      ['tier', '/admin/api/security/tier', { level: 'low' }],
    ]) {
      const res = await s.post(path, body);
      out.medium[name] = { status: res.status, error: res.body.error, message: res.body.message };
    }
    const secret = fleet.generateTotpSecret();
    await fleet.writeTotpSeed(s.home, secret);
    const wrong = await s.post('/admin/api/security/tier', { level: 'low', code: '000000' });
    out.medium.wrong = { status: wrong.status, error: wrong.body.error };
    const code = fleet.totpCodeAt(secret, Math.floor(Date.now() / 30_000));
    const ok = await s.post('/admin/api/security/tier', { level: 'low', code });
    out.medium.correct = { status: ok.status, level: ok.body.level, applied: s.app.calls.tier.at(-1)?.level };
  } finally {
    await s.close();
  }
}

// 2) low 放行
{
  const s = await start('low');
  try {
    const res = await s.post('/admin/api/security/tier', { level: 'medium' });
    out.low = { status: res.status, level: res.body.level, applied: s.app.calls.tier.at(-1)?.level };
  } finally {
    await s.close();
  }
}

// 3) high 缺证明 → approval_required
{
  const s = await start('high');
  try {
    const tier = await s.post('/admin/api/security/tier', { level: 'low' });
    const invite = await s.post('/admin/api/invite', {});
    out.high = {
      tier: { status: tier.status, error: tier.body.error, message: tier.body.message },
      invite: { status: invite.status, error: invite.body.error },
    };
  } finally {
    await s.close();
  }
}

// 4) GET /admin/api/security 不泄露 secret
{
  const s = await start('medium');
  try {
    const secret = fleet.generateTotpSecret();
    const seed = await fleet.writeTotpSeed(s.home, secret);
    const res = await s.get('/admin/api/security');
    out.read = {
      status: res.status,
      level: res.body.level,
      imported: res.body.totp?.imported,
      fingerprint: res.body.totp?.fingerprint,
      expectedFingerprint: seed.fingerprint,
      leaksSecret: JSON.stringify(res.body).includes(secret),
      recoveryRegistered: res.body.recovery?.registered,
      pendingIsArray: Array.isArray(res.body.pendingApprovals),
    };
  } finally {
    await s.close();
  }
}

// 5) 批准请求 / 待批准 / 批准 / 拒绝
{
  const s = await start('low');
  try {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    s.app.identity = { getDeviceKey: () => ({ privateKey: keyPair.privateKey, certificateChain: [] }) };
    const digest = fleet.securityActionDigest({ op: 'kick', initiator: 'device-B', subject: 'device-C', nonce: 'n-approve' });
    s.app.events.push({
      id: 'req-approve',
      type: 'security_approval',
      timestamp: Date.now(),
      data: {
        securityApproval: {
          approvalId: 'approval-approve', op: 'kick', decision: 'request', initiator: 'device-B',
          target: 'device-C', nonce: 'n-approve', digest,
          pairingCode: fleet.pairingCodeForDigest(digest),
          expiresAt: Date.now() + 60_000, issuedAt: Date.now(),
        },
      },
    });
    const pending = await s.get('/admin/api/security');
    const approved = await s.post('/admin/api/security/approvals/approval-approve/approve', {});
    const digest2 = fleet.securityActionDigest({ op: 'tier', initiator: 'device-B', level: 'low', nonce: 'n-deny' });
    s.app.events.push({
      id: 'req-deny',
      type: 'security_approval',
      timestamp: Date.now(),
      data: {
        securityApproval: {
          approvalId: 'approval-deny', op: 'tier', decision: 'request', initiator: 'device-B', level: 'low',
          nonce: 'n-deny', digest: digest2, pairingCode: fleet.pairingCodeForDigest(digest2),
          expiresAt: Date.now() + 60_000, issuedAt: Date.now(),
        },
      },
    });
    const denied = await s.post('/admin/api/security/approvals/approval-deny/deny', {});
    out.approvals = {
      pendingSeen: pending.body.pendingApprovals.some((entry) => entry.approvalId === 'approval-approve'),
      approvedStatus: approved.status,
      approvedApprovalId: approved.body.cosign?.approvalId,
      signatureLength: approved.body.cosign?.signature?.length ?? 0,
      deniedStatus: denied.status,
      deniedDecision: denied.body.decision,
    };
  } finally {
    await s.close();
  }
}

// 6) TOTP 分发/导入 + 恢复码生成/轮换
{
  const s = await start('low');
  try {
    const secret = fleet.generateTotpSecret();
    const imported = await s.post('/admin/api/security/totp/import', { secret });
    const noCode = await s.post('/admin/api/security/totp/show', {});
    const code = fleet.totpCodeAt(secret, Math.floor(Date.now() / 30_000));
    const shown = await s.post('/admin/api/security/totp/show', { code });
    const generated = await s.post('/admin/api/security/recovery/generate', {});
    const rotated = await s.post('/admin/api/security/recovery/rotate', { oldCode: generated.body.code });
    const stale = await s.post('/admin/api/security/recovery/rotate', { oldCode: generated.body.code });
    const read = await s.get('/admin/api/security');
    out.totpRecovery = {
      importStatus: imported.status,
      fingerprintLength: imported.body.fingerprint?.length ?? 0,
      noCodeStatus: noCode.status,
      noCodeError: noCode.body.error,
      showStatus: shown.status,
      showSecretMatches: shown.body.secret === secret,
      showOtpauth: typeof shown.body.otpauth === 'string' && shown.body.otpauth.startsWith('otpauth://totp/'),
      generatedStatus: generated.status,
      generatedShownOnce: generated.body.shownOnce,
      rotatedStatus: rotated.status,
      keyChanged: rotated.body.keyId !== generated.body.keyId,
      staleStatus: stale.status,
      staleError: stale.body.error,
      recoveryRegistered: read.body.recovery?.registered,
      recoveryKeyMatches: read.body.recovery?.keyId === rotated.body.keyId,
      leaksGeneratedCode: JSON.stringify(read.body).includes(generated.body.code),
      leaksRotatedCode: JSON.stringify(read.body).includes(rotated.body.code),
    };
  } finally {
    await s.close();
  }
}

// 7) S4：高档恢复码代签（踢人 / 降档）+ 错误人话 + 无码泄露
{
  const material = fleet.generateRecoveryCode();
  const s = await start('high', { recovery: material });
  try {
    const wrongCode = fleet.generateRecoveryCode().code;
    const wrong = await s.post('/admin/api/devices/device-B/revoke', { recoveryCode: wrongCode, note: 'S4 wrong' });
    const ok = await s.post('/admin/api/devices/device-B/revoke', { recoveryCode: material.code, note: 'S4 kick' });
    const record = s.app.events.find((entry) => entry.type === 'device_revoke')?.data?.deviceRevoke;
    const expectedDigest = record?.breakGlass?.nonce
      ? fleet.securityActionDigest({ op: 'kick', initiator: 'device-A', subject: 'device-B', nonce: record.breakGlass.nonce })
      : '';
    const signatureCheck = record?.breakGlass
      ? fleet.verifyBreakGlassProof(record.breakGlass, {
        publicKeyHex: material.publicKeyHex,
        expectedDigest,
        currentKeyId: material.keyId,
      })
      : { ok: false };
    out.recoveryKick = {
      wrongStatus: wrong.status,
      wrongError: wrong.body.error,
      wrongLeaksCode: JSON.stringify(wrong.body).includes(wrongCode),
      okStatus: ok.status,
      okMethod: ok.body.method,
      okAuditLabel: ok.body.auditLabel,
      breakGlassKeyId: record?.breakGlass?.keyId,
      digestOk: record?.breakGlass?.digest === expectedDigest,
      signatureOk: signatureCheck.ok,
      leaksCodeResponse: JSON.stringify(ok.body).includes(material.code),
      leaksCodeEvents: JSON.stringify(s.app.events).includes(material.code),
    };
  } finally {
    await s.close();
  }
}

{
  const s = await start('high');
  try {
    const material = fleet.generateRecoveryCode();
    const missing = await s.post('/admin/api/devices/device-B/revoke', { recoveryCode: material.code });
    out.recoveryMissing = {
      status: missing.status,
      error: missing.body.error,
      leaksCode: JSON.stringify(missing.body).includes(material.code),
    };
  } finally {
    await s.close();
  }
}

{
  const s = await start('medium');
  try {
    const material = fleet.generateRecoveryCode();
    const notHigh = await s.post('/admin/api/devices/device-B/revoke', { recoveryCode: material.code });
    out.recoveryNotHigh = {
      status: notHigh.status,
      error: notHigh.body.error,
      message: notHigh.body.message,
    };
  } finally {
    await s.close();
  }
}

{
  const material = fleet.generateRecoveryCode();
  const s = await start('high', { recovery: material });
  try {
    const wrong = await s.post('/admin/api/security/tier', {
      level: 'medium',
      recoveryCode: fleet.generateRecoveryCode().code,
    });
    const ok = await s.post('/admin/api/security/tier', { level: 'medium', recoveryCode: material.code });
    const record = s.app.events.find((entry) => entry.type === 'security_tier')?.data?.securityTier;
    const expectedDigest = record?.breakGlass?.nonce
      ? fleet.securityActionDigest({ op: 'tier', initiator: 'device-A', level: 'medium', nonce: record.breakGlass.nonce })
      : '';
    const signatureCheck = record?.breakGlass
      ? fleet.verifyBreakGlassProof(record.breakGlass, {
        publicKeyHex: material.publicKeyHex,
        expectedDigest,
        currentKeyId: material.keyId,
      })
      : { ok: false };
    out.recoveryTier = {
      wrongStatus: wrong.status,
      wrongError: wrong.body.error,
      okStatus: ok.status,
      okLevel: ok.body.level,
      breakGlassKeyId: record?.breakGlass?.keyId,
      digestOk: record?.breakGlass?.digest === expectedDigest,
      signatureOk: signatureCheck.ok,
      leaksCodeResponse: JSON.stringify(ok.body).includes(material.code),
      leaksCodeEvents: JSON.stringify(s.app.events).includes(material.code),
    };
  } finally {
    await s.close();
  }
}

console.log(`SECURITY_GATE_RESULT ${JSON.stringify(out)}`);
