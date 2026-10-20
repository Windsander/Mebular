# @mebular/qr

Mebular's **app-layer** QR capability.

- Small package with **one direct dependency** (`qrcode-generator` 2.0.4, MIT) and
  zero transitive dependencies.
- Imports nothing from `@mebular/core`.
- Only application packages (`packages/fleet`, `packages/mcp`) import it. Core
  (`src/**`) never does, and the console only consumes the returned SVG string.
- `renderTerminalQr` emits ANSI black-on-white half-blocks, so the printed code keeps
  standard polarity regardless of the terminal theme.
- `qrcode-generator` is installed from npm as a normal dependency; its source is not
  vendored into this repository.

Public API:

```ts
renderTerminalQr(text, { onWarn? }): Promise<{ value: string; kind: 'terminal' } | null>
renderSvgQr(text, { onWarn? }): Promise<{ value: string; kind: 'svg' } | null>
```

Dependency: `qrcode-generator` 2.0.4 by Kazuhiko Arase (MIT).
