// App-layer adapter: fleet CLI is a composition root for the QR capability.
// Keep this file free of domain logic; core never imports it.
export { renderTerminalQr, renderSvgQr } from '@mebular/qr';
export type { QrOptions, QrRenderResult } from '@mebular/qr';
