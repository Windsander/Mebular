/* eslint-env jest */
// S2-3 门禁接线：medium 下 /admin/api/invite、/devices/:id/revoke、/security/tier 缺码 → 403；
// low 放行；high 缺会签/恢复码 → 403。直连真实 HTTP handler（CSRF 双提交同生产）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';
import {
  generateTotpSecret,
  pairingCodeForDigest,
  securityActionDigest,
  totpCodeAt,
  writeTotpSeed,
} from '../../packages/fleet/src/security.js';

function fakeApp(level) {
  const calls = { tier: [], revoke: [] };
  const events = [];
  const app = {
    deviceId: 'device-A',
    calls,
    events,
    getSecurityTier: async () => ({ level, admitted: ['device-A', 'device-B'], rejections: [] }),
    setSecurityTier: async (input) => {
      calls.tier.push(input);
      return { id: 'tier-event', data: {} };
    },
    getRevokedDevices: async () => [],
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
  return app;
}

async function withServer(level, fn) {
  const home = await mkdtemp(join(tmpdir(), 'security-gate-'));
  const app = fakeApp(level);
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
      headers: {
        'content-type': 'application/json',
        'x-mebular-csrf': csrf,
        cookie,
        origin: base,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn({ home, app, base, cookie, csrf, post });
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
}

describe('S2-3 写端点门禁', () => {
  test('medium：invite / revoke / tier 缺码 → 403 且可读', async () => {
    await withServer('medium', async ({ post }) => {
      for (const [path, body] of [
        ['/admin/api/invite', {}],
        ['/admin/api/devices/device-B/revoke', {}],
        ['/admin/api/security/tier', { level: 'low' }],
      ]) {
        const res = await post(path, body);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('totp_required');
        expect(res.body.message).toMatch(/动态码/);
      }
    });
  });

  test('medium：错码 → totp_invalid；正确码放行 tier 端点', async () => {
    await withServer('medium', async ({ home, app, post }) => {
      const secret = generateTotpSecret();
      await writeTotpSeed(home, secret);
      const wrong = await post('/admin/api/security/tier', { level: 'low', code: '000000' });
      expect(wrong.status).toBe(403);
      expect(['totp_invalid', 'totp_replayed']).toContain(wrong.body.error);
      const code = totpCodeAt(secret, Math.floor(Date.now() / 30_000));
      const ok = await post('/admin/api/security/tier', { level: 'low', code });
      expect(ok.status).toBe(200);
      expect(ok.body.level).toBe('low');
      expect(app.calls.tier.at(-1)?.level).toBe('low');
    });
  });

  test('low 放行；high 缺证明 → 403 approval_required', async () => {
    await withServer('low', async ({ app, post }) => {
      const res = await post('/admin/api/security/tier', { level: 'medium' });
      expect(res.status).toBe(200);
      expect(app.calls.tier.at(-1)?.level).toBe('medium');
    });
    await withServer('high', async ({ post }) => {
      const res = await post('/admin/api/security/tier', { level: 'low' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('approval_required');
      expect(res.body.message).toMatch(/会签|恢复码/);
      const invite = await post('/admin/api/invite', {});
      expect(invite.status).toBe(403);
      expect(invite.body.error).toBe('approval_required');
    });
  });

  test('GET /admin/api/security 返回档位/种子/恢复码状态（不泄露 secret）', async () => {
    await withServer('medium', async ({ home, base, cookie }) => {
      const secret = generateTotpSecret();
      const seed = await writeTotpSeed(home, secret);
      const res = await fetch(`${base}/admin/api/security`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.level).toBe('medium');
      expect(body.totp.imported).toBe(true);
      expect(body.totp.fingerprint).toBe(seed.fingerprint);
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(body.recovery.registered).toBe(false);
      expect(Array.isArray(body.pendingApprovals)).toBe(true);
    });
  });

  test('批准请求 / 待批准 / 批准 / 拒绝', async () => {
    await withServer('low', async ({ app, base, cookie, post }) => {
      const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      app.identity = {
        getDeviceKey: () => ({ privateKey: keyPair.privateKey, certificateChain: [] }),
      };
      const digest = securityActionDigest({ op: 'kick', initiator: 'device-B', subject: 'device-C', nonce: 'n-approve' });
      const request = {
        approvalId: 'approval-approve',
        op: 'kick',
        decision: 'request',
        initiator: 'device-B',
        target: 'device-C',
        nonce: 'n-approve',
        digest,
        pairingCode: pairingCodeForDigest(digest),
        expiresAt: Date.now() + 60_000,
        issuedAt: Date.now(),
      };
      app.events.push({ id: 'req-approve', type: 'security_approval', timestamp: Date.now(), data: { securityApproval: request } });

      const pending = await fetch(`${base}/admin/api/security`, { headers: { cookie } });
      const pendingBody = await pending.json();
      expect(pendingBody.pendingApprovals.some((entry) => entry.approvalId === 'approval-approve')).toBe(true);

      const approved = await post('/admin/api/security/approvals/approval-approve/approve', {});
      expect(approved.status).toBe(200);
      expect(approved.body.cosign.approvalId).toBe('approval-approve');
      expect(approved.body.cosign.signature.length).toBeGreaterThan(0);

      const digest2 = securityActionDigest({ op: 'tier', initiator: 'device-B', level: 'low', nonce: 'n-deny' });
      app.events.push({
        id: 'req-deny',
        type: 'security_approval',
        timestamp: Date.now(),
        data: {
          securityApproval: {
            approvalId: 'approval-deny',
            op: 'tier',
            decision: 'request',
            initiator: 'device-B',
            level: 'low',
            nonce: 'n-deny',
            digest: digest2,
            pairingCode: pairingCodeForDigest(digest2),
            expiresAt: Date.now() + 60_000,
            issuedAt: Date.now(),
          },
        },
      });
      const denied = await post('/admin/api/security/approvals/approval-deny/deny', {});
      expect(denied.status).toBe(200);
      expect(denied.body.decision).toBe('deny');
    });
  });

  test('TOTP 分发/导入端点；恢复码生成/轮换端点', async () => {
    await withServer('low', async ({ base, cookie, post }) => {
      const secret = generateTotpSecret();
      const imported = await post('/admin/api/security/totp/import', { secret });
      expect(imported.status).toBe(200);
      expect(imported.body.fingerprint).toHaveLength(8);
      const noCode = await post('/admin/api/security/totp/show', {});
      expect(noCode.status).toBe(403);
      expect(noCode.body.error).toBe('totp_required');
      const code = totpCodeAt(secret, Math.floor(Date.now() / 30_000));
      const shown = await post('/admin/api/security/totp/show', { code });
      expect(shown.status).toBe(200);
      expect(shown.body.secret).toBe(secret);
      expect(shown.body.otpauth).toContain('otpauth://totp/');

      const generated = await post('/admin/api/security/recovery/generate', {});
      expect(generated.status).toBe(201);
      expect(generated.body.shownOnce).toBe(true);
      const rotated = await post('/admin/api/security/recovery/rotate', { oldCode: generated.body.code });
      expect(rotated.status).toBe(200);
      expect(rotated.body.keyId).not.toBe(generated.body.keyId);
      const stale = await post('/admin/api/security/recovery/rotate', { oldCode: generated.body.code });
      expect(stale.status).toBe(403);
      expect(stale.body.error).toBe('recovery_mismatch');
      // 恢复码状态可读，且不泄露 code
      const res = await fetch(`${base}/admin/api/security`, { headers: { cookie } });
      const body = await res.json();
      expect(body.recovery.registered).toBe(true);
      expect(body.recovery.keyId).toBe(rotated.body.keyId);
      expect(JSON.stringify(body)).not.toContain(generated.body.code);
      expect(JSON.stringify(body)).not.toContain(rotated.body.code);
    });
  });
});
