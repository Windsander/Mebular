#!/usr/bin/env node
// C7 验收：扫码即通（令牌 grantOnJoin + 二维码 + 自动授权/TTL/revoke + 无 QR 库降级）
//
// Part A（令牌语义）：默认 grantOnJoin 不写签名体（与旧版本逐字节兼容）；显式关闭才写入；
//   解码/验签往返；QR 内容 = 内联令牌文本（不引自定义 scheme）。
// Part B（渲染）：真 qrcode（可选依赖在场）→ 终端/SVG 产出；注入缺失模块 → null + 告警（只给文本，不报错）。
// Part C（兑换即通，端到端）：邀请方守护 join 服务签发委派证书 **并自动授权**（作用域=令牌分区）；
//   二次兑换/过期被拒；revoke 后读侧为空；`fleet join --qr` 与 `--token` 等价（解析层）。
// Part D（TTL 台账）：applyJoinGrant/sweepAutoGrantRevokes 到期走既有 revokeGrant，撤销后读侧为空。
//
// 用法：npm run verify:invite（前置：npm run build）

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Mebular, IdentityManager } from '@mebular/core';
import {
  buildJoinToken,
  decodeJoinToken,
  encodeJoinToken,
  verifyJoinToken,
  startJoinService,
  applyJoinGrant,
  sweepAutoGrantRevokes,
  autoGrantStatePath,
  DEFAULT_GRANT_TTL_MS,
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
const skip = (label, reason) => {
  console.log(`  - SKIP ${label}：${reason}`);
  skipped.push(label);
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
    sync: { autoSync: false, policyIssuers: [deviceId], ...(extra.sync ?? {}) },
  });
  await app.initialize();
  apps.push(app);
  return app;
};

