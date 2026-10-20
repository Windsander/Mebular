#!/usr/bin/env node
// C7 验收：扫码即通（一次性令牌 + 二维码 + 委派证书 + 降级）
//
// Part A：令牌往返/验签；默认不携带任何自动授权字段；可选 securityApproval 随签名体。
// Part B：应用层 QR（qrcode-generator 普通依赖）→ 终端/SVG。
// Part C：join 服务签发委派证书；二次兑换/过期被拒；响应携带来自身份的 securityApproval。
// Part E：CLI `--qr` 与 `--token` 等价（解析层）。
//
// 用法：npm run verify:invite（前置：npm run build）

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, IdentityManager } from '@mebular/core';
import {
  buildJoinToken,
  decodeJoinToken,
  encodeJoinToken,
  verifyJoinToken,
  startJoinService,
  renderTerminalQr,
  renderSvgQr,
} from '@mebular/fleet';

let passed = 0;
let failed = 0;
const skipped = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
};
const freePort = async () => {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
};

const dir = await mkdtemp(join(tmpdir(), 'mebular-invite-'));
const master = await new IdentityManager().generateUserMasterKey();
const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
const apps = [];
const makeApp = async (deviceId, extra = {}) => {
  const app = new Mebular({
    storagePath: join(dir, `${deviceId}.jsonl`),
    deviceId,
    encryption,
    ...extra,
    sync: { autoSync: false, ...(extra.sync ?? {}) },
  });
  await app.initialize();
  apps.push(app);
  return app;
};

console.log('== verify:invite（扫码即通 / 一次性 / 委派证书 / 降级） ==');
try {
  // ---------- Part A：令牌语义 ----------
  const inviter = await makeApp('device-inviter');
  const plain = await buildJoinToken({ mebular: inviter, deviceId: 'device-inviter', namespace: 'tasks', endpoint: 'http://127.0.0.1:1', ttlMs: 60_000 });
  check('A. 默认令牌不携带认证字段（无自动授权/TTL）',
    plain.securityApproval === undefined
      && !encodeJoinToken(plain).includes('securityApproval')
      && (await verifyJoinToken(plain)).ok === true);

  const approval = {
    approvalId: 'ap-invite',
    nonce: 'nonce-invite',
    initiator: 'device-inviter',
    cosign: { v: 1, op: 'join', approver: 'device-inviter', approvalId: 'ap-invite', digest: 'd', pairingCode: '000-000', issuedAt: 1, expiresAt: 2, approverCertificateChain: [], signature: 'x' },
  };
  const withApproval = await buildJoinToken({
    mebular: inviter,
    deviceId: 'device-inviter',
    namespace: 'tasks',
    endpoint: 'http://127.0.0.1:1',
    ttlMs: 60_000,
    securityApproval: approval,
  });
  const decodedApproval = decodeJoinToken(encodeJoinToken(withApproval));
  check('A. securityApproval 可解码/可验签',
    decodedApproval.securityApproval?.approvalId === 'ap-invite' && (await verifyJoinToken(decodedApproval)).ok === true,
    { approvalId: decodedApproval.securityApproval?.approvalId });

  // ---------- Part B：二维码渲染（qrcode-generator 普通依赖） ----------
  const inline = encodeJoinToken(plain);
  const terminal = await renderTerminalQr(inline);
  const svg = await renderSvgQr(inline);
  check('B. fleet QR → 终端 + SVG 二维码产出（内容=令牌文本）',
    Boolean(terminal && svg) && terminal.value.length > 0 && svg.value.startsWith('<svg') && !svg.value.includes('mebular://'),
    { terminalKind: terminal?.kind, svgBytes: svg?.value.length });

  // ---------- Part C：兑换（委派证书 + 一次性 + 过期） ----------
  const joinerKey = new IdentityManager();
  const deviceKey = await joinerKey.generateDeviceKey('device-joiner', 'joiner');
  const joinPort = await freePort();
  const service = await startJoinService({
    mebular: inviter,
    deviceId: 'device-inviter',
    storagePath: inviter.storagePath ?? join(dir, 'device-inviter.jsonl'),
    bind: '127.0.0.1',
    port: joinPort,
    log: () => undefined,
  });
  try {
    const token = await buildJoinToken({
      mebular: inviter,
      deviceId: 'device-inviter',
      namespace: 'tasks',
      endpoint: `http://127.0.0.1:${joinPort}`,
      ttlMs: 60_000,
      securityApproval: approval,
    });
    const redeem = async (t) => {
      const res = await fetch(`http://127.0.0.1:${joinPort}/mebular/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: encodeJoinToken(t), deviceId: 'device-joiner', devicePublicKey: Buffer.from(deviceKey.publicKey).toString('hex') }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    const first = await redeem(token);
    check('C. 首次兑换：签发委派证书',
      first.status === 200 && Array.isArray(first.body?.chain) && first.body.chain.length >= 2 && first.body?.namespace === 'tasks',
      { status: first.status, chain: first.body?.chain?.length });
    check('C. 高档次订阅证明随响应返回（不在邀请方代订阅）',
      first.body?.securityApproval?.approvalId === 'ap-invite'
        && first.body?.granted === undefined,
      { approvalId: first.body?.securityApproval?.approvalId });

    const second = await redeem(token);
    check('C. 二次兑换被拒（一次性）', second.status === 403, { status: second.status, error: second.body?.error });

    const expired = await buildJoinToken({ mebular: inviter, deviceId: 'device-inviter', namespace: 'tasks', endpoint: `http://127.0.0.1:${joinPort}`, ttlMs: 1, now: Date.now() - 10_000 });
    const expiredRes = await redeem(expired);
    check('C. 过期令牌被拒', expiredRes.status === 403 && String(expiredRes.body?.error ?? '').includes('expired'), { status: expiredRes.status, error: expiredRes.body?.error });
  } finally {
    await service.close();
  }

  // ---------- Part E：CLI `--qr` 与 `--token` 等价（解析层） ----------
  const cli = await readFile(new URL('../packages/fleet/src/cli.ts', import.meta.url), 'utf-8');
  check('E. CLI：--qr 归一为 --token（同一路径）', cli.includes("if (typeof args.qr === 'string') args.token = args.qr.trim();"));
} catch (error) {
  check('verify:invite 执行', false, String(error?.stack ?? error).slice(0, 400));
} finally {
  for (const app of apps) await app.shutdown().catch(() => undefined);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

console.log('===============================');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: passed + failed, passed, failed: failed === 0 ? [] : ['see above'], skipped })}`);
process.exit(failed === 0 ? 0 : 1);
