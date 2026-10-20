// C7 · 二维码渲染/降级（QR-only；授权/token 语义已删除）
import { describe, it, expect } from '@jest/globals';
import {
  renderSvgQr as fleetSvg,
  renderTerminalQr as fleetTerminal,
} from '../../packages/fleet/src/index.js';

describe('C7 · 二维码渲染与降级', () => {
  const token = 'eyJ2IjoxLCJraW5kIjoibWVidWxhci1mbGVldC1qb2luLXRva2VuIn0=';

  it('真可选依赖在场：SVG/terminal 产出（内容=令牌文本，无自定义 scheme）', async () => {
    const fleet = await fleetSvg(token);
    expect(fleet?.value.startsWith('<svg')).toBe(true);
    expect(fleet?.value).not.toContain('mebular://');
    const termFleet = await fleetTerminal(token);
    expect(termFleet?.kind).toBe('terminal');
  });

  it('缺可选依赖：返回 null + 告警（只给文本，不报错）', async () => {
    const warnings: string[] = [];
    const loader = () => { throw new Error("Cannot find module 'qrcode'"); };
    expect(await fleetSvg(token, { loadModule: loader, onWarn: (m: string) => warnings.push(`fleet:${m}`) })).toBeNull();
    expect(await fleetTerminal(token, { loadModule: loader, onWarn: (m: string) => warnings.push(`fleet:${m}`) })).toBeNull();
    expect(warnings.some((m) => m.startsWith('fleet:') && m.includes('qrcode'))).toBe(true);
  });

  it('导出非函数 / 渲染抛错 / 默认 loader 三条分支都被覆盖且软降级', async () => {
    const warnings: string[] = [];
    // ① loader 返回不合形模块 → null + 告警
    expect(await fleetSvg(token, { loadModule: () => ({ nope: true }), onWarn: (m: string) => warnings.push(m) })).toBeNull();
    expect(warnings.some((m) => m.includes('可选依赖 qrcode 不可用'))).toBe(true);
    // ② toString 抛错 → null + 渲染失败告警
    const throwing = { toString: async () => { throw new Error('render boom'); } };
    expect(await fleetSvg(token, { loadModule: () => throwing, onWarn: (m: string) => warnings.push(m) })).toBeNull();
    expect(await fleetTerminal(token, { loadModule: () => throwing, onWarn: (m: string) => warnings.push(m) })).toBeNull();
    expect(warnings.some((m) => m.includes('SVG 渲染失败'))).toBe(true);
    expect(warnings.some((m) => m.includes('终端渲染失败'))).toBe(true);
    // ③ 默认 loader（真实可选依赖）：在场 → SVG；缺包 → null + 告警（两条路径都走通，不抛错）
    const viaDefault = await fleetSvg(token, { onWarn: (m: string) => warnings.push(m) });
    expect(viaDefault === null || viaDefault.value.startsWith('<svg')).toBe(true);
  });

  it('显式传入的 qrcode 形模块可用（注入 loader 路径）', async () => {
    const fake = { toString: async (text: string, options?: Record<string, unknown>) => `<svg data-kind="${String(options?.type)}">${text.length}</svg>` };
    const result = await fleetSvg(token, { loadModule: () => fake });
    expect(result?.value).toContain('data-kind="svg"');
  });

  it('default 导出形态（{ default: qr }）也被识别', async () => {
    const fake = { default: { toString: async () => '<svg>wrapped</svg>' } };
    const result = await fleetSvg(token, { loadModule: () => fake });
    expect(result?.value).toBe('<svg>wrapped</svg>');
  });
});
