// C7 · 配对二维码渲染（与 @mebular/fleet/src/qr.ts **同语义**；mcp 包不能依赖 fleet，
// 故按同一行为在守护内实现，跨包一致性由 tests 的 parity 断言防漂移）。
//
// QR 内容 = 内联令牌文本本身（不引自定义 scheme）；可选依赖缺失 → null + 告警（只给文本，不报错）。

import { createRequire } from 'node:module';

function loadQrModule(options = {}) {
  try {
    const mod = options.loadModule ? options.loadModule() : defaultLoad();
    const candidate = mod?.default ?? mod;
    // 普通对象原型链上也有 toString：必须是自定义实现（真 qrcode）
    if (!candidate || typeof candidate.toString !== 'function' || candidate.toString === Object.prototype.toString) {
      options.onWarn?.('二维码：可选依赖 qrcode 不可用（只提供文本令牌）');
      return null;
    }
    return candidate;
  } catch (error) {
    const reason = error?.message ?? String(error);
    options.onWarn?.(`二维码：可选依赖 qrcode 不可用（${reason}）；只提供文本令牌`);
    return null;
  }
}

function defaultLoad() {
  const anchor = process.argv[1] && process.argv[1].length > 0 ? process.argv[1] : `${process.cwd()}/index.js`;
  return createRequire(anchor)('qrcode');
}

export async function renderTerminalQr(text, options = {}) {
  const qr = loadQrModule(options);
  if (!qr) return null;
  try {
    return { value: await qr.toString(text, { type: 'terminal', small: true }), kind: 'terminal' };
  } catch (error) {
    options.onWarn?.(`二维码：终端渲染失败（${error?.message ?? String(error)}）`);
    return null;
  }
}

export async function renderSvgQr(text, options = {}) {
  const qr = loadQrModule(options);
  if (!qr) return null;
  try {
    return { value: await qr.toString(text, { type: 'svg', margin: 1, width: 220 }), kind: 'svg' };
  } catch (error) {
    options.onWarn?.(`二维码：SVG 渲染失败（${error?.message ?? String(error)}）`);
    return null;
  }
}
