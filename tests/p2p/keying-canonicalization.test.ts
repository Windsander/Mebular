// P1·B2 · N1 身份规范化判别性单测：
// 握手认证成功后，会话 `peerId` 一律规范化为 `sha256hex(对端证书设备公钥)`
// （`canonicalPeerIdFromCertificate`）——与拨号键（libp2p id / deviceId / 任意注释键）
// 无关；`AuthSession.connection` 回填承载连接（N2 代际判定 / N4 队列键的依据）。
//
// 红→绿锚点：去掉握手层的 `session.peerId = canonicalPeerIdFromCertificate(...)`
// 一行 → 「拨号键不得留在会话身份里」断言失败（拨号键原样透出）。

import { describe, it, expect } from '@jest/globals';
import {
  AuthenticationHandshake,
  canonicalPeerIdFromCertificate,
  type AuthSession,
  type DeviceCertificate,
} from '../../src/p2p/handshake/AuthenticationHandshake.js';
import { InMemoryConnection } from '../../src/p2p/transport/InMemoryTransport.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
} from '../p2p/helpers.js';

const NON_CANONICAL_DIAL_KEY = '12D3KooWSimulatedDialKeyForCanonicalizationCheck';

async function makeHandshake(
  identity: Awaited<ReturnType<typeof createTestIdentity>>,
  masterPub: Uint8Array,
): Promise<AuthenticationHandshake> {
  const handshake = new AuthenticationHandshake();
  handshake.setIdentity({
    deviceId: identity.identity.deviceId,
    devicePublicKey: identity.identity.devicePublicKey,
    devicePrivateKey: identity.identity.devicePrivateKey,
    certificate: identity.identity.certificate as DeviceCertificate,
  });
  handshake.setUserMasterPublicKey(masterPub);
  await handshake.start();
  return handshake;
}

describe('N1 · 会话身份规范化（sha256hex 设备公钥）', () => {
  it('拨号键不同形态：认证后会话身份仍规范化为对端设备派生键', async () => {
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);
    const idA = await createTestIdentity('device-A');
    const idB = await createTestIdentity('device-B');
    await issueCertificate(master.privateKey, idA);
    await issueCertificate(master.privateKey, idB);

    // 拨号侧 B：连接本地键 = 模拟的 libp2p id（非规范键）；接受侧 A 按握手派生键
    const bEnd = new InMemoryConnection(
      idB.peerId,
      { id: NON_CANONICAL_DIAL_KEY, multihash: new Uint8Array(), pubKey: new Uint8Array() },
      'memory://A',
    );
    const aEnd = new InMemoryConnection(idA.peerId, idB.peerId, 'memory://B');
    bEnd.link(aEnd);
    aEnd.link(bEnd);

    const hA = await makeHandshake(idA, masterPub);
    const hB = await makeHandshake(idB, masterPub);
    const emitted: { side: string; session: AuthSession }[] = [];
    hA.on('authenticated', (session: AuthSession) => emitted.push({ side: 'A', session }));
    hB.on('authenticated', (session: AuthSession) => emitted.push({ side: 'B', session }));

    await Promise.all([hB.initiateAuth(bEnd), hA.acceptAuth(aEnd)]);

    expect(emitted).toHaveLength(2);
    const sessionA = emitted.find((e) => e.side === 'A')!.session;
    const sessionB = emitted.find((e) => e.side === 'B')!.session;

    // 两侧身份键 = 对端设备公钥的 sha256 hex（与测试辅助/idX.peerId.id 同算法）
    expect(sessionA.peerId.id).toBe(idB.peerId.id);
    expect(sessionB.peerId.id).toBe(idA.peerId.id);
    expect(sessionA.peerId.id).toBe(canonicalPeerIdFromCertificate(idB.identity.certificate!).id);
    expect(sessionB.peerId.id).toBe(canonicalPeerIdFromCertificate(idA.identity.certificate!).id);
    expect(sessionB.peerId.pubKey).toEqual(idA.identity.devicePublicKey);

    // 拨号键不得残留在会话身份里（只作本端寻址提示）
    expect(sessionB.peerId.id).not.toBe(NON_CANONICAL_DIAL_KEY);

    // 承载连接回填（N2/N4 依据）
    expect(sessionA.connection).toBe(aEnd);
    expect(sessionB.connection).toBe(bEnd);

    // 握手内部会话表仍按本地连接键存取（不影响对外规范身份）
    expect(hB.getSession(bEnd.peerId)?.peerId.id).toBe(idA.peerId.id);
  });

  it('canonicalPeerIdFromCertificate：与 derivePeerId 同形态（multihash=digest、pubKey=raw）', async () => {
    const master = await generateMasterKeyPair();
    const idA = await createTestIdentity('device-A');
    const certificate = await issueCertificate(master.privateKey, idA);
    const canonical = canonicalPeerIdFromCertificate(certificate);
    expect(canonical.id).toBe(idA.peerId.id);
    expect(canonical.multihash).toEqual(idA.peerId.multihash);
    expect(canonical.pubKey).toEqual(idA.identity.devicePublicKey);
  });
});
