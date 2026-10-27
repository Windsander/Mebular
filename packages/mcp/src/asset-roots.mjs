import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve Console and locale assets for both the core-internal MCP and standalone @mebular/mcp layouts.
 * @param moduleUrl serve.mjs 的 `import.meta.url`。
 * @returns {{ consoleDir: string, localesDir: string }} console 与 locale pack 的绝对目录。
 */
export function resolveStaticAssetRoots(moduleUrl) {
  const directory = dirname(fileURLToPath(moduleUrl));
  const consoleCandidate = join(directory, '..', '..', 'console');
  const localesCandidate = join(directory, '..', '..', '..', 'locales');
  return {
    consoleDir: existsSync(consoleCandidate)
      ? consoleCandidate
      : join(directory, '..', '..', '..', '@mebular', 'core', 'packages', 'console'),
    localesDir: existsSync(localesCandidate)
      ? localesCandidate
      : join(directory, '..', '..', '..', '@mebular', 'core', 'locales'),
  };
}