console.log('== verify:invite（扫码即通 / 自动授权 / TTL / 降级） ==');
try {
  // ---------- Part A：令牌语义 ----------
  const inviter = await makeApp('device-inviter');
  const plain = await buildJoinToken({ mebular: inviter, deviceId: 'device-inviter', namespace: 'tasks', endpoint: 'http://127.0.0.1:1', ttlMs: 60_000 });
  check('A. 默认令牌不写 grantOnJoin/grantTtlMs（与旧版本逐字节兼容）',
    plain.grantOnJoin === undefined && plain.grantTtlMs === undefined && !encodeJoinToken(plain).includes('grantOnJoin'),
    { ok: (await verifyJoinToken(plain)).ok });
  check('A. 默认语义 = 自动授权 + 24h TTL', DEFAULT_GRANT_TTL_MS === 24 * 3600_000);

  const optedOut = await buildJoinToken({ mebular: inviter, deviceId: 'device-inviter', namespace: 'tasks', endpoint: 'http://127.0.0.1:1', ttlMs: 60_000, grantOnJoin: false, grantTtlMs: 3600_000 });
  const decodedOpt = decodeJoinToken(encodeJoinToken(optedOut));
  check('A. 显式关闭才写入签名体（可解码/可验签）',
    decodedOpt.grantOnJoin === false && decodedOpt.grantTtlMs === 3600_000 && (await verifyJoinToken(decodedOpt)).ok === true,
    { grantOnJoin: decodedOpt.grantOnJoin, grantTtlMs: decodedOpt.grantTtlMs });

  // ---------- Part B：二维码渲染与降级 ----------
  const inline = encodeJoinToken(plain);
  const terminal = await renderTerminalQr(inline);
  const svg = await renderSvgQr(inline);
  if (terminal && svg) {
    check('B. 可选依赖在场 → 终端 + SVG 二维码产出（内容=令牌文本）',
      terminal.value.length > 0 && svg.value.startsWith('<svg') && !svg.value.includes('mebular://'),
      { terminalKind: terminal.kind, svgBytes: svg.value.length });
  } else {
    skip('B. 二维码渲染', '本机未安装可选依赖 qrcode（只给文本，属预期降级）');
  }

  const warnings = [];
  const missing = await renderTerminalQr(inline, { loadModule: () => { throw new Error("Cannot find module 'qrcode'"); }, onWarn: (m) => warnings.push(m) });
  check('B. 缺可选依赖 → null + 告警（只给文本，不报错）',
    missing === null && warnings.some((m) => m.includes('qrcode')), { warnings });

  // ---------- Part C：兑换即通（自动授权 + 一次性 + revoke） ----------
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
    check('C. 首次兑换：签发委派证书 + 自动授权（作用域=令牌分区）',
      first.status === 200 && first.body?.granted === true && first.body?.namespace === 'tasks',
      { status: first.status, granted: first.body?.granted, grantId: first.body?.grantId });
    check('C. 授权生效：被邀请设备的生效分区含令牌分区',
      (await inviter.getEffectiveNamespaces('device-joiner')).includes('tasks'),
      { effective: await inviter.getEffectiveNamespaces('device-joiner') });

    const second = await redeem(token);
    check('C. 二次兑换被拒（一次性）', second.status === 403, { status: second.status, error: second.body?.error });

    const expired = await buildJoinToken({ mebular: inviter, deviceId: 'device-inviter', namespace: 'tasks', endpoint: `http://127.0.0.1:${joinPort}`, ttlMs: 1, now: Date.now() - 10_000 });
    const expiredRes = await redeem(expired);
    check('C. 过期令牌被拒', expiredRes.status === 403 && String(expiredRes.body?.error ?? '').includes('expired'), { status: expiredRes.status, error: expiredRes.body?.error });

    const grants = await inviter.getEffectiveNamespaces('device-joiner');
    const grantEvent = (await inviter.eventLog.listEvents({ type: 'namespace_grant' }))
      .map((event) => event.data?.grant)
      .find((grant) => grant?.subject === 'device-joiner' && grants.includes('tasks'));
    await inviter.revokeGrant({ grantId: grantEvent.grantId, subject: 'device-joiner' });
    check('C. revoke 后读侧为空（作用域=令牌分区）',
      (await inviter.getEffectiveNamespaces('device-joiner')).length === 0,
      { effective: await inviter.getEffectiveNamespaces('device-joiner') });
  } finally {
    await service.close();
  }

  // ---------- Part D：TTL 台账（到期自动撤销） ----------
  const inviter2 = await makeApp('device-inviter-ttl');
  const tokenTtl = { namespace: 'tasks', grantTtlMs: 1_000 };
  const granted = await applyJoinGrant({ mebular: inviter2, storagePath: inviter2.storagePath ?? join(dir, 'ttl.jsonl'), token: tokenTtl, subject: 'device-guest', now: 1_000 });
  check('D. applyJoinGrant 写台账（grantId + ttlMs）', granted.granted === true && typeof granted.grantId === 'string');
  check('D. 未到期不撤销', (await sweepAutoGrantRevokes({ mebular: inviter2, storagePath: inviter2.storagePath ?? join(dir, 'ttl.jsonl'), now: 1_500 })) === 0);
  check('D. 到期自动撤销（走既有 revokeGrant）', (await sweepAutoGrantRevokes({ mebular: inviter2, storagePath: inviter2.storagePath ?? join(dir, 'ttl.jsonl'), now: 5_000 })) === 1);
  check('D. 撤销后读侧为空', (await inviter2.getEffectiveNamespaces('device-guest')).length === 0);
  const ledger = JSON.parse(await (await import('node:fs/promises')).readFile(autoGrantStatePath(inviter2.storagePath ?? join(dir, 'ttl.jsonl')), 'utf-8'));
  check('D. 台账已清理（无残留到期项）', ledger.length === 0, { ledger });

  // ---------- Part E：CLI `--qr` 与 `--token` 等价（解析层） ----------
  const cli = (await import('node:fs/promises')).readFile(new URL('../packages/fleet/src/cli.ts', import.meta.url), 'utf-8');
  check('E. CLI：--qr 归一为 --token（同一路径）', (await cli).includes("if (typeof args.qr === 'string') args.token = args.qr.trim();"));
  void createServer;
} catch (error) {
  check('verify:invite 执行', false, String(error?.stack ?? error).slice(0, 400));
} finally {
  for (const app of apps) await app.shutdown().catch(() => undefined);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

console.log('===============================');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: passed + failed, passed, failed: failed === 0 ? [] : ['see above'], skipped })}`);
process.exit(failed === 0 ? 0 : 1);
