// F-C6：加入令牌里的 endpoint 必须是**新设备可直达**的地址（跨机时回环地址必然失败）。
// bind 为通配（0.0.0.0 / :: / 空）时选一个可对外通告的 LAN IPv4（无则回环，并由上层给出 warning）。
import { networkInterfaces } from 'node:os';

const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]', '*', '']);

/** 选一个可对外通告的 LAN IPv4（无则 127.0.0.1）。 */
export function pickLanHost() {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

/** bind 地址 → 对外通告地址（通配时取 LAN IPv4）。 */
export function advertiseHost(bind) {
  const value = typeof bind === 'string' ? bind : '';
  return WILDCARD_BINDS.has(value) ? pickLanHost() : value;
}

/** 是否回环/本机地址（用于提示「新设备不可达」）。 */
export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1';
}

/** 解析 endpoint 的 hostname；非法 URL 返回 null。 */
export function endpointHostname(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
}
