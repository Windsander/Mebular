// config-apply：生产 serve 启动必须先恢复上次失败的回滚，再读取 config.json。
import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readApplyPending,
  readApplyResult,
  writeApplyPending,
} from '../../packages/mcp/src/config-apply.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages/mcp/bin/mebular.mjs');
const dirs = [];

const HARNESS = String.raw`
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.APPLY_STARTUP_ROOT;
const { startServeServer } = await import(pathToFileURL(join(ROOT, 'packages/mcp/src/server.mjs')).href);
const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
try {
  const response = await fetch('http://127.0.0.1:' + srv.port + '/admin/api/settings');
  const settings = await response.json();
  console.log(JSON.stringify({ port: srv.port, lastApply: settings.lastApply ?? null }));
} finally {
  await srv.close();
}
process.exit(0);
`;

async function makeWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), 'config-apply-startup-'));
  dirs.push(workspace);
  const home = join(workspace, 'home');
  const userHome = join(workspace, 'user');
  const cloudRoot = join(workspace, 'cloud');
  return { workspace, home, userHome, cloudRoot };
}

function envFor({ home, userHome, cloudRoot }) {
  const env = {
    ...process.env,
    MEBULAR_HOME: home,
    MEBULAR_USER_HOME: userHome,
    MEBULAR_CLOUD_ROOT: cloudRoot,
    MEBULAR_NETWORK_ENABLED: '0',
    MEBULAR_SKILL_AUTOWIRE: '0',
    APPLY_STARTUP_ROOT: ROOT,
  };
  delete env.MEBULAR_PROVISION;
  delete env.MEBULAR_STORAGE_PATH;
  delete env.MEBULAR_CONFIG;
  delete env.MEBULAR_SERVICE_KIND;
  return env;
}

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
});

describe('config-apply production startup recovery', () => {
  it('启动时先还原 .bak 再读配置：坏 config 也能以旧配置启动，并清 pending', async () => {
    const paths = await makeWorkspace();
    const env = envFor(paths);
    const init = spawnSync(process.execPath, [CLI, 'init'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(init.status).toBe(0);

    const configFile = join(paths.home, 'config.json');
    const backupFile = `${configFile}.bak`;
    const validConfig = await readFile(configFile, 'utf-8');
    await writeFile(configFile, '{ "broken":', 'utf-8');
    await writeFile(backupFile, validConfig, 'utf-8');
    await writeApplyPending(paths.home, {
      attempt: 3,
      at: new Date().toISOString(),
      fields: ['mcp.http.port'],
      attempts: 1,
      rollingBack: true,
      reason: '新实例未健康',
    });

    const run = spawnSync(process.execPath, ['--input-type=module', '-e', HARNESS], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 60000,
    });
    expect(run.status).toBe(0);
    const output = JSON.parse(run.stdout.trim().split('\n').at(-1));
    expect(output.lastApply).toMatchObject({ status: 'rolled-back', restored: true, recovered: true, attempt: 3 });

    expect(await readFile(configFile, 'utf-8')).toBe(validConfig);
    expect(await readApplyPending(paths.home)).toBeNull();
    expect(await readApplyResult(paths.home)).toMatchObject({ status: 'rolled-back', restored: true, attempt: 3 });
  }, 90000);
});
