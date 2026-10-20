// C7 · 配对二维码渲染（与 @mebular/fleet 同实现；mcp 已是 fleet 的下游，不重复编码器逻辑）
//
// QR 内容 = 内联令牌文本本身（不引自定义 scheme）；编码失败 → null + 告警（只给文本，不报错）。
export { renderTerminalQr, renderSvgQr } from '../../fleet/dist/qr.js';
