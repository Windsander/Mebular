# @mebular/qr

Mebular's **app-layer** QR capability.

- Zero runtime dependencies.
- Imports nothing from `@mebular/core`.
- Only application packages (`packages/fleet`, `packages/mcp`) import it. Core
  (`src/**`) never does, and the console only consumes the returned SVG string.
- The vendored encoder lives at `src/third-party/qrcode-generator/` with its own MIT
  license and is built into `dist/`. It is not loaded from `node_modules` at runtime.
- The console only consumes the returned SVG string; it never imports the encoder.

Public API:

```ts
renderTerminalQr(text, { onWarn? }): Promise<{ value: string; kind: 'terminal' } | null>
renderSvgQr(text, { onWarn? }): Promise<{ value: string; kind: 'svg' } | null>
```

Vendored source: `qrcode-generator` 2.0.4 by Kazuhiko Arase (MIT).
