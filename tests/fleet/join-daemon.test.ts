// W2 B2：joinWithToken 的 --daemon 路径（delegated 守护 home + fleet daemon 客户端 + 令牌）。
import { describe, it, expect, jest } from '@jest/globals';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityManager } from '@mebular/core';
import {
  encodeJoinToken,
  joinWithToken,
  fleetConfigPath,
  loadFleetConfig,
  masterKeyFingerprint,
} from '../../packages/fleet/src/index.js';

jest.setTimeout(60000);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe('W2 joinWithToken --daemon', () => {
  it('delegated 守护 home + fleet daemon 客户端 + 令牌；幂等重跑', async () => {
    const im = new IdentityManager();
    await im.generateUserMasterKey();
    const masterPub = im.getUserMasterPublicKey()!;
    await im.generateDeviceKey('device-A', 'A');
    const aCert = await im.issueDeviceCertificate('device-A');
    const aChain = im.getDeviceKey('device-A')!.certificateChain ?? [aCert];
    // 伪 invite 端点：按请求公钥签发委派证书（签名真，但 joinWithToken 只做搬运）
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c: Buffer) => (data += c.toString('utf-8')));
      req.on('end', () => {
        void (async () => {
          const body = JSON.parse(data) as { deviceId: string; devicePublicKey: string };
          const issued = await im.issueDelegatedCertificateFor(body.deviceId, body.devicePublicKey, 'device-A');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, certificate: issued.certificate, chain: issued.certificateChain, namespace: 'tasks', inviterDeviceId: 'device-A', inviterMultiaddrs: ['/ip4/127.0.0.1/tcp/1/p2p/x'] }));
        })();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const endpoint = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const token = encodeJoinToken({
      v: 1, kind: 'mebular-fleet-join-token',
      inviterDeviceId: 'device-A',
      inviterPublicKey: Buffer.from(im.getDeviceKey('device-A')!.publicKey).toString('hex'),
      inviterChain: aChain,
      masterPublicKey: Buffer.from(masterPub).toString('hex'),
      namespace: 'tasks', nonce: 'n1', issuedAt: 0, expiresAt: Date.now() + 60000,
      endpoint, signature: 'x',
    });
    const dir = await mkdtemp(join(tmpdir(), 'join-daemon-'));
    const daemonPort = await freePort();
    const joinPort = await freePort();
    try {
      const res = await joinWithToken({ dir, token, device: 'device-B', listen: '/ip4/127.0.0.1/tcp/0', agents: [{ name: 'echo', kind: 'echo' }], daemon: true, daemonPort, joinPort, installDaemon: async () => ({ installed: true }) });
      expect(res.awaitingApproval).toBe(true);
      expect(res.daemon?.endpoint).toBe(`http://127.0.0.1:${daemonPort}`);
      expect(res.daemon?.installed).toBe(true);
      expect(res.agentMcp).toEqual({ mcp: { mebular: { type: 'local', command: ['mebular', 'mcp'] } } });
      const daemonCfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
      expect(daemonCfg.identity.mode).toBe('delegated');
      expect(daemonCfg.encryption.userMasterPublicKeyFile).toBe(join(dir, 'user-master-key.json'));
      expect(daemonCfg.network.peers[0].device).toBe('device-A');
      expect(daemonCfg.joinService.enabled).toBe(true);
      const fleetCfg = await loadFleetConfig(fleetConfigPath(dir));
      expect(fleetCfg.store).toBe('daemon');
      expect(fleetCfg.daemon?.endpoint).toBe(`http://127.0.0.1:${daemonPort}`);
      expect(typeof fleetCfg.daemon?.token).toBe('string');
      expect(masterKeyFingerprint(new Uint8Array(Buffer.from(JSON.parse(readFileSync(join(dir, 'user-master-key.json'), 'utf-8')).publicKey, 'base64')))).toBe(res.fingerprint);
      expect(JSON.parse(readFileSync(join(dir, 'user-master-key.json'), 'utf-8')).privateKeyPkcs8).toBeUndefined();
      // 幂等：已加入目录 + 同名设备 → 不重新请求/不覆盖
      const again = await joinWithToken({ dir, token, device: 'device-B', listen: '/ip4/127.0.0.1/tcp/0', agents: [{ name: 'echo', kind: 'echo' }], daemon: true, daemonPort, joinPort });
      expect(again.alreadyJoined).toBe(true);
      expect(again.daemon?.endpoint).toBe(`http://127.0.0.1:${daemonPort}`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
