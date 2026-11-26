// `mebular adapter status|ensure|repair --json` (W6).
// Hermetic: temporary MEBULAR_HOME / MEBULAR_USER_HOME; never touches the
// real user configuration.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

jest.setTimeout(process.platform === 'win32' ? 30_000 : 20_000);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const cli = join(repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs');
const pluginDir = join(repoRoot, 'packages', 'opencode-plugin');

describe('mebular adapter CLI', () => {
  let root;
  let home;
  let userHome;

  const run = (args) => spawnSync(process.execPath, [cli, 'adapter', ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      MEBULAR_HOME: home,
      MEBULAR_USER_HOME: userHome,
      MEBULAR_SKILL_AUTOWIRE: '0',
    },
    timeout: 15_000,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adapter-cli-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('status --json: empty state is valid JSON', () => {
    const result = run(['status', '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.schema).toBe(1);
    expect(parsed.hosts).toEqual({});
  });

  it('ensure --host opencode --json: writes config and state; status reflects it', async () => {
    const configPath = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(configPath), { recursive: true });
    const result = run(['ensure', '--host', 'opencode', '--json', '--config', configPath, '--package', pluginDir]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.hostId).toBe('opencode');
    expect(parsed.status).toBe('installed');

    const status = run(['status', '--json']);
    expect(status.status).toBe(0);
    const view = JSON.parse(status.stdout);
    expect(view.hosts.opencode.adapter).toBe('installed');
    expect(view.hosts.opencode.version).toBeTruthy();
    // 输出只读视图，不含任何 token 字段
    expect(JSON.stringify(view)).not.toMatch(/token/i);
  });

  it('ensure on an MCP-only host: stable code, no path leakage', () => {
    const result = run(['ensure', '--host', 'cursor', '--json']);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('ADAPTER_UNSUPPORTED');
    expect(parsed.message).toBeTruthy();
    expect(result.stdout).not.toContain(root);
  });

  it('repair --json: empty connected set is a no-op', () => {
    const result = run(['repair', '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.scope).toBe('adapter-provisioning');
    expect(parsed.summary.total).toBe(0);
  });
});
