// C7 · 二维码渲染（app-layer 能力，qrcode-generator 为普通依赖；QR-only；授权/token 语义已删除）
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderSvgQr as fleetSvg,
  renderTerminalQr as fleetTerminal,
} from '../../packages/fleet/src/index.js';

const repoRoot = process.cwd();
const token = 'eyJ2IjoxLCJraW5kIjoibWVidWxhci1mbGVldC1qb2luLXRva2VuIn0=';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.mjs')) out.push(full);
  }
  return out;
}

describe('C7 · 二维码渲染与隔离', () => {
  it('编码器：SVG/terminal 产出（内容=令牌文本，无自定义 scheme）', async () => {
    const fleet = await fleetSvg(token);
    expect(fleet?.kind).toBe('svg');
    expect(fleet?.value.startsWith('<svg')).toBe(true);
    expect(fleet?.value).not.toContain('mebular://');
    const termFleet = await fleetTerminal(token);
    expect(termFleet?.kind).toBe('terminal');
    expect((termFleet?.value ?? '').length).toBeGreaterThan(0);
    // 主题无关的极性：ANSI 黑字白底 + 反相半块（暗模块为块）
    expect(termFleet?.value).toContain('\x1b[30;47m');
    expect(termFleet?.value).toContain('█');
  });

  it('渲染失败软降级：超长输入 → null + warning，不抛错', async () => {
    const warnings: string[] = [];
    expect(await fleetSvg('x'.repeat(10000), { onWarn: (m: string) => warnings.push(m) })).toBeNull();
    expect(await fleetTerminal('x'.repeat(10000), { onWarn: (m: string) => warnings.push(m) })).toBeNull();
    expect(warnings.some((m) => m.includes('SVG 渲染失败'))).toBe(true);
    expect(warnings.some((m) => m.includes('终端渲染失败'))).toBe(true);
  });

  it('同一文本渲染确定；成功路径不产生 warning', async () => {
    const warnings: string[] = [];
    const first = await fleetSvg(token, { onWarn: (m: string) => warnings.push(m) });
    const second = await fleetSvg(token);
    const termFirst = await fleetTerminal(token, { onWarn: (m: string) => warnings.push(m) });
    const termSecond = await fleetTerminal(token);
    expect(first?.value).toBe(second?.value);
    expect(termFirst?.value).toBe(termSecond?.value);
    expect(warnings).toEqual([]);
  });

  it('QR 包只声明 qrcode-generator 精确依赖（源码不 vendored）', () => {
    const qrPkg = JSON.parse(readFileSync(join(repoRoot, 'packages', 'qr', 'package.json'), 'utf-8'));
    expect(qrPkg.dependencies).toEqual({ 'qrcode-generator': '2.0.4' });
    expect(existsSync(join(repoRoot, 'packages', 'qr', 'src', 'third-party'))).toBe(false);
  });

  it('core 不 import QR/qrcode-generator', () => {
    const coreFiles = walk(join(repoRoot, 'src'));
    const hits = coreFiles.filter((file) => {
      const text = readFileSync(file, 'utf-8');
      return /@mebular\/qr|qrcode-generator|renderSvgQr|renderTerminalQr/.test(text);
    });
    expect(hits).toEqual([]);
  });
});
