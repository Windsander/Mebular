import qrcode from './third-party/qrcode-generator/qrcode.js';

interface QrCode {
  addData(data: string): void;
  make(): void;
  createASCII(cellSize?: number, margin?: number): string;
  createSvgTag(options?: { cellSize?: number; margin?: number }): string;
}

const createQr = qrcode as unknown as (typeNumber: number, errorCorrectionLevel: string) => QrCode;

/**
 * App-layer QR capability.
 *
 * Boundary: this package is imported only by application packages
 * (`packages/fleet`, `packages/mcp`). `src/**` (core) must never import this
 * package or the vendored encoder.
 */

export interface QrRenderResult {
  /** Rendered artifact: terminal text or an SVG document. */
  value: string;
  kind: 'terminal' | 'svg';
}

export interface QrOptions {
  /** Non-fatal render warning; callers fall back to the text token/groups. */
  onWarn?: (message: string) => void;
}

function makeQr(text: string): QrCode {
  const qr = createQr(0, 'M');
  qr.addData(text);
  qr.make();
  return qr;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// qrcode-generator's ASCII art renders *light* modules as block glyphs (designed for
// dark terminals). Invert it and pin black-on-white ANSI colors so the printed code is
// polarity-correct regardless of the terminal theme (same behavior as the old renderer).
const TERMINAL_INVERT: Record<string, string> = { ' ': '█', '▀': '▄', '▄': '▀', '█': ' ' };

function invertTerminalArt(art: string): string {
  const lines = art.split('\n');
  return lines
    .map((line, index) => {
      // QR module counts are always odd (17 + 4n) and the quiet zone is 4 modules on
      // each side, so the encoder's final half-line is entirely quiet zone. Keep it
      // white instead of inverting it into a black bar.
      const rendered = index === lines.length - 1
        ? ' '.repeat(line.length)
        : line.replace(/[█▀▄ ]/g, (ch) => TERMINAL_INVERT[ch] ?? ch);
      return `\x1b[30;47m${rendered}\x1b[0m`;
    })
    .join('\n');
}

/** Terminal QR (ANSI black-on-white, scan directly from CLI output; 4-module quiet zone). */
export async function renderTerminalQr(text: string, options: QrOptions = {}): Promise<QrRenderResult | null> {
  try {
    return { value: invertTerminalArt(makeQr(text).createASCII(1, 4)), kind: 'terminal' };
  } catch (error) {
    options.onWarn?.(`二维码：终端渲染失败（${errorText(error)}）`);
    return null;
  }
}

/** SVG QR (console HTTP response; caller embeds it as a data URI). */
export async function renderSvgQr(text: string, options: QrOptions = {}): Promise<QrRenderResult | null> {
  try {
    const value = makeQr(text).createSvgTag({ cellSize: 4, margin: 1 });
    return { value, kind: 'svg' };
  } catch (error) {
    options.onWarn?.(`二维码：SVG 渲染失败（${errorText(error)}）`);
    return null;
  }
}
