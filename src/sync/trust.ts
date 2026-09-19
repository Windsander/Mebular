// 签发者信任判定（Phase 2 · D/E 共用）
//
// 判定一条事件是否由**链到用户主密钥**的设备签发：要求事件携带
// `authorCertificate`，证书 deviceId 与事件 author 一致，证书经用户主公钥
// 验签，事件签名经证书内的设备公钥验签。
//
// 这是对 `SyncManager.verifyEventTrust` 中「中继/多跳」分支的抽取与复用——
// **不新造信任根**：授权记录（grant/revoke）的签发者判定与普通事件的信任链
// 走同一套密码学校验。直连对端的「直签快路径」不在此列：授权是元数据，
// 只有能出示用户主密钥签发证书的设备才可信。

import type { Event } from '../types/event.js';
import { EventLog } from '../eventlog/EventLog.js';
import { hexToBytes, verifyCertificateSignature, verifyCertificateChain } from '../p2p/handshake/AuthenticationHandshake.js';

/**
 * 事件是否由「链到给定用户主公钥」的设备签发。
 * `userMasterPublicKey` 缺失（未配置信任根）时一律返回 false。
 */
export async function verifyIssuedByUser(
  event: Event,
  userMasterPublicKey: Uint8Array | null | undefined,
  opts: { isRevoked?: (deviceId: string) => boolean } = {},
): Promise<boolean> {
  if (!userMasterPublicKey) return false;
  const certificate = event.authorCertificate;
  if (!certificate || certificate.deviceId !== event.author) return false;
  // T2：带链（委派）走链式校验；否则旧主密钥直签单层校验。
  const chain = event.authorCertificateChain;
  if (chain !== undefined && chain.length > 1) {
    const ok = await verifyCertificateChain(chain, userMasterPublicKey, {
      subjectDeviceId: event.author,
      ...(opts.isRevoked ? { isRevoked: opts.isRevoked } : {}),
    });
    if (!ok) return false;
  } else {
    if (certificate.issuer !== undefined) return false;
    if (!(await verifyCertificateSignature(certificate, userMasterPublicKey))) return false;
  }
  try {
    return await EventLog.verifyEvent(event, hexToBytes(certificate.devicePublicKey));
  } catch {
    return false;
  }
}
