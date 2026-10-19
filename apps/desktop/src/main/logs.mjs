// M2 · 日志页读取：service logs 优先，兜底 <home>/serve.log；统一脱敏
//
// 纯逻辑（service/readFile 可注入）；不 import electron。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactLog, tailText } from './wizard.mjs';

/**
 * 读取守护日志（脱敏后）。
 * 返回 { source: 'service'|'file'|'none', text, paths }。
 */
export async function readDaemonLogs({ home, serviceHome = home, service, descriptor, tail = 200, readFileImpl = readFile } = {}) {
  const paths = {};
  let serviceEmpty = false;
  if (service?.serviceLogs && descriptor) {
    try {
      const res = service.serviceLogs(descriptor, { home: serviceHome, tail });
      const text = [...(res.stdout ?? []), ...(res.stderr ?? [])].join('\n');
      if (typeof res.stdoutLog === 'string') paths.stdout = res.stdoutLog;
      if (typeof res.stderrLog === 'string') paths.stderr = res.stderrLog;
      if (text.trim().length > 0) {
        return { source: 'service', text: redactLog(text), paths };
      }
      // 服务日志为空（如尚未安装常驻）→ 继续尝试 <home>/serve.log
      serviceEmpty = true;
    } catch {
      // 回退到文件
    }
  }
  const file = join(home, 'serve.log');
  try {
    const raw = await readFileImpl(file, 'utf-8');
    const text = redactLog(tailText(raw, tail));
    if (text.trim().length > 0) return { source: 'file', text, paths: { ...paths, file } };
  } catch {
    // 无文件
  }
  // 服务日志存在但为空：回服务来源（暴露日志文件路径）；否则无日志
  if (serviceEmpty) return { source: 'service', text: '', paths };
  return { source: 'none', text: '', paths: {} };
}
