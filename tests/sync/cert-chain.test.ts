// T2 信任模型 v2：委派证书链（正例 / 负数 / 吊销级联 / 事件信任 / 握手校验）。
import { describe, it, expect } from '@jest/globals';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import {
  AuthenticationHandshake,
  MAX_CERT_CHAIN_HOPS,
  bytesToHex,
  verifyCertificateChain,
  verifyCertificateSignature,
  signDelegatedCertificate,
  type DeviceCertificate,
} from '../../src/p2p/handshake/AuthenticationHandshake.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { verifyIssuedByUser } from '../../src/sync/trust.js';

async function setupChain(): Promise<{
  im: IdentityManager;
  masterPub: Uint8Array;
  a: DeviceCertificate;
  b: DeviceCertificate;
  c: DeviceCertificate;
}> {
  const im = new IdentityManager();
  await im.generateUserMasterKey();
  await im.generateDeviceKey('device-A', 'A');
  const a = await im.issueDeviceCertificate('device-A');
  await im.generateDeviceKey('device-B', 'B');
  const b = await im.issueDelegatedDeviceCertificate('device-B', 'device-A');
  await im.generateDeviceKey('device-C', 'C');
  const c = await im.issueDelegatedDeviceCertificate('device-C', 'device-B');
  return { im, masterPub: im.getUserMasterPublicKey()!, a, b, c };
}

