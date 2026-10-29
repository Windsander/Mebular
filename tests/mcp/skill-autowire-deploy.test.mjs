// fleet quickstart/join --daemon 的正式部署链：安装的是 `mebular-serve`（args: [mcpBin, 'serve']），
// 因此 Skill 自动收敛由 serve 启动时的 autoEnsureSkills 覆盖，不需要 fleet 反向 import mcp。

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');

describe('fleet --daemon → mebular serve → autoEnsureSkills', () => {
  it('quickstart/join 的 daemon 分支会调用 installDaemon', () => {
    const quickstart = read('packages/fleet/src/quickstart.ts');
    expect(quickstart).toMatch(/input\.daemon === true[\s\S]{0,400}installDaemon\(input\.dir\)/);
  });

  it('daemonInstaller 安装 mebular-serve 并以 `serve` 启动 mcp bin', () => {
    const cli = read('packages/fleet/src/cli.ts');
    expect(cli).toMatch(/function daemonInstaller\(\): ServiceInstaller[\s\S]{0,600}kind: 'mebular-serve'[\s\S]{0,200}args: \[mcpBin, 'serve'\]/);
  });

  it('serve 正常启动后调用 autoEnsureSkills（Skill 由 serve 收敛）', () => {
    const server = read('packages/mcp/src/server.mjs');
    expect(server).toMatch(/await finalizeRuntime\(current\)[\s\S]{0,800}autoEnsureSkills/);
    const serve = read('packages/mcp/src/serve.mjs');
    expect(serve).toMatch(/activateRuntime\(next, \{ viaHotInit: true \}\)[\s\S]{0,800}autoEnsureSkills/);
  });
});
