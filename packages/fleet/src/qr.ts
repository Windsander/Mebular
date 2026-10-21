// C7 · 配对二维码渲染（应用层能力；`qrcode-generator` 为普通运行时依赖）
//
// 语义：QR 内容 = **内联令牌文本本身**（不引自定义 scheme）；因此任何扫码器/文本通道等价。
// 降级：编码失败 → 返回 null + 告警（**只给文本，不报错**）——绝不阻断邀请/加入。

import qrcode from 'qrcode-generator';

export interface QrRenderResult {
  /** 渲染产物（terminal/svg） */
  value: string;
  /** 渲染形态 */
  kind: 'terminal' | 'svg';
}

export interface QrOptions {
  /** 非致命渲染告警；调用方回退文本令牌/分组文本 */
  onWarn?: (message: string) => void;
}

function makeQr(text: string) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// qrcode-generator 的 ASCII 画法是「亮模块 = 块字符」，只适合深色终端。
// 反相后固定 ANSI 黑字白底，使任何主题下都保持标准极性。
const TERMINAL_INVERT: Record<string, string> = { ' ': '█', '▀': '▄', '▄': '▀', '█': ' ' };

function invertTerminalArt(art: string): string {
  const lines = art.split('\n');
  return lines
    .map((line, index) => {
      // QR module count 恒为奇数（17 + 4n），四模块静区使最后一行半行全是静区：
      // 保持白色，避免反相成黑条。
      const rendered = index === lines.length - 1
        ? ' '.repeat(line.length)
        : line.replace(/[█▀▄ ]/g, (ch) => TERMINAL_INVERT[ch] ?? ch);
      return `\x1b[30;47m${rendered}\x1b[0m`;
    })
    .join('\n');
}

/** 终端二维码（ANSI 黑字白底；内容=令牌文本） */
export async function renderTerminalQr(text: string, options: QrOptions = {}): Promise<QrRenderResult | null> {
  try {
    return { value: invertTerminalArt(makeQr(text).createASCII(1, 4)), kind: 'terminal' };
  } catch (error) {
    options.onWarn?.(`二维码：终端渲染失败（${errorText(error)}）`);
    return null;
  }
}

/** SVG（控制台服务端渲染；前端以 data-uri <img> 展示，避免注入） */
export async function renderSvgQr(text: string, options: QrOptions = {}): Promise<QrRenderResult | null> {
  try {
    const value = makeQr(text).createSvgTag({ cellSize: 4, margin: 1 });
    return { value, kind: 'svg' };
  } catch (error) {
    options.onWarn?.(`二维码：SVG 渲染失败（${errorText(error)}）`);
    return null;
  }
}
