// C7 · 配对二维码渲染（依赖政策：`qrcode` 为**可选依赖**，精确 pin，声明于 THIRD-PARTY.md）
//
// 语义：QR 内容 = **内联令牌文本本身**（不引自定义 scheme）；因此任何扫码器/文本通道等价。
// 降级：可选依赖缺失或渲染失败 → 返回 null + 告警（**只给文本，不报错**）——绝不阻断邀请/加入。

import { createRequire } from 'node:module';

export interface QrRenderResult {
  /** 渲染产物（terminal/svg/png data-uri） */
  value: string;
  /** 渲染形态 */
  kind: 'terminal' | 'svg' | 'data-uri';
}

export interface QrOptions {
  /** 模块加载器（测试注入；缺省同步加载可选依赖 `qrcode`） */
  loadModule?: () => unknown;
  onWarn?: (message: string) => void;
}

interface QrModuleLike {
  toString(text: string, options?: Record<string, unknown>): Promise<string>;
  toDataURL(text: string, options?: Record<string, unknown>): Promise<string>;
}

function loadQrModule(options: QrOptions = {}): QrModuleLike | null {
  try {
    const mod = options.loadModule ? options.loadModule() : defaultLoad();
    const candidate = (mod as { default?: QrModuleLike } | undefined)?.default ?? (mod as QrModuleLike | undefined);
    // 注意：普通对象的原型链上也有 toString —— 必须是「自定义的 toString」（真 qrcode 是自有实现）
    const isCustomToString = Boolean(candidate)
      && typeof (candidate as { toString?: unknown }).toString === 'function'
      && (candidate as { toString: unknown }).toString !== Object.prototype.toString;
    if (!isCustomToString) {
      options.onWarn?.('二维码：可选依赖 qrcode 不可用（只提供文本令牌）');
      return null;
    }
    return candidate as QrModuleLike;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.onWarn?.(`二维码：可选依赖 qrcode 不可用（${reason}）；只提供文本令牌`);
    return null;
  }
}

function defaultLoad(): unknown {
  // 解析锚点优先入口脚本（qrcode 是 CJS 可选依赖）；避免 import.meta（CJS 构建下不可用）
  const anchor = process.argv[1] && process.argv[1].length > 0 ? process.argv[1] : `${process.cwd()}/index.js`;
  return createRequire(anchor)('qrcode');
}

/** 终端二维码（扫码即通；内容=令牌文本） */
export async function renderTerminalQr(text: string, options: QrOptions = {}): Promise<QrRenderResult | null> {
  const qr = loadQrModule(options);
  if (!qr) return null;
  try {
    const value = await qr.toString(text, { type: 'terminal', small: true });
    return { value, kind: 'terminal' };
  } catch (error) {
    options.onWarn?.(`二维码：终端渲染失败（${error instanceof Error ? error.message : String(error)}）`);
    return null;
  }
}

/** SVG（控制台服务端渲染；前端以 data-uri <img> 展示，避免注入） */
export async function renderSvgQr(text: string, options: QrOptions = {}): Promise<QrRenderResult | null> {
  const qr = loadQrModule(options);
  if (!qr) return null;
  try {
    const value = await qr.toString(text, { type: 'svg', margin: 1, width: 220 });
    return { value, kind: 'svg' };
  } catch (error) {
    options.onWarn?.(`二维码：SVG 渲染失败（${error instanceof Error ? error.message : String(error)}）`);
    return null;
  }
}
