// 公网出口判据（G3-P2，抽为共享模块供 wan-sync 与 G6.6 跨网门禁复用）
//
// 用出口 IP（默认经 MEBULAR_WAN_IP_ECHO）判定两端是否位于不同公网网络；
// 私网/回环/未知一律不判为「不同」，绝不以网卡接口 IP 为判据。

export const DEFAULT_IP_ECHO = 'https://api.ipify.org?format=json';

export async function lookupEgress(timeoutMs = 4000) {
  const source = process.env.MEBULAR_WAN_IP_ECHO || DEFAULT_IP_ECHO;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(source, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).trim();
    let ip = null;
    let org = null;
    try {
      const j = JSON.parse(text);
      ip = typeof j.ip === 'string' ? j.ip : null;
      org = typeof j.org === 'string' ? j.org : null;
    } catch {
      ip = text;
    }
    if (!ip || !/^[0-9a-fA-F:.]+$/.test(ip)) throw new Error('unexpected egress payload');
    return { ip, org, asn: org ? org.split(/\s+/)[0] : null, source, error: null };
  } catch (error) {
    return { ip: null, org: null, asn: null, source, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

export function isPrivateIp(ip) {
  if (!ip) return true;
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return true; // 非 IPv4 且非已知公网 v6 → 保守判私网/未知
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** 出口 IP 判据：任一未知/私网 → false/未知；均公网且不同 → true（绝不基于接口 IP） */
export function judgeDifferentNetwork(localIp, peerIp) {
  if (!localIp || !peerIp) return { value: null, basis: 'egress-unknown' };
  if (isPrivateIp(localIp) || isPrivateIp(peerIp)) return { value: false, basis: 'private-or-loopback' };
  if (localIp === peerIp) return { value: false, basis: 'same-egress-ip' };
  return { value: true, basis: 'distinct-public-egress' };
}