describe('T2 委派证书链', () => {
  it('链式正例 master→A→B→C；旧主密钥直签仍有效', async () => {
    const { masterPub, a, b, c } = await setupChain();
    expect(await verifyCertificateChain([a], masterPub, { subjectDeviceId: 'device-A' })).toBe(true);
    expect(await verifyCertificateChain([b, a], masterPub, { subjectDeviceId: 'device-B' })).toBe(true);
    expect(await verifyCertificateChain([c, b, a], masterPub, { subjectDeviceId: 'device-C' })).toBe(true);
    // 旧路径（纯密码学）不变
    expect(await verifyCertificateSignature(a, masterPub)).toBe(true);
  });

  it('负数：超长链（>N）、伪造链（错公钥）、自签（单元素带 issuer）、主体不匹配', async () => {
    const { im, masterPub, a, b } = await setupChain();
    // 造到上界：A→B(1) B→C(2) C→D(3) D→E(4)；E→F 必须被拒
    await im.generateDeviceKey('device-D', 'D');
    await im.issueDelegatedDeviceCertificate('device-D', 'device-C');
    await im.generateDeviceKey('device-E', 'E');
    await im.issueDelegatedDeviceCertificate('device-E', 'device-D');
    const eChain = im.getDeviceKey('device-E')!.certificateChain!;
    expect(eChain.length - 1).toBe(MAX_CERT_CHAIN_HOPS);
    await im.generateDeviceKey('device-F', 'F');
    await expect(im.issueDelegatedDeviceCertificate('device-F', 'device-E')).rejects.toThrow(/上界/);
    // 手工构造合法但超长链（6 元素 / 5 跳）→ 仅**上界**拒绝
    const eKey = im.getDeviceKey('device-E')!;
    const fCert = await signDelegatedCertificate(
      { deviceId: 'device-F', devicePublicKey: bytesToHex(new Uint8Array(32).fill(1)), createdAt: 0 },
      { deviceId: 'device-E', devicePrivateKey: eKey.privateKey, devicePublicKey: bytesToHex(eKey.publicKey) },
    );
    const tooLong = [fCert, ...eChain] as DeviceCertificate[];
    expect(tooLong.length - 1).toBe(MAX_CERT_CHAIN_HOPS + 1);
    expect(await verifyCertificateChain(tooLong, masterPub, { subjectDeviceId: 'device-F' })).toBe(false);

    // 伪造链：把 B 的 issuer 公钥改成 C 的公钥（与下一跳 A 不符）→ 拒绝
    const forged: DeviceCertificate = { ...b, issuer: { deviceId: b.issuer!.deviceId, publicKey: bytesToHex(new Uint8Array(32).fill(7)) } };
    expect(await verifyCertificateChain([forged, a], masterPub, { subjectDeviceId: 'device-B' })).toBe(false);
    // 单元素带 issuer（委派证书未带链）→ 拒绝
    expect(await verifyCertificateChain([b], masterPub, { subjectDeviceId: 'device-B' })).toBe(false);
    // 主体不匹配
    expect(await verifyCertificateChain([b, a], masterPub, { subjectDeviceId: 'device-X' })).toBe(false);
    // 根不得再委派：把 A 也标成 issuer → 拒绝
    const badRoot: DeviceCertificate = { ...a, issuer: { deviceId: 'device-X', publicKey: bytesToHex(new Uint8Array(32).fill(9)) } };
    expect(await verifyCertificateChain([b, badRoot], masterPub, { subjectDeviceId: 'device-B' })).toBe(false);
  });

  it('吊销级联：链中含被吊销节点 → 拒绝（与策略层 R-b 同源）', async () => {
    const { masterPub, a, b, c } = await setupChain();
    expect(await verifyCertificateChain([c, b, a], masterPub, { isRevoked: (d) => d === 'device-B' })).toBe(false);
    expect(await verifyCertificateChain([c, b, a], masterPub, { isRevoked: (d) => d === 'device-A' })).toBe(false);
    expect(await verifyCertificateChain([c, b, a], masterPub, { isRevoked: (d) => d === 'device-Z' })).toBe(true);
  });

  it('握手层：委派证书须带链；带吊销判定时级联拒绝', async () => {
    const { masterPub, a, b } = await setupChain();
    const h = new AuthenticationHandshake();
    h.setUserMasterPublicKey(masterPub);
    expect(await h.verifyCertificate('device-B', b, [b, a])).toBe(true);
    expect(await h.verifyCertificate('device-B', b)).toBe(false); // 委派证书无链 → 拒
    expect(await h.verifyCertificate('device-A', a)).toBe(true); // 旧直签仍可
    h.setRevocationCheck((d) => d === 'device-A');
    expect(await h.verifyCertificate('device-B', b, [b, a])).toBe(false); // 级联吊销
    h.setRevocationCheck(null);
    expect(await h.verifyCertificate('device-B', b, [b, a])).toBe(true);
  });

  it('事件信任：委派签发的事件经链验签；旧直签事件不变；吊销级联拒绝', async () => {
    const { im, masterPub, a, b } = await setupChain();
    const bKey = im.getDeviceKey('device-B')!;
    const storage = new MemoryStorage();
    const log = new EventLog(storage, 'device-B', {
      signer: { deviceId: 'device-B', privateKey: bKey.privateKey, certificate: b, certificateChain: [b, a] },
    });
    const evt = await log.append({ type: 'node_created', data: { nodeId: 'n1' } });
    expect(evt.authorCertificate?.deviceId).toBe('device-B');
    expect(evt.authorCertificateChain?.length).toBe(2);
    expect(await verifyIssuedByUser(evt, masterPub)).toBe(true);
    expect(await verifyIssuedByUser(evt, masterPub, { isRevoked: (d) => d === 'device-A' })).toBe(false);
    expect(await verifyIssuedByUser(evt, null)).toBe(false);

    // 旧直签事件（A，无链）仍有效
    const aKey = im.getDeviceKey('device-A')!;
    const logA = new EventLog(new MemoryStorage(), 'device-A', {
      signer: { deviceId: 'device-A', privateKey: aKey.privateKey, certificate: a, certificateChain: [a] },
    });
    const evtA = await logA.append({ type: 'node_created', data: { nodeId: 'n2' } });
    expect(evtA.authorCertificateChain).toBeUndefined();
    expect(await verifyIssuedByUser(evtA, masterPub)).toBe(true);
  });
});
